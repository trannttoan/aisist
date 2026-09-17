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
    messages: Array.from({ length: count }, (_unused, index) => ({
      from: `Sender ${index + 1} <sender${index + 1}@example.com>`,
      subject: `Newsletter ${index + 1}`,
    })),
    proposed: { change: 'Archive' },
  };
}

describe('ApprovalCard', () => {
  it('shows the first ten messages and counts the rest', async () => {
    await render(
      <ApprovalCard message={createMessage(createGmailInterrupt(12))} />,
    );

    expect(screen.getByText('Messages (12)')).toBeTruthy();

    for (let index = 1; index <= 10; index += 1) {
      expect(
        screen.getByText(
          `Sender ${index} <sender${index}@example.com> — Newsletter ${index}`,
        ),
      ).toBeTruthy();
    }

    expect(screen.queryByText(/Newsletter 11/)).toBeNull();
    expect(screen.getByText('+ 2 more')).toBeTruthy();
  });

  it('shows every message without an overflow row when the list is short', async () => {
    await render(
      <ApprovalCard message={createMessage(createGmailInterrupt(3))} />,
    );

    expect(screen.getByText('Messages (3)')).toBeTruthy();
    expect(
      screen.getByText('Sender 3 <sender3@example.com> — Newsletter 3'),
    ).toBeTruthy();
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it('renders a card without messages unchanged', async () => {
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

    expect(screen.queryByText(/^Messages \(/)).toBeNull();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('Approve the event update.')).toBeTruthy();
  });
});
