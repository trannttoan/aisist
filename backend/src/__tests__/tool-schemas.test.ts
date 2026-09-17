import { describe, expect, it } from 'vitest';
import { toJsonSchema } from '@langchain/core/utils/json_schema';

import { calendarTools } from '../tools/calendar.js';
import { gmailTools } from '../tools/gmail.js';
import { taskTools } from '../tools/tasks.js';

const allTools = [...calendarTools, ...taskTools, ...gmailTools];

describe('tool schemas', () => {
  // Gemini rejects $ref in function declarations, and the converter emits one
  // whenever two fields share a zod instance.
  it.each(allTools.map((tool) => [tool.name, tool] as const))(
    '%s converts to JSON schema without $ref',
    (_name, tool) => {
      expect(JSON.stringify(toJsonSchema(tool.schema as never))).not.toContain(
        '$ref',
      );
    },
  );
});
