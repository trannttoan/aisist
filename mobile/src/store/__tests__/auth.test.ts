import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/auth', () => ({
  GOOGLE_SCOPES: [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  getGoogleIosClientId: jest.fn(() => 'ios-client-id'),
  isForceReauthError: jest.fn(
    (error: unknown) => (error as { code?: string })?.code === 'force',
  ),
  isRefreshTimeoutError: jest.fn(
    (error: unknown) =>
      (error as { code?: string })?.code === 'refresh_timeout',
  ),
  refreshGoogleAccessToken: jest.fn(),
}));

type LoadedAuthModule = {
  authStore: typeof import('../auth');
  authUtils: typeof import('../../utils/auth');
  secureStore: typeof import('expo-secure-store');
};

const baseSession = {
  accessToken: 'initial-access-token',
  email: 'person@example.com',
  expiryAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  refreshToken: 'initial-refresh-token',
  scopes: [
    'https://www.googleapis.com/auth/calendar.events.owned',
    'openid',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
};

async function loadAuthModule(): Promise<LoadedAuthModule> {
  jest.resetModules();

  return {
    authStore: require('../auth') as typeof import('../auth'),
    authUtils: require('../../utils/auth') as typeof import('../../utils/auth'),
    secureStore:
      require('expo-secure-store') as typeof import('expo-secure-store'),
  };
}

describe('useAuthStore', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes the token when it expires within five minutes', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );

    refreshGoogleAccessToken.mockResolvedValue({
      accessToken: 'fresh-access-token',
      expiryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'fresh-refresh-token',
    });

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    });

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).resolves.toBe('fresh-access-token');
    expect(refreshGoogleAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshGoogleAccessToken).toHaveBeenCalledWith({
      clientId: 'ios-client-id',
      refreshToken: 'initial-refresh-token',
    });
    expect(authStore.useAuthStore.getState()).toMatchObject({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      status: 'signed_in',
    });
  });

  it('refresh preserves the granted scopes rather than the required list', async () => {
    const { authStore, authUtils, secureStore } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );
    const setItemAsync = jest.mocked(secureStore.setItemAsync);
    const grantedScopes = baseSession.scopes.filter(
      (scope) => scope !== 'https://www.googleapis.com/auth/gmail.modify',
    );

    refreshGoogleAccessToken.mockResolvedValue({
      accessToken: 'fresh-access-token',
      expiryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'fresh-refresh-token',
    });

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: grantedScopes,
    });
    setItemAsync.mockClear();

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).resolves.toBe('fresh-access-token');

    expect(setItemAsync.mock.calls).toContainEqual([
      'auth_granted_scopes',
      JSON.stringify([...grantedScopes].sort()),
      expect.anything(),
    ]);
  });

  it('refresh after initialize persists the scopes loaded from storage', async () => {
    const { authStore, authUtils, secureStore } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );
    const getItemAsync = jest.mocked(secureStore.getItemAsync);
    const setItemAsync = jest.mocked(secureStore.setItemAsync);
    const storedScopes = [
      ...baseSession.scopes,
      'https://www.googleapis.com/auth/contacts.readonly',
    ];

    getItemAsync.mockImplementation((key: string) => {
      const stored: Record<string, string> = {
        auth_access_token: 'stored-access',
        auth_refresh_token: 'stored-refresh',
        auth_token_expiry: new Date(Date.now() + 60_000).toISOString(),
        auth_user_email: 'stored@example.com',
        auth_granted_scopes: JSON.stringify(storedScopes),
      };

      return Promise.resolve(stored[key] ?? null);
    });
    refreshGoogleAccessToken.mockResolvedValue({
      accessToken: 'fresh-access-token',
      expiryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'fresh-refresh-token',
    });

    await authStore.useAuthStore.getState().initialize();

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).resolves.toBe('fresh-access-token');

    expect(setItemAsync.mock.calls).toContainEqual([
      'auth_granted_scopes',
      JSON.stringify([...storedScopes].sort()),
      expect.anything(),
    ]);
  });

  it('deduplicates concurrent refreshes behind a shared mutex', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );
    let resolveRefresh:
      | ((value: {
          accessToken: string;
          expiryAt: string;
          refreshToken: string;
        }) => void)
      | null = null;

    refreshGoogleAccessToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const firstRefresh = authStore.useAuthStore.getState().getValidToken();
    const secondRefresh = authStore.useAuthStore.getState().getValidToken();

    expect(refreshGoogleAccessToken).toHaveBeenCalledTimes(1);

    resolveRefresh?.({
      accessToken: 'shared-access-token',
      expiryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'shared-refresh-token',
    });

    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      'shared-access-token',
      'shared-access-token',
    ]);
  });

  it('signs out by clearing secure storage and resetting chat state', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const resetChatState = jest.fn();

    authStore.__setLoadChatStoreModuleForTest(async () => ({ resetChatState }));

    await authStore.useAuthStore.getState().signIn(baseSession);
    await authStore.useAuthStore.getState().signOut('Session expired.');

    expect(jest.mocked(secureStore.deleteItemAsync)).toHaveBeenCalledTimes(5);
    expect(resetChatState).toHaveBeenCalledTimes(1);
    expect(authStore.useAuthStore.getState()).toMatchObject({
      accessToken: null,
      email: null,
      errorMessage: 'Session expired.',
      refreshToken: null,
      status: 'signed_out',
    });
    authStore.__setLoadChatStoreModuleForTest(null);
  });

  it('returns the current token without refreshing when it is still valid', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );

    await authStore.useAuthStore.getState().signIn(baseSession);

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).resolves.toBe('initial-access-token');
    expect(refreshGoogleAccessToken).not.toHaveBeenCalled();
  });

  it('throws when getValidToken is called while signed out', async () => {
    const { authStore } = await loadAuthModule();

    authStore.useAuthStore.setState({ status: 'signed_out' });

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).rejects.toThrow('User is not authenticated.');
  });

  it('signs out when refresh fails with a force-reauth error', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );
    const resetChatState = jest.fn();

    authStore.__setLoadChatStoreModuleForTest(async () => ({ resetChatState }));

    refreshGoogleAccessToken.mockRejectedValue({
      code: 'force',
      message: 'Reauth required',
    });

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).rejects.toBeDefined();

    expect(authStore.useAuthStore.getState().status).toBe('signed_out');
    expect(resetChatState).toHaveBeenCalledTimes(1);

    authStore.__setLoadChatStoreModuleForTest(null);
  });

  it('sets errorMessage without signing out on a non-fatal refresh error', async () => {
    const { authStore, authUtils } = await loadAuthModule();
    const refreshGoogleAccessToken = jest.mocked(
      authUtils.refreshGoogleAccessToken,
    );

    refreshGoogleAccessToken.mockRejectedValue(new Error('Network error'));

    await authStore.useAuthStore.getState().signIn({
      ...baseSession,
      expiryAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      authStore.useAuthStore.getState().getValidToken(),
    ).rejects.toThrow('Network error');

    expect(authStore.useAuthStore.getState().status).toBe('signed_in');
    expect(authStore.useAuthStore.getState().errorMessage).toBe(
      'Network error',
    );
  });

  it('clears errorMessage via clearError', async () => {
    const { authStore } = await loadAuthModule();

    await authStore.useAuthStore.getState().signIn(baseSession);

    authStore.useAuthStore.setState({ errorMessage: 'stale error' });
    authStore.useAuthStore.getState().clearError();

    expect(authStore.useAuthStore.getState().errorMessage).toBeNull();
  });

  it('initializes from secure storage when a full session is stored', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const getItemAsync = jest.mocked(secureStore.getItemAsync);

    getItemAsync.mockImplementation((key: string) => {
      const stored: Record<string, string> = {
        auth_access_token: 'stored-access',
        auth_refresh_token: 'stored-refresh',
        auth_token_expiry: '2099-01-01T00:00:00.000Z',
        auth_user_email: 'stored@example.com',
        auth_granted_scopes: JSON.stringify(baseSession.scopes),
      };

      return Promise.resolve(stored[key] ?? null);
    });

    await authStore.useAuthStore.getState().initialize();

    expect(authStore.useAuthStore.getState()).toMatchObject({
      accessToken: 'stored-access',
      email: 'stored@example.com',
      refreshToken: 'stored-refresh',
      status: 'signed_in',
    });
  });

  it('signs out during initialize when stored scopes are missing the calendar scope', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const getItemAsync = jest.mocked(secureStore.getItemAsync);
    const deleteItemAsync = jest.mocked(secureStore.deleteItemAsync);
    const resetChatState = jest.fn();

    authStore.__setLoadChatStoreModuleForTest(async () => ({ resetChatState }));

    getItemAsync.mockImplementation((key: string) => {
      const stored: Record<string, string> = {
        auth_access_token: 'stored-access',
        auth_refresh_token: 'stored-refresh',
        auth_token_expiry: '2099-01-01T00:00:00.000Z',
        auth_user_email: 'stored@example.com',
        auth_granted_scopes: JSON.stringify([
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
        ]),
      };

      return Promise.resolve(stored[key] ?? null);
    });

    await authStore.useAuthStore.getState().initialize();

    expect(deleteItemAsync).toHaveBeenCalledTimes(5);
    expect(resetChatState).toHaveBeenCalledTimes(1);
    expect(authStore.useAuthStore.getState()).toMatchObject({
      errorMessage:
        'Aisist now needs calendar, tasks, and Gmail access. Please sign in again.',
      status: 'signed_out',
    });

    authStore.__setLoadChatStoreModuleForTest(null);
  });

  it('signs out during initialize when stored scopes are missing the tasks scope', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const getItemAsync = jest.mocked(secureStore.getItemAsync);
    const deleteItemAsync = jest.mocked(secureStore.deleteItemAsync);
    const resetChatState = jest.fn();

    authStore.__setLoadChatStoreModuleForTest(async () => ({ resetChatState }));

    getItemAsync.mockImplementation((key: string) => {
      const stored: Record<string, string> = {
        auth_access_token: 'stored-access',
        auth_refresh_token: 'stored-refresh',
        auth_token_expiry: '2099-01-01T00:00:00.000Z',
        auth_user_email: 'stored@example.com',
        auth_granted_scopes: JSON.stringify([
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/calendar.events.owned',
        ]),
      };

      return Promise.resolve(stored[key] ?? null);
    });

    await authStore.useAuthStore.getState().initialize();

    expect(deleteItemAsync).toHaveBeenCalledTimes(5);
    expect(resetChatState).toHaveBeenCalledTimes(1);
    expect(authStore.useAuthStore.getState()).toMatchObject({
      errorMessage:
        'Aisist now needs calendar, tasks, and Gmail access. Please sign in again.',
      status: 'signed_out',
    });

    authStore.__setLoadChatStoreModuleForTest(null);
  });

  it('signs out during initialize when stored scopes are missing the gmail scope', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const getItemAsync = jest.mocked(secureStore.getItemAsync);
    const deleteItemAsync = jest.mocked(secureStore.deleteItemAsync);
    const resetChatState = jest.fn();

    authStore.__setLoadChatStoreModuleForTest(async () => ({ resetChatState }));

    getItemAsync.mockImplementation((key: string) => {
      const stored: Record<string, string> = {
        auth_access_token: 'stored-access',
        auth_refresh_token: 'stored-refresh',
        auth_token_expiry: '2099-01-01T00:00:00.000Z',
        auth_user_email: 'stored@example.com',
        auth_granted_scopes: JSON.stringify([
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/calendar.events.owned',
          'https://www.googleapis.com/auth/tasks',
        ]),
      };

      return Promise.resolve(stored[key] ?? null);
    });

    await authStore.useAuthStore.getState().initialize();

    expect(deleteItemAsync).toHaveBeenCalledTimes(5);
    expect(resetChatState).toHaveBeenCalledTimes(1);
    expect(authStore.useAuthStore.getState()).toMatchObject({
      errorMessage:
        'Aisist now needs calendar, tasks, and Gmail access. Please sign in again.',
      status: 'signed_out',
    });

    authStore.__setLoadChatStoreModuleForTest(null);
  });

  it('clears partial session data during initialize and stays signed out', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const getItemAsync = jest.mocked(secureStore.getItemAsync);
    const deleteItemAsync = jest.mocked(secureStore.deleteItemAsync);

    getItemAsync.mockImplementation((key: string) => {
      if (key === 'auth_access_token') return Promise.resolve('orphaned-token');
      return Promise.resolve(null);
    });

    await authStore.useAuthStore.getState().initialize();

    expect(deleteItemAsync).toHaveBeenCalledTimes(5);
    expect(authStore.useAuthStore.getState().status).toBe('signed_out');
  });

  it('persists session to secure storage on sign-in', async () => {
    const { authStore, secureStore } = await loadAuthModule();
    const setItemAsync = jest.mocked(secureStore.setItemAsync);

    await authStore.useAuthStore.getState().signIn(baseSession);

    expect(setItemAsync).toHaveBeenCalledTimes(5);
    expect(setItemAsync).toHaveBeenCalledWith(
      'auth_access_token',
      'initial-access-token',
      expect.anything(),
    );
    expect(setItemAsync).toHaveBeenCalledWith(
      'auth_user_email',
      'person@example.com',
      expect.anything(),
    );
    expect(setItemAsync.mock.calls).toContainEqual([
      'auth_granted_scopes',
      JSON.stringify([...baseSession.scopes].sort()),
      expect.anything(),
    ]);
  });
});
