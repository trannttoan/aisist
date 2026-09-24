import { describe, expect, it } from 'vitest';

import {
  buildRawMessage,
  decodeBase64Url,
  decodeHtmlEntities,
  extractTextBody,
  getHeader,
  listAttachmentNames,
  stripQuotedReply,
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
      decodeHtmlEntities(
        '&amp; &lt; &gt; &quot; &#39; &#x27; &#X27; &apos; &nbsp;',
      ),
    ).toBe("& < > \" ' ' ' '  ");
  });

  it('does not double-decode &amp;lt;', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('decodes common typographic entities', () => {
    expect(
      decodeHtmlEntities(
        '&lsquo;a&rsquo; &ldquo;b&rdquo; &ndash; &mdash; &hellip; &copy;',
      ),
    ).toBe('‘a’ “b” – — … ©');
  });

  it('leaves unknown, null, surrogate, and out-of-range references intact', () => {
    expect(decodeHtmlEntities('&bogus; &#0; &#xD800; &#1114112;')).toBe(
      '&bogus; &#0; &#xD800; &#1114112;',
    );
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

  it('does not treat <header> as the document head', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/html',
      body: {
        data: encode(
          '<header>Top</header><p>Body</p></head><style x>a</style><p>After</p>',
        ),
      },
    };

    expect(extractTextBody(payload)).toBe('TopBody\nAfter');
  });

  it('handles a megabyte of unclosed markup in linear time', () => {
    const shapes = [
      '<'.repeat(1_000_000) + 'x',
      '<style>x'.repeat(125_000),
      '<!--x'.repeat(200_000),
      '<head x'.repeat(125_000),
    ];

    for (const html of shapes) {
      const payload: GmailMessagePart = {
        mimeType: 'text/html',
        body: { data: encode(html) },
      };
      const started = Date.now();

      extractTextBody(payload);

      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('drops the document head and separates table cells', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/html',
      body: {
        data: encode(
          '<html><head><title>Weekly Deals</title></head><body>' +
            '<table><tr><td>Nested</td><td>cell</td></tr></table></body></html>',
        ),
      },
    };

    expect(extractTextBody(payload)).toBe('Nested cell');
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

describe('stripQuotedReply', () => {
  it('cuts at a Gmail "On ... wrote:" line', () => {
    expect(
      stripQuotedReply(
        'Sounds good, see you then.\n\nOn Mon, 14 Sep 2026 at 09:00, Landlord <l@example.com> wrote:\n> Can we meet Tuesday?',
      ),
    ).toBe('Sounds good, see you then.');
  });

  it('cuts at a wrapped "On ... wrote:" header', () => {
    expect(
      stripQuotedReply(
        'Yes.\n\nOn Mon, 14 Sep 2026 at 09:00, Landlord\n<l@example.com> wrote:\n> Can we meet Tuesday?',
      ),
    ).toBe('Yes.');
  });

  it('cuts at the first quoted line', () => {
    expect(stripQuotedReply('Agreed.\n> earlier text\n> more')).toBe('Agreed.');
  });

  it('cuts at an Outlook original-message block', () => {
    expect(
      stripQuotedReply(
        'Thanks.\n\n-----Original Message-----\nFrom: Landlord\nSent: Monday',
      ),
    ).toBe('Thanks.');
    expect(
      stripQuotedReply(
        'Thanks.\n\n________________\nFrom: Landlord\nSent: Monday',
      ),
    ).toBe('Thanks.');
  });

  it('keeps a forwarded message', () => {
    const forwarded =
      'FYI\n\n---------- Forwarded message ---------\nFrom: DHL <no-reply@dhl.com>\nYour parcel is out for delivery.';

    expect(stripQuotedReply(forwarded)).toBe(forwarded);
  });

  it('returns the original text when nothing but a quote remains', () => {
    expect(stripQuotedReply('> only quoted\n> lines')).toBe(
      '> only quoted\n> lines',
    );
  });

  it('leaves text without quote markers unchanged', () => {
    expect(stripQuotedReply('On time, as promised.\nSee you.')).toBe(
      'On time, as promised.\nSee you.',
    );
  });
});

describe('truncateBody', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(truncateBody('short', 10)).toBe('short');
    expect(truncateBody('exactly-10', 10)).toBe('exactly-10');
  });

  it('keeps the head and tail with a note on how much was omitted', () => {
    expect(truncateBody('abcdefghij', 6)).toBe(
      'abcd\n[... 4 characters omitted ...]\nij',
    );
  });

  it('does not split a surrogate pair at either cut', () => {
    expect(truncateBody('😀😀😀😀', 3)).toBe(
      '😀\n[... 6 characters omitted ...]',
    );
    expect(truncateBody('😀😀😀😀', 6)).toBe(
      '😀😀\n[... 2 characters omitted ...]\n😀',
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

describe('buildRawMessage', () => {
  const parse = (raw: string) => {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.indexOf('\r\n\r\n');
    const headerBlock = decoded.slice(0, separator);
    const bodyRegion = decoded.slice(separator + 4);

    return {
      decoded,
      // Unfolded first so a folded Subject or References counts as one header.
      headers: headerBlock.split('\r\n ').join(' ').split('\r\n'),
      bodyRegion,
      body: Buffer.from(bodyRegion.split('\r\n').join(''), 'base64').toString(
        'utf8',
      ),
    };
  };

  it('writes the minimal header set for a new message', () => {
    const { headers, body } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject: 'Rent',
        body: 'Rent is sent.\nThanks.',
      }),
    );

    expect(headers).toEqual([
      'To: landlord@example.com',
      'Subject: Rent',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(body).toBe('Rent is sent.\r\nThanks.');
  });

  it('writes every optional header in order', () => {
    const { headers } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        cc: 'partner@example.com',
        subject: 'Re: Lease renewal',
        body: 'Sent today.',
        inReplyTo: '<abc@example.com>',
        references: ['<first@example.com>', '<abc@example.com>'],
      }),
    );

    expect(headers).toEqual([
      'To: landlord@example.com',
      'Cc: partner@example.com',
      'Subject: Re: Lease renewal',
      'In-Reply-To: <abc@example.com>',
      'References: <first@example.com> <abc@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
  });

  it('encodes a short non-ASCII subject as one encoded-word', () => {
    const subject = 'Tiền nhà tháng 10';
    const { headers } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject,
        body: 'x',
      }),
    );
    const value = headers[1]!.replace('Subject: ', '');
    const words = value.split(' ');

    expect(words).toHaveLength(1);
    expect(value).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(
      Buffer.from(value.slice('=?UTF-8?B?'.length, -2), 'base64').toString(
        'utf8',
      ),
    ).toBe(subject);
  });

  it('encodes an ASCII subject that contains a literal encoded-word', () => {
    const subject = 'Re: =?UTF-8?Q?=41=42?= renewal';
    const { headers } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject,
        body: 'x',
      }),
    );
    const value = headers[1]!.replace('Subject: ', '');

    expect(value).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(
      Buffer.from(value.slice('=?UTF-8?B?'.length, -2), 'base64').toString(
        'utf8',
      ),
    ).toBe(subject);
  });

  it('splits a long non-ASCII subject into folded encoded-words', () => {
    // Two ASCII bytes first, so byte 39 falls inside a two-byte character and
    // a byte-based slicer would split it.
    const subject = `ab${'á'.repeat(60)}`;
    const { decoded, headers } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject,
        body: 'x',
      }),
    );
    const words = headers[1]!.replace('Subject: ', '').split(' ');

    expect(words.length).toBeGreaterThanOrEqual(2);

    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }

    const subjectLines = decoded
      .split('\r\n')
      .filter((line) => line.includes('=?UTF-8?B?'));
    const continuations = subjectLines.slice(1);

    expect(subjectLines[0]).toMatch(/^Subject: =\?UTF-8\?B\?/);
    expect(continuations).toHaveLength(words.length - 1);

    // RFC 2047 limits every line holding an encoded-word, including the
    // first one after "Subject: ", to 76 characters.
    for (const line of subjectLines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }

    for (const line of continuations) {
      expect(line).toMatch(/^ =\?UTF-8\?B\?/);
    }

    // Each word must decode on its own: a split code point would show up as
    // a replacement character.
    const parts = words.map((word) =>
      Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString(
        'utf8',
      ),
    );

    for (const part of parts) {
      expect(part).not.toContain('\uFFFD');
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(39);
    }

    expect(parts.join('')).toBe(subject);
  });

  it('collapses CR, LF, and tabs in header values so nothing can be injected', () => {
    const { headers } = parse(
      buildRawMessage({
        to: '  landlord@example.com\r\nBcc:\tevil@example.com  ',
        subject: 'Rent\r\n\tdue\nnow',
        body: 'x',
      }),
    );

    expect(headers).toEqual([
      'To: landlord@example.com Bcc: evil@example.com',
      'Subject: Rent due now',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
  });

  it('wraps the encoded body at 76 characters with CRLF endings', () => {
    const text = 'a'.repeat(300);
    const { decoded, bodyRegion, body } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject: 'Rent',
        body: text,
      }),
    );
    const lines = bodyRegion.split('\r\n').filter(Boolean);

    expect(lines.length).toBeGreaterThan(1);

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }

    expect(body).toBe(text);
    expect(decoded).not.toMatch(/[^\r]\n/);
    expect(decoded).not.toMatch(/\r[^\n]/);
    expect(decoded.endsWith('\r\n')).toBe(true);
  });

  it('normalises bare CR and LF in the body to CRLF', () => {
    const { body } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject: 'Rent',
        body: 'a\rb\r\nc\nd',
      }),
    );

    expect(body).toBe('a\r\nb\r\nc\r\nd');
  });

  it('keeps the header separator for an empty body', () => {
    const { decoded, bodyRegion } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject: 'Rent',
        body: '',
      }),
    );

    expect(bodyRegion).toBe('');
    expect(decoded.endsWith('\r\n\r\n')).toBe(true);
  });

  it('folds a long References header onto one line per message id', () => {
    const ids = Array.from(
      { length: 30 },
      (_unused, index) => `<${String(index).padStart(58, 'a')}>`,
    );
    const unfolded = ids.join(' ');
    const { decoded, headers } = parse(
      buildRawMessage({
        to: 'landlord@example.com',
        subject: 'Rent',
        body: 'x',
        references: ids,
      }),
    );

    expect(unfolded.length).toBeGreaterThan(998);
    expect(headers).toContain(`References: ${unfolded}`);

    for (const line of decoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }

    const continuations = decoded
      .split('\r\n')
      .filter((line) => line.startsWith(' '));

    expect(continuations).toHaveLength(ids.length - 1);

    for (const line of continuations) {
      expect(line.startsWith('  ')).toBe(false);
    }
  });
});
