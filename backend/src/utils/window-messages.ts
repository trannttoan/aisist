import { BaseMessage, HumanMessage } from '@langchain/core/messages';

import { getMessageTimestamp } from './timestamp.js';

export const MESSAGE_WINDOW_DAYS = 7;
export const MAX_WINDOW_MESSAGES = 200;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function windowMessages(
  messages: BaseMessage[],
  {
    now = Date.now(),
    windowDays = MESSAGE_WINDOW_DAYS,
    maxMessages = MAX_WINDOW_MESSAGES,
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

  // Gemini rejects a history that opens on a tool call or tool result, so a
  // cut that lands mid-exchange has to move forward to the next human turn.
  const firstHumanIndex = cappedMessages.findIndex((message) =>
    HumanMessage.isInstance(message),
  );

  return firstHumanIndex > 0
    ? cappedMessages.slice(firstHumanIndex)
    : cappedMessages;
}
