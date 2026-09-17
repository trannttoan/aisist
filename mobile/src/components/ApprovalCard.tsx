import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatMessage } from '../store/chat';
import { useChatStore } from '../store/chat';

// The card sits in an inverted list with no nested scroller, so a bulk change
// shows the first rows and counts the rest.
const MAX_VISIBLE_MESSAGES = 10;

type ApprovalCardProps = {
  message: ChatMessage & {
    interrupt: NonNullable<ChatMessage['interrupt']>;
  };
};

type ApprovalSectionProps = {
  entries: Array<[string, unknown]>;
  title: string;
};

type MessageListSectionProps = {
  count: unknown;
  messages: NonNullable<ApprovalCardProps['message']['interrupt']['messages']>;
};

export function ApprovalCard({ message }: ApprovalCardProps) {
  const isSending = useChatStore((state) => state.isSending);
  const resumeApproval = useChatStore((state) => state.resumeApproval);
  const currentEntries = Object.entries(message.interrupt.current);
  const proposedEntries = message.interrupt.proposed
    ? Object.entries(message.interrupt.proposed)
    : [];
  const affectedMessages = message.interrupt.messages ?? [];
  const isApproved = message.status === 'approved';
  const isPendingApproval = message.status === 'pending_approval';
  const isRejected = message.status === 'rejected';
  const isDecisionDisabled = isSending || !isPendingApproval;

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>
        {formatActionLabel(message.interrupt.action)}
      </Text>
      <Text style={styles.description}>{message.interrupt.description}</Text>

      {affectedMessages.length > 0 ? (
        <MessageListSection
          count={message.interrupt.current.count}
          messages={affectedMessages}
        />
      ) : null}

      <ApprovalSection entries={currentEntries} title="Current" />

      {proposedEntries.length > 0 ? (
        <ApprovalSection entries={proposedEntries} title="Proposed" />
      ) : null}

      {isPendingApproval ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={isDecisionDisabled}
            onPress={() => {
              void resumeApproval(message.id, 'approve');
            }}
            style={({ pressed }) => [
              styles.actionButton,
              styles.approveButton,
              isDecisionDisabled ? styles.buttonDisabled : null,
              pressed && !isDecisionDisabled ? styles.buttonPressed : null,
            ]}
          >
            <Text style={[styles.actionButtonText, styles.approveButtonText]}>
              Approve
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={isDecisionDisabled}
            onPress={() => {
              void resumeApproval(message.id, 'reject');
            }}
            style={({ pressed }) => [
              styles.actionButton,
              styles.rejectButton,
              isDecisionDisabled ? styles.buttonDisabled : null,
              pressed && !isDecisionDisabled ? styles.buttonPressed : null,
            ]}
          >
            <Text style={[styles.actionButtonText, styles.rejectButtonText]}>
              Reject
            </Text>
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.badge,
            isApproved ? styles.approvedBadge : null,
            isRejected ? styles.rejectedBadge : null,
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              isApproved ? styles.approvedBadgeText : null,
              isRejected ? styles.rejectedBadgeText : null,
            ]}
          >
            {isApproved ? 'Approved' : 'Rejected'}
          </Text>
        </View>
      )}
    </View>
  );
}

function ApprovalSection({ entries, title }: ApprovalSectionProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>

      <View style={styles.sectionBody}>
        {entries.map(([key, value]) => (
          <View key={key} style={styles.valueRow}>
            <Text style={styles.valueKey}>{formatFieldLabel(key)}</Text>
            <Text style={styles.valueText}>{formatValue(value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MessageListSection({ count, messages }: MessageListSectionProps) {
  const total =
    typeof count === 'number' && Number.isFinite(count)
      ? count
      : messages.length;
  const visible = messages.slice(0, MAX_VISIBLE_MESSAGES);
  const hiddenCount = messages.length - visible.length;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{`Messages (${total})`}</Text>

      <View style={styles.sectionBody}>
        {visible.map((entry, index) => (
          <Text
            key={`${index}-${entry.from}`}
            numberOfLines={1}
            style={styles.valueText}
          >
            {`${entry.from} — ${entry.subject}`}
          </Text>
        ))}

        {hiddenCount > 0 ? (
          <Text style={styles.valueKey}>{`+ ${hiddenCount} more`}</Text>
        ) : null}
      </View>
    </View>
  );
}

function formatActionLabel(action: string): string {
  return sentenceCase(action.replace(/_/g, ' '));
}

function formatFieldLabel(key: string): string {
  return sentenceCase(
    key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '),
  );
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'None';
    }

    return value.map((entry) => formatArrayEntry(entry)).join(', ');
  }

  if (value === null || value === undefined) {
    return 'None';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function formatArrayEntry(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  approveButton: {
    backgroundColor: '#1f5c4a',
    borderColor: '#1f5c4a',
  },
  approveButtonText: {
    color: '#f7f4ee',
  },
  approvedBadge: {
    backgroundColor: '#1f5c4a',
  },
  approvedBadgeText: {
    color: '#f7f4ee',
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  badgeText: {
    fontSize: 14,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonPressed: {
    opacity: 0.92,
  },
  card: {
    backgroundColor: '#fffdf8',
    borderColor: '#d8cec0',
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    padding: 20,
    width: '100%',
  },
  description: {
    color: '#1f2a24',
    fontSize: 16,
    lineHeight: 23,
  },
  eyebrow: {
    color: '#7a6f63',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  rejectButton: {
    backgroundColor: 'transparent',
    borderColor: '#1f5c4a',
  },
  rejectButtonText: {
    color: '#1f5c4a',
  },
  rejectedBadge: {
    backgroundColor: '#f8e8e1',
  },
  rejectedBadgeText: {
    color: '#7c2d1c',
  },
  section: {
    gap: 10,
  },
  sectionBody: {
    gap: 10,
  },
  sectionTitle: {
    color: '#1f2a24',
    fontSize: 14,
    fontWeight: '700',
  },
  valueKey: {
    color: '#8d8377',
    fontSize: 14,
    lineHeight: 20,
  },
  valueRow: {
    gap: 2,
  },
  valueText: {
    color: '#1f2a24',
    fontSize: 14,
    lineHeight: 20,
  },
});
