import type { AppEnv } from './env';
import { getSessionUser, login, logout, sessionResponse } from './auth';
import { assertSameOrigin, json, readJson, withSecurityHeaders } from './http';
import {
  downloadAttachment,
  getMessage,
  handleResendWebhook,
  listMessages,
  receiveEmail,
  sendMessage,
  updateMessageAction
} from './mail';

async function api(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: env.APP_NAME, time: new Date().toISOString() });
  }

  if (path === '/api/webhooks/resend' && request.method === 'POST') {
    return handleResendWebhook(request, env);
  }

  const requestOrigin = new URL(request.url).origin;
  const localOrigin = requestOrigin.startsWith('http://localhost:') || requestOrigin.startsWith('http://127.0.0.1:');
  if (!assertSameOrigin(request, localOrigin ? requestOrigin : env.APP_ORIGIN)) {
    return json({ error: 'Origem não autorizada.' }, 403);
  }

  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (path === '/api/session' && request.method === 'GET') return sessionResponse(request, env);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Sessão expirada.' }, 401);

  if (path === '/api/messages' && request.method === 'GET') return listMessages(request, env, user);
  if (path === '/api/messages/send' && request.method === 'POST') return sendMessage(request, env, user);

  const messageMatch = path.match(/^\/api\/messages\/([0-9a-f-]+)$/i);
  if (messageMatch && request.method === 'GET') return getMessage(env, user, messageMatch[1]);

  const actionMatch = path.match(/^\/api\/messages\/([0-9a-f-]+)\/(read|star|trash|archive)$/i);
  if (actionMatch && request.method === 'POST') {
    let value: boolean | undefined;
    if (actionMatch[2] === 'read' || actionMatch[2] === 'star') {
      try {
        const payload = await readJson<{ value?: boolean }>(request);
        value = payload.value;
      } catch {
        value = true;
      }
    }
    return updateMessageAction(env, user, actionMatch[1], actionMatch[2] as 'read' | 'star' | 'trash' | 'archive', value);
  }

  const attachmentMatch = path.match(/^\/api\/attachments\/([0-9a-f-]+)$/i);
  if (attachmentMatch && request.method === 'GET') return downloadAttachment(env, user, attachmentMatch[1]);

  return json({ error: 'Rota não encontrada.' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const response = url.pathname.startsWith('/api/')
        ? await api(request, env)
        : await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'request.failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
      return withSecurityHeaders(json({ error: 'Erro interno.' }, 500));
    }
  },

  async email(message, env): Promise<void> {
    try {
      await receiveEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'email.receive.failed',
        from: message.from,
        to: message.to,
        size: message.rawSize,
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
      message.setReject('GTRZ Mail temporary processing error');
    }
  }
} satisfies ExportedHandler<AppEnv>;
