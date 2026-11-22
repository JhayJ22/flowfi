import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Network = 'testnet' | 'production';

export interface PartnerConfig {
  network: Network;
  apiBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  webhookUrl: string;
}

const REQUIRED_KEYS: Array<keyof PartnerConfig> = [
  'network',
  'apiBaseUrl',
  'apiKey',
  'apiSecret',
  'webhookSecret',
  'webhookUrl',
];

const TESTNET_HOST_MARKERS = ['testnet', 'sandbox', 'staging'];
const PRODUCTION_HOST_MARKERS = ['api.', 'prod'];

/**
 * Loads partner onboarding configuration from a JSON file.
 *
 * Partners must keep testnet and production credentials in separate files
 * (e.g. `partner.testnet.json` and `partner.production.json`). This helper
 * enforces that separation so a clean-environment validation cannot silently
 * run against the wrong network.
 */
export function loadPartnerConfig(path: string): PartnerConfig {
  if (!existsSync(path)) {
    throw new Error(`Partner config not found at ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Partner config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Partner config at ${path} must be a JSON object`);
  }

  const config = raw as Partial<PartnerConfig>;
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(`Partner config at ${path} is missing required keys: ${missing.join(', ')}`);
  }

  if (config.network !== 'testnet' && config.network !== 'production') {
    throw new Error(`Partner config at ${path} has invalid network "${config.network}" (expected testnet or production)`);
  }

  return config as PartnerConfig;
}

/**
 * Validates that the configured endpoint matches the declared network.
 * Prevents testnet credentials from being pointed at production endpoints
 * (and vice versa) during onboarding and go-live checks.
 */
export function assertNetworkMatchesEndpoint(config: PartnerConfig): void {
  const host = safeHost(config.apiBaseUrl);
  const lower = host.toLowerCase();

  if (config.network === 'testnet') {
    const looksProduction = PRODUCTION_HOST_MARKERS.some((marker) => lower.includes(marker));
    const looksTestnet = TESTNET_HOST_MARKERS.some((marker) => lower.includes(marker));
    if (looksProduction && !looksTestnet) {
      throw new Error(`Testnet config points at a production-looking endpoint: ${host}`);
    }
    return;
  }

  const looksTestnet = TESTNET_HOST_MARKERS.some((marker) => lower.includes(marker));
  if (looksTestnet) {
    throw new Error(`Production config points at a testnet-looking endpoint: ${host}`);
  }
}

/**
 * Ensures testnet and production configs never share secrets or endpoints.
 */
export function assertConfigsIsolated(testnet: PartnerConfig, production: PartnerConfig): void {
  if (testnet.network !== 'testnet' || production.network !== 'production') {
    throw new Error('assertConfigsIsolated expects a testnet config and a production config');
  }

  const shared: string[] = [];
  if (testnet.apiKey === production.apiKey) shared.push('apiKey');
  if (testnet.apiSecret === production.apiSecret) shared.push('apiSecret');
  if (testnet.webhookSecret === production.webhookSecret) shared.push('webhookSecret');
  if (testnet.apiBaseUrl === production.apiBaseUrl) shared.push('apiBaseUrl');

  if (shared.length > 0) {
    throw new Error(`Testnet and production configs must not share: ${shared.join(', ')}`);
  }
}

/**
 * Resolves the default config path for a network inside a given directory.
 */
export function defaultConfigPath(dir: string, network: Network): string {
  return join(dir, `partner.${network}.json`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`Invalid apiBaseUrl: ${url}`);
  }
}

/**
 * Deployment manifest describing a single contract/application release.
 * A manifest must be reviewed and machine-validated before a version is
 * promoted between testnet and production environments.
 */
export interface DeploymentManifest {
  /** Target network the release is promoted to (e.g. "testnet", "public"). */
  network: string;
  /** Stellar network passphrase the target network expects. */
  networkPassphrase: string;
  /** Deployed contract ID (C...) the release points at. */
  contractId: string;
  /** SHA-256 digest of the built artifact (wasm/binary). */
  artifactDigest: string;
  /** Schema version the release expects to be compatible with. */
  schemaVersion: number;
}

/**
 * Expected values a manifest is validated against. Supplied by the promotion
 * pipeline (target environment config) so mismatches are rejected up front.
 */
export interface ManifestExpectation {
  network: string;
  networkPassphrase: string;
  contractId: string;
  artifactDigest: string;
  /** Highest schema version the target environment can consume. */
  maxSchemaVersion: number;
}

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a deployment manifest against the target environment before
 * promotion. Checks network, contract ID, artifact digest, and schema
 * compatibility. Returns every failure so reviewers see the full picture.
 */
export function validateDeploymentManifest(
  manifest: DeploymentManifest,
  expected: ManifestExpectation,
): ManifestValidationResult {
  const errors: string[] = [];

  if (manifest.network !== expected.network) {
    errors.push(`network mismatch: manifest "${manifest.network}" != expected "${expected.network}"`);
  }

  if (manifest.networkPassphrase !== expected.networkPassphrase) {
    errors.push('network passphrase mismatch');
  }

  if (!CONTRACT_ID_PATTERN.test(manifest.contractId)) {
    errors.push(`invalid contract ID format: "${manifest.contractId}"`);
  } else if (manifest.contractId !== expected.contractId) {
    errors.push(`contract ID mismatch: manifest "${manifest.contractId}" != expected "${expected.contractId}"`);
  }

  if (!DIGEST_PATTERN.test(manifest.artifactDigest)) {
    errors.push(`invalid artifact digest format: "${manifest.artifactDigest}"`);
  } else if (manifest.artifactDigest !== expected.artifactDigest) {
    errors.push('artifact digest mismatch');
  }

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    errors.push(`invalid schema version: ${manifest.schemaVersion}`);
  } else if (manifest.schemaVersion > expected.maxSchemaVersion) {
    errors.push(
      `incompatible schema version: manifest ${manifest.schemaVersion} > supported ${expected.maxSchemaVersion}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Gate a promotion on a validated manifest. Throws with the aggregated
 * validation errors when the manifest is rejected so the pipeline halts
 * before any network change is applied.
 */
export function assertPromotionAllowed(
  manifest: DeploymentManifest,
  expected: ManifestExpectation,
): void {
  const result = validateDeploymentManifest(manifest, expected);
  if (!result.ok) {
    throw new Error(`deployment manifest rejected:\n- ${result.errors.join('\n- ')}`);
  }
}

/**
 * Known network passphrases keyed by the canonical network name used in the
 * deployment decision guide. Used to verify that the configured RPC endpoint,
 * contract id, and passphrase all belong to the same network before a run.
 */
export const KNOWN_NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  public: Networks.PUBLIC,
  standalone: Networks.STANDALONE,
};

/**
 * A contract id is a StrKey-encoded contract address: `C` followed by 55
 * base32 characters. Anything else is a misconfiguration, not a valid target.
 */
export function isValidContractId(contractId: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(contractId);
}

/**
 * Resolve the canonical network name from the configured passphrase.
 * Returns `undefined` when the passphrase does not match a known network,
 * which callers should treat as a hard configuration failure.
 */
export function resolveNetworkName(passphrase: string): string | undefined {
  return Object.keys(KNOWN_NETWORK_PASSPHRASES).find(
    (name) => KNOWN_NETWORK_PASSPHRASES[name] === passphrase,
  );
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

/**
 * Preflight check mirroring the deployment decision guide: verify that the
 * network passphrase is known, the RPC/Horizon endpoints are well-formed URLs,
 * and (when a contract is configured) that the contract id is valid. This
 * catches mismatched network/contract/endpoint combinations before a run
 * instead of failing mid-suite.
 */
export function preflight(
  config: {
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
    contractId: string;
  } = testnetConfig,
): PreflightResult {
  const errors: string[] = [];

  if (!resolveNetworkName(config.networkPassphrase)) {
    errors.push(
      `Unknown network passphrase: ${JSON.stringify(config.networkPassphrase)}. ` +
        'Expected one of testnet, futurenet, public, or standalone.',
    );
  }

  for (const [label, url] of [
    ['E2E_SOROBAN_RPC_URL', config.rpcUrl],
    ['E2E_HORIZON_URL', config.horizonUrl],
  ] as const) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        errors.push(`${label} must be an http(s) URL, got ${JSON.stringify(url)}.`);
      }
    } catch {
      errors.push(`${label} is not a valid URL: ${JSON.stringify(url)}.`);
    }
  }

  if (config.contractId.length > 0 && !isValidContractId(config.contractId)) {
    errors.push(
      `E2E_STREAM_CONTRACT_ID is not a valid contract id: ${JSON.stringify(config.contractId)}.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/** True when the local fixture is configured with a deployed contract id. */
export function hasLocalContract(): boolean {
  return localFixtureConfig.contractId.length > 0;
}

/**
 * Selects the active fixture config. Defaults to the public testnet config so
 * existing suites keep their behavior; set `E2E_FIXTURE=local` to run against
 * the deterministic local fixture instead.
 */
export function activeFixtureConfig() {
  return process.env.E2E_FIXTURE === 'local' ? localFixtureConfig : testnetConfig;
}
