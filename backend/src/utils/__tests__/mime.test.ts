import { describe, expect, it } from 'vitest';

import {
  decodeBase64Url,
  decodeHtmlEntities,
  extractTextBody,
  getHeader,
  listAttachmentNames,
  truncateBody,
  type GmailMessagePart,
} from '../mime.js';

const encode = (text: string) =>
  Buffer.from(text, 'utf8').toString('base64url');

describe('getHeader', () => {
  it('returns the header value case-insensitively', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Amazon <no-reply@amazon.com>' },
        { name: 'subject', value: 'Your order has shipped' },
      ],
    };

    expect(getHeader(payload, 'from')).toBe('Amazon <no-reply@amazon.com>');
    expect(getHeader(payload, 'SUBJECT')).toBe('Your order has shipped');
  });

  it('returns undefined when the header is absent or headers are missing', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: 'a@example.com' }],
    };

    expect(getHeader(payload, 'Date')).toBeUndefined();
    expect(getHeader({ mimeType: 'text/plain' }, 'From')).toBeUndefined();
    expect(getHeader(undefined, 'From')).toBeUndefined();
  });
});

describe('decodeBase64Url', () => {
  it('decodes unpadded base64url containing - and _', () => {
    expect(decodeBase64Url('w7_DviB-IMO4Pw')).toBe('ÿþ ~ ø?');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(
      decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39; &#x27; &apos; &nbsp;'),
    ).toBe("& < > \" ' ' '  ");
  });

  it('does not double-decode &amp;lt;', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('extractTextBody', () => {
  it('returns the body of a single-part text/plain message', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      body: { size: 11, data: encode('Hello there') },
    };

    expect(extractTextBody(payload)).toBe('Hello there');
  });

  it('prefers text/plain over text/html in multipart/alternative', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: encode('Plain wins') } },
        {
          mimeType: 'text/html',
          body: { data: encode('<p>Html loses</p>') },
        },
      ],
    };

    expect(extractTextBody(payload)).toBe('Plain wins');
  });

  it('strips tags and decodes entities from an html-only message', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/html',
      body: {
        data: encode('<div><p>Hello &amp; welcome</p><p>Second line</p></div>'),
      },
    };

    expect(extractTextBody(payload)).toBe('Hello & welcome\nSecond line');
  });

  it('drops style, script, and comment blocks before stripping tags', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/html',
      body: {
        data: encode(
          '<style>body{color:red}</style><script>track("mso")</script>' +
            '<!--[if mso]><td>mso junk</td><![endif]--><p>Real content</p>',
        ),
      },
    };

    const result = extractTextBody(payload);

    expect(result).toBe('Real content');
    expect(result).not.toContain('color:red');
    expect(result).not.toContain('mso');
  });

  it('finds the text part inside nested multipart/mixed with an attachment', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: encode('Nested body') } },
            {
              mimeType: 'text/html',
              body: { data: encode('<p>Nested html</p>') },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att-1', size: 1024 },
        },
      ],
    };

    expect(extractTextBody(payload)).toBe('Nested body');
  });

  it('never uses a text/plain attachment with a filename as the body', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: encode('<p>Real body</p>') },
        },
        {
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { data: encode('Attachment text') },
        },
      ],
    };

    expect(extractTextBody(payload)).toBe('Real body');
    expect(listAttachmentNames(payload)).toEqual(['notes.txt']);
  });

  it('falls through to html when the text/plain part has no data', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { size: 0 } },
        {
          mimeType: 'text/html',
          body: { data: encode('<p>Html fallback</p>') },
        },
      ],
    };

    expect(extractTextBody(payload)).toBe('Html fallback');
  });

  it('returns an empty string when there is no body', () => {
    expect(extractTextBody({ mimeType: 'multipart/mixed' })).toBe('');
    expect(extractTextBody(undefined)).toBe('');
  });

  it('round-trips non-ASCII text', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      body: { data: encode('Jörg — café ☕') },
    };

    expect(extractTextBody(payload)).toBe('Jörg — café ☕');
  });
});

describe('truncateBody', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(truncateBody('short', 10)).toBe('short');
    expect(truncateBody('exactly-10', 10)).toBe('exactly-10');
  });

  // slice counts UTF-16 code units, so a cut can split a surrogate pair and
  // leave a replacement character; harmless for summarisation.
  it('appends a truncation note only when the limit is exceeded', () => {
    expect(truncateBody('abcdef', 3)).toBe('abc\n[body truncated]');
    expect(truncateBody('😀😀', 1)).toBe(
      `${'😀😀'.slice(0, 1)}\n[body truncated]`,
    );
  });
});

describe('listAttachmentNames', () => {
  it('lists parts with a filename in document order', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'text/html',
              body: { data: encode('<p>Body</p>') },
            },
            {
              mimeType: 'image/png',
              filename: 'logo.png',
              headers: [{ name: 'Content-ID', value: '<logo>' }],
              body: { attachmentId: 'att-1', size: 200 },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att-2', size: 1024 },
        },
      ],
    };

    expect(listAttachmentNames(payload)).toEqual(['logo.png', 'invoice.pdf']);
  });

  it('returns an empty array when there are no attachments', () => {
    expect(
      listAttachmentNames({
        mimeType: 'text/plain',
        body: { data: encode('Hello') },
      }),
    ).toEqual([]);
    expect(listAttachmentNames(undefined)).toEqual([]);
  });
});
