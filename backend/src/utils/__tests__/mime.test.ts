import { describe, expect, it } from 'vitest';

import {
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
