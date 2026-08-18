import { useEffect } from 'react';

const FRAME_MARKER = 'gtrz-mail-sandbox-frame';
const MOUNT_ANIMATION = 'gtrzMailBodyMounted';
const INLINE_ATTACHMENT_RE = /^\/api\/attachments\/[0-9a-f-]+\?inline=1$/i;
const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function sandboxDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none';"><style>html,body{margin:0;padding:0;background:transparent;color:#d9d9de;font:14px/1.6 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}body{padding:2px 6px 18px}img{max-width:100%;height:auto}table{max-width:100%;overflow:auto}a{color:#e8e8ec;word-break:break-word}</style></head><body>${body}</body></html>`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid image result'));
    reader.onerror = () => reject(reader.error || new Error('Could not read inline image'));
    reader.readAsDataURL(blob);
  });
}

async function inlineAuthenticatedImages(body: string): Promise<string> {
  const document = new DOMParser().parseFromString(body, 'text/html');
  const images = [...document.querySelectorAll<HTMLImageElement>('img[src]')];

  await Promise.all(images.map(async (image) => {
    const src = image.getAttribute('src') || '';
    if (!INLINE_ATTACHMENT_RE.test(src)) {
      image.removeAttribute('src');
      image.alt ||= 'Imagem bloqueada';
      return;
    }
    try {
      const response = await fetch(src, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Inline attachment unavailable');
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!SAFE_IMAGE_TYPES.has(contentType)) throw new Error('Unsafe inline image type');
      const blob = await response.blob();
      image.src = await blobToDataUrl(blob);
      image.removeAttribute('data-gtrz-remote-blocked');
    } catch {
      image.removeAttribute('src');
      image.alt ||= 'Imagem bloqueada';
    }
  }));
  return document.body.innerHTML;
}

async function harden(container: HTMLElement) {
  if (container.dataset.gtrzMailHardening === '1' || container.dataset.gtrzMailSandboxed === '1') return;
  const originalBody = container.innerHTML;
  if (!originalBody.trim()) return;
  container.dataset.gtrzMailHardening = '1';

  const body = await inlineAuthenticatedImages(originalBody);
  if (!container.isConnected || container.dataset.gtrzMailSandboxed === '1') return;

  const iframe = document.createElement('iframe');
  iframe.dataset.gtrzMailSandboxFrame = '1';
  iframe.className = FRAME_MARKER;
  iframe.title = 'Conteúdo isolado do e-mail';
  iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  iframe.referrerPolicy = 'no-referrer';
  iframe.srcdoc = sandboxDocument(body);

  container.replaceChildren(iframe);
  delete container.dataset.gtrzMailHardening;
  container.dataset.gtrzMailSandboxed = '1';
}

export default function MailSandboxEnhancer() {
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.rich-mail-body').forEach((element) => void harden(element));

    const mounted = (event: AnimationEvent) => {
      if (event.animationName !== MOUNT_ANIMATION) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains('rich-mail-body')) void harden(target);
    };

    document.addEventListener('animationstart', mounted);
    return () => document.removeEventListener('animationstart', mounted);
  }, []);
  return null;
}
