import { BaseMessage, HumanMessage } from '@langchain/core/messages';

import { getMessageTimestamp } from './timestamp.js';

export const RETENTION_DAYS = 30;
export const MAX_RETAINED_MESSAGES = 2000;
export const MODEL_CONTEXT_GAP_MS = 4 * 60 * 60 * 1000;
export const MAX_MODEL_CONTEXT_MESSAGES = 60;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Gemini rejects a history that opens on a tool call or tool result, so a
// cut that lands mid-exchange has to move forward to the next human turn.
function startOnHumanTurn(messages: BaseMessage[]): BaseMessage[] {
  const firstHumanIndex = messages.findIndex((message) =>
    HumanMessage.isInstance(message),
  );

  return firstHumanIndex > 0 ? messages.slice(firstHumanIndex) : messages;
}

// Retention: what stays in thread state, and therefore what the app can show.
export function windowMessages(
  messages: BaseMessage[],
  {
    now = Date.now(),
    windowDays = RETENTION_DAYS,
    maxMessages = MAX_RETAINED_MESSAGES,
  }: {
    now?: number;
    windowDays?: number;
    maxMessages?: number;
  } = {},
): BaseMessage[] {
  const cutoff = now - windowDays * DAY_IN_MS;
  const windowedMessages = messages.filter((message) => {
    const timestamp = getMessageTimestamp(message);

    return timestamp !== null && timestamp >= cutoff;
  });

  const cappedMessages =
    windowedMessages.length > maxMessages
      ? windowedMessages.slice(-maxMessages)
      : windowedMessages;

  return startOnHumanTurn(cappedMessages);
}

// Model context: only the current sitting. A human turn that follows a long
// silence starts a new sitting; older tool results would read as current state.
export function selectModelContext(
  messages: BaseMessage[],
  {
    gapMs = MODEL_CONTEXT_GAP_MS,
    maxMessages = MAX_MODEL_CONTEXT_MESSAGES,
  }: {
    gapMs?: number;
    maxMessages?: number;
  } = {},
): BaseMessage[] {
  let sittingStart = 0;

  for (let index = 1; index < messages.length; index += 1) {
    if (!HumanMessage.isInstance(messages[index])) {
      continue;
    }

    const timestamp = getMessageTimestamp(messages[index]!);
    const previousTimestamp = getMessageTimestamp(messages[index - 1]!);

    if (
      timestamp !== null &&
      previousTimestamp !== null &&
      timestamp - previousTimestamp > gapMs
    ) {
      sittingStart = index;
    }
  }

  const sitting = messages.slice(sittingStart);
  const cappedMessages =
    sitting.length > maxMessages ? sitting.slice(-maxMessages) : sitting;

  return startOnHumanTurn(cappedMessages);
}
