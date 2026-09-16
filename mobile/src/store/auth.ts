import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import {
  getGoogleIosClientId,
  GOOGLE_SCOPES,
  isForceReauthError,
  isRefreshTimeoutError,
  refreshGoogleAccessToken,
  type AuthSessionData,
} from '../utils/auth';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const STORAGE_KEYS = {
  accessToken: 'auth_access_token',
  email: 'auth_user_email',
  expiryAt: 'auth_token_expiry',
  refreshToken: 'auth_refresh_token',
  scopes: 'auth_granted_scopes',
} as const;

const STORAGE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
} as const;

const SCOPE_MISMATCH_MESSAGE =
  'Aisist now needs calendar, tasks, and Gmail access. Please sign in again.';

type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

type AuthState = {
  accessToken: string | null;
  clearError: () => void;
  email: string | null;
  errorMessage: string | null;
  expiryAt: string | null;
  getValidToken: () => Promise<string>;
  initialize: () => Promise<void>;
  refreshToken: string | null;
  scopes: string[];
  signIn: (session: AuthSessionData) => Promise<void>;
  signOut: (reason?: string | null) => Promise<void>;
  status: AuthStatus;
};

type ChatStoreModule = {
  resetChatState: () => void;
};

const signedOutState = {
  accessToken: null,
  email: null,
  errorMessage: null,
  expiryAt: null,
  refreshToken: null,
  scopes: [],
  status: 'signed_out' as const,
};

let refreshPromise: Promise<string> | null = null;
let loadChatStoreModule: () => Promise<ChatStoreModule> = () =>
  import('./chat');

export const useAuthStore = create<AuthState>((set, get) => ({
  ...signedOutState,
  status: 'loading',
  clearError: () => {
    set({ errorMessage: null });
  },
  getValidToken: async () => {
    const currentState = get();

    if (
      currentState.status !== 'signed_in' ||
      !currentState.accessToken ||
      !currentState.refreshToken ||
      !currentState.expiryAt
    ) {
      throw new Error('User is not authenticated.');
    }

    if (!shouldRefresh(currentState.expiryAt)) {
      return currentState.accessToken;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      const latestState = get();

      if (
        latestState.status !== 'signed_in' ||
        !latestState.accessToken ||
        !latestState.refreshToken ||
        !latestState.expiryAt ||
        !latestState.email
      ) {
        throw new Error('User is not authenticated.');
      }

      if (!shouldRefresh(latestState.expiryAt)) {
        return latestState.accessToken;
      }

      const clientId = getGoogleIosClientId();

      if (!clientId) {
        throw new Error('Missing EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.');
      }

      // signOut or a new signIn can run while the refresh is in flight; the
      // result then belongs to a session the user already ended.
      const isSessionStale = () =>
        get().status !== 'signed_in' ||
        get().refreshToken !== latestState.refreshToken;

      try {
        const refreshedTokens = await refreshWithRetry({
          clientId,
          refreshToken: latestState.refreshToken,
        });

        if (isSessionStale()) {
          throw new Error('User is not authenticated.');
        }

        const nextSession: AuthSessionData = {
          accessToken: refreshedTokens.accessToken,
          email: latestState.email,
          expiryAt: refreshedTokens.expiryAt,
          refreshToken: refreshedTokens.refreshToken,
          scopes: latestState.scopes,
        };

        await persistSession(nextSession);

        set({
          accessToken: nextSession.accessToken,
          email: nextSession.email,
          errorMessage: null,
          expiryAt: nextSession.expiryAt,
          refreshToken: nextSession.refreshToken,
          scopes: nextSession.scopes,
          status: 'signed_in',
        });

        return nextSession.accessToken;
      } catch (error) {
        if (isSessionStale()) {
          throw error;
        }

        const message =
          error instanceof Error
            ? error.message
            : 'Unable to refresh your Google session.';

        if (isForceReauthError(error) || isRefreshTimeoutError(error)) {
          await get().signOut(message);
        } else {
          set({ errorMessage: message });
        }

        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  },
  initialize: async () => {
    const storedSession = await loadStoredSession();

    if (!storedSession) {
      set({ ...signedOutState, status: 'signed_out' });
      return;
    }

    if (!hasRequiredScopes(storedSession.scopes)) {
      await get().signOut(SCOPE_MISMATCH_MESSAGE);
      return;
    }

    set({
      accessToken: storedSession.accessToken,
      email: storedSession.email,
      errorMessage: null,
      expiryAt: storedSession.expiryAt,
      refreshToken: storedSession.refreshToken,
      scopes: storedSession.scopes,
      status: 'signed_in',
    });
  },
  refreshToken: null,
  signIn: async (session) => {
    refreshPromise = null;
    await persistSession(session);

    set({
      accessToken: session.accessToken,
      email: session.email,
      errorMessage: null,
      expiryAt: session.expiryAt,
      refreshToken: session.refreshToken,
      scopes: session.scopes,
      status: 'signed_in',
    });
  },
  signOut: async (reason = null) => {
    refreshPromise = null;
    await clearStoredSession();
    const { resetChatState } = await loadChatStoreModule();
    resetChatState();

    set({
      ...signedOutState,
      errorMessage: reason,
      status: 'signed_out',
    });
  },
}));

export function __setLoadChatStoreModuleForTest(
  loader: (() => Promise<ChatStoreModule>) | null,
) {
  loadChatStoreModule = loader ?? (() => import('./chat'));
}

async function clearStoredSession() {
  await Promise.all([
    SecureStore.deleteItemAsync(STORAGE_KEYS.accessToken, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.refreshToken, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.expiryAt, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.email, STORAGE_OPTIONS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.scopes, STORAGE_OPTIONS),
  ]);
}

async function loadStoredSession(): Promise<AuthSessionData | null> {
  const [accessToken, refreshToken, expiryAt, email, scopes] =
    await Promise.all([
      SecureStore.getItemAsync(STORAGE_KEYS.accessToken, STORAGE_OPTIONS),
      SecureStore.getItemAsync(STORAGE_KEYS.refreshToken, STORAGE_OPTIONS),
      SecureStore.getItemAsync(STORAGE_KEYS.expiryAt, STORAGE_OPTIONS),
      SecureStore.getItemAsync(STORAGE_KEYS.email, STORAGE_OPTIONS),
      SecureStore.getItemAsync(STORAGE_KEYS.scopes, STORAGE_OPTIONS),
    ]);

  if (accessToken && refreshToken && expiryAt && email) {
    return {
      accessToken,
      email,
      expiryAt,
      refreshToken,
      scopes: parseStoredScopes(scopes),
    };
  }

  if (accessToken || refreshToken || expiryAt || email || scopes) {
    await clearStoredSession();
  }

  return null;
}

async function persistSession(session: AuthSessionData) {
  const scopes = normalizeScopes(session.scopes);

  await Promise.all([
    SecureStore.setItemAsync(
      STORAGE_KEYS.accessToken,
      session.accessToken,
      STORAGE_OPTIONS,
    ),
    SecureStore.setItemAsync(
      STORAGE_KEYS.refreshToken,
      session.refreshToken,
      STORAGE_OPTIONS,
    ),
    SecureStore.setItemAsync(
      STORAGE_KEYS.expiryAt,
      session.expiryAt,
      STORAGE_OPTIONS,
    ),
    SecureStore.setItemAsync(
      STORAGE_KEYS.email,
      session.email,
      STORAGE_OPTIONS,
    ),
    SecureStore.setItemAsync(
      STORAGE_KEYS.scopes,
      JSON.stringify(scopes),
      STORAGE_OPTIONS,
    ),
  ]);
}

function hasRequiredScopes(grantedScopes: string[]) {
  const grantedScopeSet = new Set(normalizeScopes(grantedScopes));

  return GOOGLE_SCOPES.every((scope) => grantedScopeSet.has(scope));
}

function normalizeScopes(scopes: string[]) {
  return Array.from(new Set(scopes)).sort();
}

function parseStoredScopes(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (
      !Array.isArray(parsed) ||
      !parsed.every((scope) => typeof scope === 'string')
    ) {
      return [];
    }

    return normalizeScopes(parsed);
  } catch {
    return [];
  }
}

async function refreshWithRetry(input: {
  clientId: string;
  refreshToken: string;
}) {
  try {
    return await refreshGoogleAccessToken(input);
  } catch (error) {
    if (!isRefreshTimeoutError(error)) {
      throw error;
    }

    return refreshGoogleAccessToken(input);
  }
}

function shouldRefresh(expiryAt: string): boolean {
  return new Date(expiryAt).getTime() - Date.now() <= REFRESH_BUFFER_MS;
}
