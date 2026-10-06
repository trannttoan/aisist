import { LangGraphRunnableConfig } from '@langchain/langgraph';

import { normalizeTimezone } from '../prompt.js';
import { AisistAuthError } from './auth.js';

export function getAccessToken(config: LangGraphRunnableConfig): string {
  const configurable = config.configurable as
    | Record<string, unknown>
    | undefined;
  const accessToken = configurable?.access_token;

  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new AisistAuthError(
      'AUTH_MISSING_ACCESS_TOKEN',
      'Missing Google access token in run config.',
      {
        retryable: false,
        status: 401,
      },
    );
  }

  return accessToken.trim();
}

export function getTimezone(config: LangGraphRunnableConfig): string {
  const configurable = config.configurable as
    | Record<string, unknown>
    | undefined;

  return normalizeTimezone(
    typeof configurable?.timezone === 'string'
      ? configurable.timezone
      : undefined,
  );
}
