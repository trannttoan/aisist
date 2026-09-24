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

// Reply quotes only. A forwarded message is the content, so its header stays.
const QUOTE_MARKERS = [
  /^On [^\n]{0,300}(?:\n[^\n]{0,300})?wrote:$/m,
  /^>/m,
  /^-{2,} ?Original Message ?-{2,}$/im,
  /^_{6,}\nFrom: /m,
];

// Drops the quoted history a reply carries below its own text. Thread output
// already shows the earlier messages, so the quote is pure repetition.
export function stripQuotedReply(text: string): string {
  let cut = text.length;

  for (const marker of QUOTE_MARKERS) {
    const index = text.search(marker);

    if (index !== -1 && index < cut) {
      cut = index;
    }
  }

  return text.slice(0, cut).trim() || text;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Keeps the head and the tail. Receipts and notices put totals and tracking
// lines at the bottom; a head-only cut answers "the email doesn't say".
export function truncateBody(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const headChars = Math.ceil((maxChars * 2) / 3);
  // Move each cut inward when it would split a surrogate pair.
  const headEnd = isHighSurrogate(text.charCodeAt(headChars - 1))
    ? headChars - 1
    : headChars;
  const tailFrom = text.length - (maxChars - headChars);
  const tailStart = isLowSurrogate(text.charCodeAt(tailFrom))
    ? tailFrom + 1
    : tailFrom;
  const note = `[... ${tailStart - headEnd} characters omitted ...]`;
  const tail = text.slice(tailStart);

  return tail
    ? `${text.slice(0, headEnd)}\n${note}\n${tail}`
    : `${text.slice(0, headEnd)}\n${note}`;
}

export function listAttachmentNames(
  payload: GmailMessagePart | undefined,
): string[] {
  return flattenParts(payload)
    .map((part) => part.filename?.trim())
    .filter((filename): filename is string => Boolean(filename));
}

export type RawMessageInput = {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
};

// RFC 2045 requires CRLF everywhere, including inside the body before it is
// encoded; RFC 2047 caps an encoded-word at 75 characters, which 45 UTF-8
// bytes of base64 (60 characters) plus the 12-character wrapper fits.
const MAX_ENCODED_WORD_BYTES = 45;
const MAX_BASE64_LINE_CHARS = 76;

// Runs on every header value before it is written, so a CR or LF in a
// model-supplied or untrusted value cannot inject a header line.
function headerValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) {
    return subject;
  }

  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  // Iterates code points, so a surrogate pair is never split across chunks.
  for (const char of subject) {
    const size = Buffer.byteLength(char, 'utf8');

    if (chunkBytes + size > MAX_ENCODED_WORD_BYTES) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }

    chunk += char;
    chunkBytes += size;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks
    .map(
      (part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`,
    )
    .join('\r\n ');
}

export function buildRawMessage(input: RawMessageInput): string {
  const to = headerValue(input.to);
  const cc = input.cc ? headerValue(input.cc) : '';
  const subject = headerValue(input.subject);
  const inReplyTo = input.inReplyTo ? headerValue(input.inReplyTo) : '';
  const references = (input.references ?? []).map(headerValue).filter(Boolean);

  const headerLines = [`To: ${to}`];

  if (cc) {
    headerLines.push(`Cc: ${cc}`);
  }

  headerLines.push(`Subject: ${encodeSubject(subject)}`);

  if (inReplyTo) {
    headerLines.push(`In-Reply-To: ${inReplyTo}`);
  }

  if (references.length > 0) {
    // Folded one msg-id per line: a thread of about 14 messages would
    // otherwise cross RFC 5322's 998-character line limit.
    headerLines.push(`References: ${references.join('\r\n ')}`);
  }

  headerLines.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  );

  const encodedBody = Buffer.from(
    input.body.replace(/\r\n?|\n/g, '\r\n'),
    'utf8',
  ).toString('base64');
  const bodyLines: string[] = [];

  for (
    let index = 0;
    index < encodedBody.length;
    index += MAX_BASE64_LINE_CHARS
  ) {
    bodyLines.push(encodedBody.slice(index, index + MAX_BASE64_LINE_CHARS));
  }

  const raw =
    headerLines.join('\r\n') +
    '\r\n\r\n' +
    bodyLines.map((line) => `${line}\r\n`).join('');

  return Buffer.from(raw, 'utf8').toString('base64url');
}
