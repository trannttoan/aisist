import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { stampMessage } from '../timestamp.js';
import { selectModelContext, windowMessages } from '../window-messages.js';

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HOUR_IN_MS = 60 * 60 * 1000;

const toolCall = {
  id: 'call-1',
  name: 'list_tasks',
  args: {},
  type: 'tool_call' as const,
};

describe('windowMessages', () => {
  it('keeps only messages within the thirty-day retention window', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage('stale'), now - 31 * DAY_IN_MS),
      stampMessage(new HumanMessage('at-cutoff'), now - 30 * DAY_IN_MS),
      stampMessage(new AIMessage('answer'), now - 29 * DAY_IN_MS),
      stampMessage(new HumanMessage('recent'), now - DAY_IN_MS),
    ];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual([
      'at-cutoff',
      'answer',
      'recent',
    ]);
  });

  it('caps the window to the most recent timestamped messages', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = Array.from({ length: 205 }, (_, index) =>
      stampMessage(
        new HumanMessage(`message-${index}`),
        now - (205 - index) * 1000,
      ),
    );

    const result = windowMessages(messages, { maxMessages: 200, now });

    expect(result).toHaveLength(200);
    expect(result[0]?.content).toBe('message-5');
    expect(result.at(-1)?.content).toBe('message-204');
  });

  it('starts the window on a human turn when the cap cuts through a tool exchange', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      new HumanMessage('first'),
      new AIMessage({ content: '', tool_calls: [toolCall] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
      new AIMessage('answer'),
      new HumanMessage('second'),
      new AIMessage({ content: '', tool_calls: [toolCall] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
      new AIMessage('answer'),
    ].map((message, index) => stampMessage(message, now - (8 - index) * 1000));

    const result = windowMessages(messages, { maxMessages: 6, now });

    expect(result).toHaveLength(4);
    expect(result[0]?.content).toBe('second');
  });

  it('starts the window on a human turn when the date cutoff splits a tool exchange', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage('stale'), now - 31 * DAY_IN_MS),
      stampMessage(
        new AIMessage({ content: '', tool_calls: [toolCall] }),
        now - 31 * DAY_IN_MS,
      ),
      stampMessage(
        new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
        now - 29 * DAY_IN_MS,
      ),
      stampMessage(new AIMessage('answer'), now - 29 * DAY_IN_MS),
      stampMessage(new HumanMessage('recent'), now),
    ];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual(['recent']);
  });

  it('leaves a window that already starts on a human turn unchanged', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage('first'), now - 3_000),
      stampMessage(new AIMessage('answer'), now - 2_000),
      stampMessage(new HumanMessage('second'), now - 1_000),
    ];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual([
      'first',
      'answer',
      'second',
    ]);
  });

  it('keeps a window with no human turn rather than emptying it', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [stampMessage(new AIMessage('only-ai'), now - 1_000)];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual(['only-ai']);
  });

  it('drops messages that do not carry a timestamp', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage('timestamped'), now - 1_000),
      new AIMessage('missing-timestamp'),
    ];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual(['timestamped']);
  });
});

describe('selectModelContext', () => {
  const now = Date.UTC(2026, 5, 11, 16, 0, 0);

  it('returns everything when no human turn follows a long gap', () => {
    const messages = [
      stampMessage(new HumanMessage('first'), now - 3 * HOUR_IN_MS),
      stampMessage(new AIMessage('answer'), now - 3 * HOUR_IN_MS + 1_000),
      stampMessage(new HumanMessage('second'), now - HOUR_IN_MS),
      stampMessage(new AIMessage('answer'), now - HOUR_IN_MS + 1_000),
      stampMessage(new HumanMessage('third'), now),
    ];

    const result = selectModelContext(messages);

    expect(result.map((message) => message.content)).toEqual([
      'first',
      'answer',
      'second',
      'answer',
      'third',
    ]);
  });

  it('starts a new sitting at the latest human turn that follows a gap', () => {
    const messages = [
      stampMessage(new HumanMessage('yesterday'), now - DAY_IN_MS),
      stampMessage(new AIMessage('answer'), now - DAY_IN_MS + 1_000),
      stampMessage(new HumanMessage('this morning'), now - 5 * HOUR_IN_MS),
      stampMessage(new AIMessage('answer'), now - 5 * HOUR_IN_MS + 1_000),
      stampMessage(new HumanMessage('now'), now),
      stampMessage(new AIMessage('answer'), now + 1_000),
    ];

    const result = selectModelContext(messages);

    expect(result.map((message) => message.content)).toEqual(['now', 'answer']);
  });

  it('keeps a gap inside a tool exchange in the same sitting', () => {
    const messages = [
      stampMessage(new HumanMessage('delete it'), now - 6 * HOUR_IN_MS),
      stampMessage(
        new AIMessage({ content: '', tool_calls: [toolCall] }),
        now - 6 * HOUR_IN_MS + 1_000,
      ),
      stampMessage(
        new ToolMessage({ content: 'Deleted.', tool_call_id: 'call-1' }),
        now,
      ),
    ];

    const result = selectModelContext(messages);

    expect(result.map((message) => message.content)).toEqual([
      'delete it',
      '',
      'Deleted.',
    ]);
  });

  it('caps a long sitting and starts the result on a human turn', () => {
    const messages = [
      new HumanMessage('first'),
      new AIMessage({ content: '', tool_calls: [toolCall] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
      new AIMessage('answer'),
      new HumanMessage('second'),
      new AIMessage({ content: '', tool_calls: [toolCall] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
      new AIMessage('answer'),
    ].map((message, index) => stampMessage(message, now - (8 - index) * 1000));

    const result = selectModelContext(messages, { maxMessages: 6 });

    expect(result).toHaveLength(4);
    expect(result[0]?.content).toBe('second');
  });

  it('treats a gap of exactly the threshold as the same sitting', () => {
    const messages = [
      stampMessage(new HumanMessage('first'), now - 4 * HOUR_IN_MS),
      stampMessage(new HumanMessage('second'), now),
    ];

    const result = selectModelContext(messages);

    expect(result.map((message) => message.content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('ignores gaps next to messages without a timestamp', () => {
    const messages = [
      stampMessage(new HumanMessage('first'), now - DAY_IN_MS),
      new AIMessage('unstamped'),
      stampMessage(new HumanMessage('second'), now),
    ];

    const result = selectModelContext(messages);

    expect(result.map((message) => message.content)).toEqual([
      'first',
      'unstamped',
      'second',
    ]);
  });
});
