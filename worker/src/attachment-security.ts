import type { AppEnv, SessionUser } from './env';
import { downloadAttachmentRich } from './mail-rich';

const SAFE_INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript'
]);

export async function downloadAttachmentHardened(
  request: Request,
  env: AppEnv,
  user: SessionUser,
  attachmentId: string
): Promise<Response> {
  const response = await downloadAttachmentRich(request, env, user, attachmentId);
  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  const contentType = (headers.get('content-type') || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const wantsInline = new URL(request.url).searchParams.get('inline') === '1';
  const safeInline = wantsInline && SAFE_INLINE_IMAGE_TYPES.has(contentType);

  if (!safeInline) {
    const disposition = headers.get('content-disposition') || 'attachment';
    headers.set('content-disposition', disposition.replace(/^inline\b/i, 'attachment'));
    if (ACTIVE_CONTENT_TYPES.has(contentType)) headers.set('content-type', 'application/octet-stream');
    headers.set('content-security-policy', "sandbox; default-src 'none'; form-action 'none'; frame-ancestors 'none'");
  }

  headers.set('cache-control', 'private, no-store, max-age=0');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-download-options', 'noopen');
  headers.set('referrer-policy', 'no-referrer');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
