export type GmailHeader = {
  name?: string;
  value?: string;
};

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
};

export function getHeader(
  payload: GmailMessagePart | undefined,
  name: string,
): string | undefined {
  const target = name.toLowerCase();

  return payload?.headers?.find(
    (header) => header.name?.toLowerCase() === target,
  )?.value;
}

// Gmail reverses the transfer encoding but not the part's declared charset, so
// legacy non-UTF-8 mail can decode to replacement characters. Best-effort.
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
};

const HTML_ENTITY_PATTERN = new RegExp(
  `&(#x[0-9a-f]+|#\\d+|${Object.keys(NAMED_ENTITIES).join('|')});`,
  'gi',
);

export function decodeHtmlEntities(text: string): string {
  // A single pass so &amp;lt; decodes to &lt; rather than <.
  return text.replace(HTML_ENTITY_PATTERN, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = /^#x/i.test(entity)
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;

      if (
        Number.isNaN(codePoint) ||
        codePoint === 0 ||
        codePoint > 0x10ffff ||
        isSurrogate
      ) {
        return match;
      }

      return String.fromCodePoint(codePoint);
    }

    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// Depth-first, root first. A part with a filename is an attachment and is
// treated as a leaf, so a message/rfc822 payload cannot supply a body part.
function flattenParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
  if (!part) {
    return [];
  }

  if (part.filename?.trim()) {
    return [part];
  }

  return [part, ...(part.parts ?? []).flatMap(flattenParts)];
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Finds `prefix` followed by whitespace or `>`, so `<head` does not match
// `<header`.
function findTag(lower: string, prefix: string, from: number): number {
  let index = lower.indexOf(prefix, from);

  while (index !== -1) {
    const next = lower[index + prefix.length];

    if (next === undefined || next === '>' || /\s/.test(next)) {
      return index;
    }

    index = lower.indexOf(prefix, index + 1);
  }

  return -1;
}

// A single forward scan. A lazy regex rescans to the end for every unclosed
// opener, which is quadratic on a crafted body and stalls the event loop.
function stripBlocks(html: string, open: string, close: string): string {
  const lower = html.toLowerCase();
  const kept: string[] = [];
  let cursor = 0;

  for (;;) {
    const start = findTag(lower, open, cursor);
    const closeStart = start === -1 ? -1 : findTag(lower, close, start);
    const end = closeStart === -1 ? -1 : lower.indexOf('>', closeStart);

    if (end === -1) {
      break;
    }

    kept.push(html.slice(cursor, start));
    cursor = end + 1;
  }

  kept.push(html.slice(cursor));

  return kept.join('');
}

function stripComments(html: string): string {
  const kept: string[] = [];
  let cursor = 0;

  for (;;) {
    const start = html.indexOf('<!--', cursor);
    const end = start === -1 ? -1 : html.indexOf('-->', start + 4);

    if (end === -1) {
      break;
    }

    kept.push(html.slice(cursor, start));
    cursor = end + 3;
  }

  kept.push(html.slice(cursor));

  return kept.join('');
}

function htmlToText(html: string): string {
  let text = html;

  for (const tag of ['head', 'title', 'style', 'script']) {
    text = stripBlocks(text, `<${tag}`, `</${tag}`);
  }

  // `[^<>]` rather than `[^>]` so a run of `<` with no `>` is linear.
  return normalizeWhitespace(
    decodeHtmlEntities(
      stripComments(text)
        .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h[1-6]>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' ')
        .replace(/<[^<>]+>/g, ''),
    ),
  );
}

export function extractTextBody(payload: GmailMessagePart | undefined): string {
  const parts = flattenParts(payload).filter((part) => !part.filename?.trim());

  const plain = parts.find(
    (part) => part.mimeType?.toLowerCase() === 'text/plain' && part.body?.data,
  );

  if (plain?.body?.data) {
    return normalizeWhitespace(decodeBase64Url(plain.body.data));
  }

  const html = parts.find(
    (part) => part.mimeType?.toLowerCase() === 'text/html' && part.body?.data,
  );

  if (html?.body?.data) {
    return htmlToText(decodeBase64Url(html.body.data));
  }

  return '';
}

export function truncateBody(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n[body truncated]`;
}

export function listAttachmentNames(
  payload: GmailMessagePart | undefined,
): string[] {
  return flattenParts(payload)
    .map((part) => part.filename?.trim())
    .filter((filename): filename is string => Boolean(filename));
}
