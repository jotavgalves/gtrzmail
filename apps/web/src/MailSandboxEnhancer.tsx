import { useEffect } from 'react';

const FRAME_MARKER = 'gtrz-mail-sandbox-frame';

function sandboxDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self';"><style>html,body{margin:0;padding:0;background:transparent;color:inherit;font:inherit;overflow-wrap:anywhere}body{padding:2px}img{max-width:100%;height:auto}table{max-width:100%}a{word-break:break-word}</style></head><body>${body}</body></html>`;
}

function harden(container: HTMLElement) {
  const existing = container.firstElementChild as HTMLElement | null;
  if (existing?.dataset.gtrzMailSandboxFrame === '1') return;

  const body = container.innerHTML;
  if (!body.trim()) return;

  const iframe = document.createElement('iframe');
  iframe.dataset.gtrzMailSandboxFrame = '1';
  iframe.className = FRAME_MARKER;
  iframe.title = 'Conteúdo isolado do e-mail';
  iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  iframe.referrerPolicy = 'no-referrer';
  iframe.srcdoc = sandboxDocument(body);

  const resize = () => {
    try {
      const height = iframe.contentDocument?.documentElement.scrollHeight || 0;
      if (height > 0) iframe.style.height = `${Math.min(Math.max(height + 12, 180), 1100)}px`;
    } catch {
      iframe.style.height = '520px';
    }
  };
  iframe.addEventListener('load', () => {
    resize();
    window.setTimeout(resize, 300);
    window.setTimeout(resize, 1000);
  });

  container.replaceChildren(iframe);
  container.dataset.gtrzMailSandboxed = '1';
}

function inspect(node: Node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.rich-mail-body')) harden(node as HTMLElement);
  const parent = node.parentElement?.closest('.rich-mail-body');
  if (parent) harden(parent as HTMLElement);
  node.querySelectorAll<HTMLElement>('.rich-mail-body').forEach(harden);
}

export default function MailSandboxEnhancer() {
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.rich-mail-body').forEach(harden);
    const root = document.getElementById('root');
    if (!root) return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) inspect(node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
