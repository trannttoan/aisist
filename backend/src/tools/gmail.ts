import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { fetchWithAuth } from '../utils/google-api.js';
import { getAccessToken } from '../utils/tool-config.js';

const GMAIL_API_BASE_URL = 'https://www.googleapis.com/gmail/v1';

type GmailLabel = {
  id: string;
  name?: string;
  type?: 'system' | 'user';
};

type ListLabelsResponse = {
  labels?: GmailLabel[];
};

function buildListLabelsUrl(): string {
  return new URL(`${GMAIL_API_BASE_URL}/users/me/labels`).toString();
}

function formatLabels(labels: GmailLabel[]): string {
  if (labels.length === 0) {
    return 'No labels found.';
  }

  // The API returns labels in an arbitrary order; system labels first then
  // user labels by name keeps the output stable across calls.
  const rows = labels.map((label) => ({
    id: label.id,
    name: label.name?.trim() || 'Untitled label',
    type: label.type ?? 'user',
  }));

  rows.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'system' ? -1 : 1;
    }

    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });

  const lines = rows.map(
    (row) => `- ${row.name} (${row.type}) (id: ${row.id})`,
  );

  return `Labels:\n${lines.join('\n')}`;
}

export const listGmailLabels = tool(
  async (_input, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListLabelsResponse>(
      buildListLabelsUrl(),
      {
        method: 'GET',
      },
      accessToken,
    );

    return formatLabels(response?.labels ?? []);
  },
  {
    name: 'list_gmail_labels',
    description:
      "List the labels in the user's Gmail account. Use this to resolve a label name to the ID that the other Gmail tools require.",
    schema: z.object({}),
  },
);

export const gmailTools = [listGmailLabels];
