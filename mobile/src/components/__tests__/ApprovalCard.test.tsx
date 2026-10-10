import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

import type { InterruptPayload } from '../../services/langgraph';
import type { ChatMessage } from '../../store/chat';

jest.mock('../../store/chat', () => ({
  useChatStore: jest.fn((selector: (state: unknown) => unknown) =>
    selector({ isSending: false, resumeApproval: jest.fn() }),
  ),
}));

import { ApprovalCard } from '../ApprovalCard';

function createMessage(interrupt: InterruptPayload) {
  return {
    clientKey: interrupt.id,
    id: interrupt.id,
    interrupt,
    role: 'assistant',
    status: 'pending_approval',
    text: '',
  } as ChatMessage & { interrupt: InterruptPayload };
}

function createGmailInterrupt(count: number): InterruptPayload {
  return {
    action: 'modify_gmail_labels',
    current: { count },
    description: `Archive ${count} messages.`,
    id: 'interrupt-task-1',
    items: Array.from({ length: count }, (_unused, index) => ({
      subtitle: `Sender ${index + 1} <sender${index + 1}@example.com>`,
      title: `Newsletter ${index + 1}`,
    })),
    proposed: { change: 'Archive' },
  };
}

describe('ApprovalCard', () => {
  it('shows the first ten items and counts the rest', async () => {
    await render(
      <ApprovalCard message={createMessage(createGmailInterrupt(12))} />,
    );

    expect(screen.getByText('Items (12)')).toBeTruthy();

    for (let index = 1; index <= 10; index += 1) {
      expect(
        screen.getByText(
          `Newsletter ${index} — Sender ${index} <sender${index}@example.com>`,
        ),
      ).toBeTruthy();
    }

    expect(screen.queryByText(/Newsletter 11/)).toBeNull();
    expect(screen.getByText('+ 2 more')).toBeTruthy();
  });

  it('shows every item without an overflow row when the list is short', async () => {
    await render(
      <ApprovalCard message={createMessage(createGmailInterrupt(3))} />,
    );

    expect(screen.getByText('Items (3)')).toBeTruthy();
    expect(
      screen.getByText('Newsletter 3 — Sender 3 <sender3@example.com>'),
    ).toBeTruthy();
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it('shows a row without a subtitle as its title alone', async () => {
    await render(
      <ApprovalCard
        message={createMessage({
          action: 'delete_calendar_events',
          current: { count: 1 },
          description: 'Delete 1 event.',
          id: 'interrupt-task-1',
          items: [{ title: 'Test Event 1' }],
          proposed: null,
        })}
      />,
    );

    expect(screen.getByText('Test Event 1')).toBeTruthy();
  });

  it('renders a card without items unchanged', async () => {
    await render(
      <ApprovalCard
        message={createMessage({
          action: 'update_calendar_event',
          current: { title: 'Before' },
          description: 'Approve the event update.',
          id: 'interrupt-task-1',
          proposed: { title: 'After' },
        })}
      />,
    );

    expect(screen.queryByText(/^Items \(/)).toBeNull();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('Approve the event update.')).toBeTruthy();
  });
});
