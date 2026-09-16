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
      const codePoint = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;

      if (codePoint === 0 || codePoint > 0x10ffff || isSurrogate) {
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

function htmlToText(html: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(
      html
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h[1-6]>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' ')
        .replace(/<[^>]+>/g, ''),
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
