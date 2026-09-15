import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { stampMessage } from '../timestamp.js';
import { windowMessages } from '../window-messages.js';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

describe('windowMessages', () => {
  it('keeps only messages within the seven-day window', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = [
      stampMessage(new HumanMessage('recent'), now - DAY_IN_MS),
      stampMessage(new AIMessage('at-cutoff'), now - 7 * DAY_IN_MS),
      stampMessage(new HumanMessage('stale'), now - 8 * DAY_IN_MS),
    ];

    const result = windowMessages(messages, { now });

    expect(result.map((message) => message.content)).toEqual([
      'recent',
      'at-cutoff',
    ]);
  });

  it('caps the window to the most recent 200 timestamped messages', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const messages = Array.from({ length: 205 }, (_, index) =>
      stampMessage(
        new HumanMessage(`message-${index}`),
        now - (205 - index) * 1000,
      ),
    );

    const result = windowMessages(messages, {
      maxMessages: 200,
      now,
      windowDays: 30,
    });

    expect(result).toHaveLength(200);
    expect(result[0]?.content).toBe('message-5');
    expect(result.at(-1)?.content).toBe('message-204');
  });

  it('starts the window on a human turn when the cap cuts through a tool exchange', () => {
    const now = Date.UTC(2026, 5, 11, 16, 0, 0);
    const toolCall = {
      id: 'call-1',
      name: 'list_tasks',
      args: {},
      type: 'tool_call' as const,
    };
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
      stampMessage(new HumanMessage('stale'), now - 8 * DAY_IN_MS),
      stampMessage(
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'call-1', name: 'list_tasks', args: {}, type: 'tool_call' },
          ],
        }),
        now - 8 * DAY_IN_MS,
      ),
      stampMessage(
        new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
        now - 6 * DAY_IN_MS,
      ),
      stampMessage(new AIMessage('answer'), now - 6 * DAY_IN_MS),
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

    const result = windowMessages(messages, { now, windowDays: 30 });

    expect(result.map((message) => message.content)).toEqual(['timestamped']);
  });
});
