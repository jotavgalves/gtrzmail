import sanitizeHtml, { type IOptions } from 'sanitize-html';

export type InlineHtmlImage = {
  filename: string;
  mimeType: string;
  contentBase64: string;
  contentId: string;
};

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i;
const CID_RE = /^[A-Za-z0-9._@-]{1,127}$/;

const allowedStyles: NonNullable<IOptions['allowedStyles']> = {
  '*': {
    color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]{3,20}$/i],
    'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]{3,20}$/i],
    'font-size': [/^\d{1,3}(?:px|pt|em|rem|%)$/i],
    'font-family': [/^[\w\s,'".-]{1,120}$/],
    'font-weight': [/^(?:normal|bold|[1-9]00)$/i],
    'font-style': [/^(?:normal|italic|oblique)$/i],
    'text-decoration': [/^(?:none|underline|line-through|underline line-through)$/i],
    'text-align': [/^(?:left|right|center|justify)$/i],
    'line-height': [/^(?:normal|\d(?:\.\d+)?|\d{1,3}(?:px|pt|em|rem|%))$/i]
  },
  img: {
    width: [/^(?:auto|\d{1,4}px|\d{1,3}%)$/i],
    height: [/^(?:auto|\d{1,4}px)$/i],
    'max-width': [/^(?:\d{1,3}%|\d{1,4}px)$/i],
    display: [/^(?:inline|inline-block|block)$/i],
    margin: [/^[\d\s.auto%-]{1,40}$/i]
  },
  table: {
    width: [/^(?:auto|\d{1,4}px|\d{1,3}%)$/i],
    'border-collapse': [/^(?:collapse|separate)$/i]
  },
  td: {
    padding: [/^[\d\s.%a-z-]{1,40}$/i],
    'text-align': [/^(?:left|right|center|justify)$/i],
    'vertical-align': [/^(?:top|middle|bottom)$/i]
  },
  th: {
    padding: [/^[\d\s.%a-z-]{1,40}$/i],
    'text-align': [/^(?:left|right|center|justify)$/i],
    'vertical-align': [/^(?:top|middle|bottom)$/i]
  }
};

function options(allowDataImages: boolean, transformInlineImages?: (mimeType: string, base64: string) => string): IOptions {
  return {
    allowedTags: [
      'p', 'div', 'span', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
      'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'h1', 'h2', 'h3', 'pre', 'code',
      'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'center'
    ],
    allowedAttributes: {
      '*': ['style'],
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      table: ['width', 'border', 'cellpadding', 'cellspacing', 'align'],
      td: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign'],
      th: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign'],
      blockquote: ['data-gtrz-quote'],
      div: ['data-gtrz-signature', 'data-gtrz-forward']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', ...(allowDataImages ? ['data'] : [])],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
      img: ['http', 'https', 'cid', ...(allowDataImages ? ['data'] : [])]
    },
    allowedStyles,
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    parser: { lowerCaseTags: true },
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      }),
      img: (_tagName, attribs) => {
        const src = attribs.src || '';
        const dataMatch = DATA_IMAGE_RE.exec(src);
        if (dataMatch) {
          if (!allowDataImages) {
            const { src: _ignored, ...rest } = attribs;
            return { tagName: 'img', attribs: rest };
          }
          if (transformInlineImages) {
            const mimeType = `image/${dataMatch[1].toLowerCase() === 'jpeg' ? 'jpeg' : dataMatch[1].toLowerCase()}`;
            const contentId = transformInlineImages(mimeType, dataMatch[2].replace(/\s+/g, ''));
            return { tagName: 'img', attribs: { ...attribs, src: `cid:${contentId}` } };
          }
          return { tagName: 'img', attribs };
        }

        if (src.toLowerCase().startsWith('cid:')) {
          const cid = src.slice(4);
          if (!CID_RE.test(cid)) {
            const { src: _ignored, ...rest } = attribs;
            return { tagName: 'img', attribs: rest };
          }
        }
        return { tagName: 'img', attribs };
      }
    }
  };
}

export function sanitizeEmailHtml(input: string, allowDataImages = false): string {
  return sanitizeHtml(input.slice(0, 8_000_000), options(allowDataImages));
}

export function sanitizeSignatureHtml(input: string): string {
  const signatureOptions = options(false);
  return sanitizeHtml(input.slice(0, 100_000), {
    ...signatureOptions,
    allowedTags: (signatureOptions.allowedTags || []).filter((tag) => tag !== 'img')
  });
}

export function prepareOutboundHtml(input: string): { html: string; inlineImages: InlineHtmlImage[] } {
  const inlineImages: InlineHtmlImage[] = [];
  const html = sanitizeHtml(
    input.slice(0, 8_000_000),
    options(true, (mimeType, contentBase64) => {
      const contentId = `gtrz-${crypto.randomUUID()}`;
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
      inlineImages.push({
        filename: `imagem-${inlineImages.length + 1}.${extension}`,
        mimeType,
        contentBase64,
        contentId
      });
      return contentId;
    })
  );
  return { html, inlineImages };
}

export function plainTextToHtml(input: string): string {
  const escaped = input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped.replace(/\r?\n/g, '<br>');
}
