"use client";

/**
 * WalletContext — persistent wallet session management for FlowFi.
 *
 * Three network concepts flow through this context:
 *
 *  APP NETWORK          The network selected in NetworkSelector, stored in
 *                       localStorage as "flowfi.network". Read via useNetwork().
 *
 *  WALLET NETWORK       The network Freighter is currently connected to.
 *                       Reported in session.network after connect().
 *
 *  CONTRACT DEPLOYMENT  Determined by NEXT_PUBLIC_STREAM_CONTRACT_ID and the
 *  NETWORK              APP NETWORK. Read from NetworkConfig.contractId.
 *
 * Before any sign/submit operation callers MUST call assertWalletOnAppNetwork()
 * (or check isWalletOnAppNetwork()) to confirm WALLET NETWORK matches APP
 * NETWORK. Do not use the legacy isExpectedNetwork() helper — it compares
 * against the hardcoded env var, not the user's dynamic network choice.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import {
  connectWallet,
  toWalletErrorMessage,
  authenticateWallet,
  isWalletOnNetwork,
  type WalletSession,
  SUPPORTED_WALLETS,
  type WalletDefinition,
} from "@/lib/wallet";
import { useNetwork } from "@/context/NetworkContext";
import type { NetworkConfig } from "@/lib/stellar-config";
import {
  fetchOrganizationMembership,
  type OrganizationMembership,
} from "@/lib/organization";

// ── Storage keys ──────────────────────────────────────────────────────────────

const SESSION_KEY = "flowfi.wallet.session.v1";
const AUTH_KEY = "flowfi.wallet.auth.v1";

// ── State machine ─────────────────────────────────────────────────────────────

export type WalletStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Recovery state — a derived, user-facing classification of the current
 * wallet situation. Used by the recovery journey UI to explain what the user
 * can do next. It NEVER implies that FlowFi can recover a private key.
 *
 *  "connected"          Wallet is connected and authenticated.
 *  "disconnected"       No wallet session (fresh, or after disconnect).
 *  "wrong-account"      A wallet is connected but its public key does not
 *                       match the account the user expects (e.g. they
 *                       switched accounts inside the extension).
 *  "revoked-session"    A session exists but the auth token is missing or
 *                       expired — the backend will reject signed requests.
 *  "unavailable-wallet" The wallet extension is not installed/available, or
 *                       the last connection attempt failed.
 */
export type WalletRecoveryState =
  | "connected"
  | "disconnected"
  | "wrong-account"
  | "revoked-session"
  | "unavailable-wallet";

interface WalletState {
  status: WalletStatus;
  session: WalletSession | null;
  authToken: string | null;
  errorMessage: string | null;
  isHydrated: boolean;
  /** Organization membership for the authenticated user, or null. */
  organization: OrganizationMembership | null;
  /** True while the organization membership is being loaded. */
  isOrganizationLoading: boolean;
  /** Error message from the last organization load, or null. */
  organizationError: string | null;
}

type WalletAction =
  | { type: "hydrate:success"; session: WalletSession; authToken: string | null }
  | { type: "hydrate:idle" }
  | { type: "connect:start" }
  | { type: "connect:success"; session: WalletSession; authToken: string }
  | { type: "connect:error"; message: string }
  | { type: "organization:start" }
  | { type: "organization:success"; organization: OrganizationMembership | null }
  | { type: "organization:error"; message: string }
  | { type: "disconnect" };

function reducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "hydrate:success":
      return {
        ...state,
        status: "connected",
        session: action.session,
        authToken: action.authToken,
        isHydrated: true,
      };
    case "hydrate:idle":
      return { ...state, status: "idle", isHydrated: true };
    case "connect:start":
      return { ...state, status: "connecting", errorMessage: null };
    case "connect:success":
      return {
        ...state,
        status: "connected",
        session: action.session,
        authToken: action.authToken,
        errorMessage: null,
        expectedPublicKey: action.session.publicKey,
        walletUnavailable: false,
      };
    case "connect:error":
      return {
        ...state,
        status: "error",
        session: null,
        authToken: null,
        errorMessage: action.message,
        organization: null,
        isOrganizationLoading: false,
        organizationError: null,
      };
    case "organization:start":
      return {
        ...state,
        isOrganizationLoading: true,
        organizationError: null,
      };
    case "organization:success":
      return {
        ...state,
        organization: action.organization,
        isOrganizationLoading: false,
        organizationError: null,
      };
    case "organization:error":
      return {
        ...state,
        organization: null,
        isOrganizationLoading: false,
        organizationError: action.message,
      };
    case "disconnect":
      return {
        ...state,
        status: "idle",
        session: null,
        authToken: null,
        errorMessage: null,
        organization: null,
        isOrganizationLoading: false,
        organizationError: null,
      };
    default:
      return state;
  }
}

const initialState: WalletState = {
  status: "idle",
  session: null,
  authToken: null,
  errorMessage: null,
  isHydrated: false,
  organization: null,
  isOrganizationLoading: false,
  organizationError: null,
};

// ── Recovery messaging ────────────────────────────────────────────────────────

/**
 * Copy shown in the recovery journey. Every message is explicit that FlowFi
 * cannot recover a private key and that address-bound records stay tied to
 * the original public key.
 */
export const RECOVERY_MESSAGES = {
  disconnected:
    "No wallet is connected. Reconnect the same wallet to regain access. " +
    "FlowFi cannot recover a private key — only your wallet provider holds it.",
  wrongAccount:
    "The connected wallet account does not match the account this session was " +
    "created for. Switch back to the original account in your wallet, or replace " +
    "the wallet. Records bound to the original address stay tied to that public " +
    "key and cannot be moved by connecting a different account.",
  revokedSession:
    "Your session has expired or been revoked. Reconnect and sign the " +
    "authentication challenge again. FlowFi cannot recover a private key.",
  unavailableWallet:
    "The wallet extension is not available. Install or unlock it, then reconnect. " +
    "FlowFi cannot recover a private key.",
} as const;

/** Heuristic: does this error indicate the wallet extension is unavailable? */
function isWalletUnavailableError(err: unknown): boolean {
  const message = toWalletErrorMessage(err).toLowerCase();
  return (
    message.includes("not installed") ||
    message.includes("not available") ||
    message.includes("not detected") ||
    message.includes("no wallet") ||
    message.includes("extension")
  );
}

// ── Auth token helpers ────────────────────────────────────────────────────────

/** Decode the `exp` claim from a JWT without a full JWT library. */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function isTokenValid(token: string): boolean {
  const exp = getTokenExpiry(token);
  if (exp === null) return false;
  // Treat tokens expiring in less than 60 s as expired.
  return exp > Math.floor(Date.now() / 1000) + 60;
}

// ── Session validation ────────────────────────────────────────────────────────

function isValidSession(value: unknown): value is WalletSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s["walletId"] === "string" &&
    typeof s["walletName"] === "string" &&
    typeof s["publicKey"] === "string" &&
    typeof s["connectedAt"] === "string" &&
    typeof s["network"] === "string" &&
    s["mocked"] === false // never restore mocked sessions
  );
}

// ── Context value ─────────────────────────────────────────────────────────────

export interface WalletContextValue {
  /** Current wallet connection state. */
  status: WalletStatus;
  /** Active session, or null when not connected. */
  session: WalletSession | null;
  /** JWT auth token for backend calls, or null when not authenticated. */
  authToken: string | null;
  /** Last connection error message, or null. */
  errorMessage: string | null;
  /** True once the initial localStorage hydration is complete. */
  isHydrated: boolean;
  /** Supported wallet definitions. */
  supportedWallets: WalletDefinition[];
  /** Organization membership for the authenticated user, or null. */
  organization: OrganizationMembership | null;
  /** True while the organization membership is being loaded. */
  isOrganizationLoading: boolean;
  /** Error message from the last organization load, or null. */
  organizationError: string | null;
  /**
   * Returns true when the connected wallet is the acting member's wallet and
   * therefore authorized to sign on its own behalf.
   *
   * Always false when not connected, when no organization membership is
   * loaded, or when `walletAddress` differs from the connected public key.
   * Signing paths MUST gate on this helper — a member can never sign for
   * another wallet.
   */
  canSignForWallet: (walletAddress: string) => boolean;
  /**
   * Derived recovery classification of the current wallet situation.
   * Drives the recovery journey UI. Never implies private-key recovery.
   */
  recoveryState: WalletRecoveryState;
  /**
   * Human-readable guidance for the current recoveryState. Always states that
   * FlowFi cannot recover a private key and that address-bound records remain
   * tied to the original public key.
   */
  recoveryMessage: string;
  /**
   * Connect a wallet by ID (e.g. "freighter").
   * Calls connectWallet() → authenticateWallet() and persists the session.
   */
  connect: (walletId: string) => Promise<void>;
  /**
   * Re-run connect() for the currently selected wallet. Used by the recovery
   * journey to retry a disconnected, revoked, or unavailable wallet.
   */
  reconnect: () => Promise<void>;
  /**
   * Disconnect the current wallet and open the wallet modal so the user can
   * pick a different wallet. Address-bound records stay tied to the original
   * public key — this does not migrate them.
   */
  replaceWallet: () => void;
  /**
   * Disconnect: clears session, authToken, and localStorage entries.
   */
  disconnect: () => void;
  /**
   * Returns true when session.network matches the current APP NETWORK
   * (i.e. the network the user chose in NetworkSelector).
   *
   * Always false when not connected.
   */
  isWalletOnAppNetwork: () => boolean;
  /**
   * Throws a user-friendly Error when the wallet is not on the APP NETWORK.
   * Call this at the top of any sign/submit handler.
   */
  assertWalletOnAppNetwork: (appNetwork: NetworkConfig) => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { network: appNetwork } = useNetwork();
  // Wallet the user last selected; used by reconnect()/replaceWallet().
  const [selectedWalletId, setSelectedWalletId] = React.useState<string | null>(null);
  // Set by replaceWallet() to signal the wallet modal should open.
  const [walletModalRequested, setWalletModalRequested] = React.useState(false);

  // Hydrate from localStorage on first render.
  useEffect(() => {
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      if (!rawSession) {
        dispatch({ type: "hydrate:idle" });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawSession);
      } catch {
        // Malformed JSON — discard silently.
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(AUTH_KEY);
        dispatch({ type: "hydrate:idle" });
        return;
      }

      if (!isValidSession(parsed)) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(AUTH_KEY);
        dispatch({ type: "hydrate:idle" });
        return;
      }

      // Restore auth token if present and still valid.
      let authToken: string | null = null;
      try {
        const rawAuth = localStorage.getItem(AUTH_KEY);
        if (rawAuth) {
          const auth = JSON.parse(rawAuth) as { publicKey?: string; token?: string };
          if (
            auth.publicKey === parsed.publicKey &&
            typeof auth.token === "string" &&
            isTokenValid(auth.token)
          ) {
            authToken = auth.token;
          }
        }
      } catch {
        // Malformed auth entry — ignore, proceed without token.
        localStorage.removeItem(AUTH_KEY);
      }

      dispatch({ type: "hydrate:success", session: parsed, authToken });
    } catch {
      dispatch({ type: "hydrate:idle" });
    }
  }, []);

  const connect = useCallback(async (walletId: string) => {
    setSelectedWalletId(walletId);
    dispatch({ type: "connect:start" });
    try {
      const session = await connectWallet(walletId);
      const token = await authenticateWallet(session.publicKey, walletId);

      // Persist session and auth token.
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.setItem(AUTH_KEY, JSON.stringify({ publicKey: session.publicKey, token }));

      dispatch({ type: "connect:success", session, authToken: token });
    } catch (err) {
      // Clear any stale persisted session on failure.
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(AUTH_KEY);
      dispatch({
        type: "connect:error",
        message: toWalletErrorMessage(err),
        walletUnavailable: isWalletUnavailableError(err),
      });
    }
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(AUTH_KEY);
    dispatch({ type: "disconnect" });
  }, []);

  // Load organization membership once authenticated.
  useEffect(() => {
    if (state.status !== "connected" || !state.session || !state.authToken) {
      return;
    }

    let cancelled = false;
    dispatch({ type: "organization:start" });

    fetchOrganizationMembership(state.authToken)
      .then((membership) => {
        if (cancelled) return;
        dispatch({ type: "organization:success", organization: membership });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Failed to load organization membership.";
        dispatch({ type: "organization:error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [state.status, state.session, state.authToken]);

  /**
   * Ownership check: only the connected wallet may sign on its own behalf.
   * Never returns true for a wallet address that differs from the session.
   */
  const canSignForWallet = useCallback(
    (walletAddress: string): boolean => {
      if (!state.session) return false;
      if (!state.organization) return false;
      if (typeof walletAddress !== "string" || walletAddress.length === 0) return false;
      return walletAddress === state.session.publicKey;
    },
    [state.session, state.organization],
  );

  /**
   * Returns true when the connected wallet's network matches the APP NETWORK.
   * Uses isWalletOnNetwork() which compares by passphrase first, display name
   * second — covers both the short name ("Testnet") and the full passphrase
   * ("Test SDF Network ; September 2015") that Freighter may return.
   */
  const isWalletOnAppNetwork = useCallback((): boolean => {
    if (!state.session) return false;
    return isWalletOnNetwork(state.session.network, appNetwork);
  }, [state.session, appNetwork]);

  const assertWalletOnAppNetwork = useCallback(
    (currentAppNetwork: NetworkConfig) => {
      if (!state.session) {
        throw new Error("No wallet connected. Please connect your wallet first.");
      }
      if (!isWalletOnNetwork(state.session.network, currentAppNetwork)) {
        throw new Error(
          `Your wallet is connected to ${state.session.network} but the app is set to ` +
            `${currentAppNetwork.name}. Switch your Freighter network to ` +
            `${currentAppNetwork.name} before signing.`,
        );
      }
    },
    [state.session],
  );

  /**
   * Derive the recovery state from the current status/session/authToken.
   * Order matters: a connected session with a mismatched public key is
   * "wrong-account"; a connected session without a valid token is
   * "revoked-session"; a failed connect is "unavailable-wallet".
   */
  const recoveryState = useMemo<WalletRecoveryState>(() => {
    if (state.status === "connected" && state.session) {
      if (state.expectedPublicKey && state.session.publicKey !== state.expectedPublicKey) {
        return "wrong-account";
      }
      if (!state.authToken || !isTokenValid(state.authToken)) {
        return "revoked-session";
      }
      return "connected";
    }
    if (state.status === "error") {
      return state.walletUnavailable ? "unavailable-wallet" : "disconnected";
    }
    return "disconnected";
  }, [state.status, state.session, state.authToken, state.expectedPublicKey, state.walletUnavailable]);

  const recoveryMessage = useMemo<string>(() => {
    switch (recoveryState) {
      case "connected":
        return "";
      case "wrong-account":
        return RECOVERY_MESSAGES.wrongAccount;
      case "revoked-session":
        return RECOVERY_MESSAGES.revokedSession;
      case "unavailable-wallet":
        return RECOVERY_MESSAGES.unavailableWallet;
      case "disconnected":
      default:
        return RECOVERY_MESSAGES.disconnected;
    }
  }, [recoveryState]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status: state.status,
      session: state.session,
      authToken: state.authToken,
      errorMessage: state.errorMessage,
      isHydrated: state.isHydrated,
      supportedWallets: SUPPORTED_WALLETS,
      organization: state.organization,
      isOrganizationLoading: state.isOrganizationLoading,
      organizationError: state.organizationError,
      canSignForWallet,
      connect,
      reconnect,
      replaceWallet,
      disconnect,
      isWalletOnAppNetwork,
      assertWalletOnAppNetwork,
    }),
    [
      state.status,
      state.session,
      state.authToken,
      state.errorMessage,
      state.isHydrated,
      state.organization,
      state.isOrganizationLoading,
      state.organizationError,
      canSignForWallet,
      connect,
      reconnect,
      replaceWallet,
      disconnect,
      isWalletOnAppNetwork,
      assertWalletOnAppNetwork,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Access the wallet context.
 * Must be used inside a <WalletProvider> tree.
 */
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within WalletProvider.");
  }
  return ctx;
}
