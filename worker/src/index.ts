import type { AppEnv } from './env';
import {
  changePassword,
  getSessionUser,
  listSessionAccounts,
  login,
  logout,
  sessionResponse,
  switchAccount
} from './auth';
import {
  addMailbox,
  createAccount,
  listAccounts,
  resetAccountPassword,
  setAccountStatus
} from './admin';
import { bootstrapApp } from './bootstrap';
import {
  createContact,
  deleteContact,
  listContacts,
  listRecentContacts,
  setContactFavorite,
  suggestContacts,
  updateContact
} from './contacts';
import { assertSameOrigin, json, readJson, withSecurityHeaders } from './http';
import { messageStats } from './mail';
import {
  downloadAttachmentRich,
  saveDraftRich,
  sendMessageRich
} from './mail-rich';
import { updateMessageActionRich } from './message-actions-rich';
import { getSignature, updateSignature } from './profile';
import { pushPublicKey, subscribePush, unsubscribePush } from './push';
import { receiveEmailFast } from './receive-fast';
import {
  getThreadedMessage,
  handleThreadedResendWebhook,
  listThreadedMessages,
  notifyLatestInbound
} from './thread-mail';
import { threadMessageIds } from './threads';

async function api(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: env.APP_NAME, time: new Date().toISOString() });
  }

  if (path === '/api/webhooks/resend') {
    if (request.method === 'POST') return handleThreadedResendWebhook(request, env);
    if (request.method === 'GET') {
      return json({ ok: true, endpoint: 'resend-webhook', accepts: ['POST'], message: 'Endpoint ativo. O Resend envia eventos para esta URL via POST assinado.' });
    }
    return json({ error: 'Método não permitido.' }, 405, { allow: 'GET, POST' });
  }

  const requestOrigin = new URL(request.url).origin;
  const localOrigin = requestOrigin.startsWith('http://localhost:') || requestOrigin.startsWith('http://127.0.0.1:');
  if (!assertSameOrigin(request, localOrigin ? requestOrigin : env.APP_ORIGIN)) return json({ error: 'Origem não autorizada.' }, 403);

  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (path === '/api/session' && request.method === 'GET') return sessionResponse(request, env);

  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Sessão expirada.' }, 401);

  if (path === '/api/bootstrap' && request.method === 'GET') return bootstrapApp(request, env, user);
  if (path === '/api/auth/accounts' && request.method === 'GET') return listSessionAccounts(request, env, user);
  if (path === '/api/auth/switch-account' && request.method === 'POST') return switchAccount(request, env, user);
  if (path === '/api/account/password' && request.method === 'POST') return changePassword(request, env, user);
  if (path === '/api/account/signature' && request.method === 'GET') return getSignature(env, user);
  if (path === '/api/account/signature' && request.method === 'POST') return updateSignature(request, env, user);

  if (path === '/api/push/public-key' && request.method === 'GET') return pushPublicKey(env);
  if (path === '/api/push/subscribe' && request.method === 'POST') return subscribePush(request, env, user);
  if (path === '/api/push/unsubscribe' && request.method === 'POST') return unsubscribePush(request, env, user);

  if (path === '/api/admin/accounts' && request.method === 'GET') return listAccounts(env, user);
  if (path === '/api/admin/accounts' && request.method === 'POST') return createAccount(request, env, user);
  if (path === '/api/admin/mailboxes' && request.method === 'POST') return addMailbox(request, env, user);

  const adminStatusMatch = path.match(/^\/api\/admin\/accounts\/([0-9a-f-]+)\/status$/i);
  if (adminStatusMatch && request.method === 'POST') return setAccountStatus(request, env, user, adminStatusMatch[1]);
  const adminPasswordMatch = path.match(/^\/api\/admin\/accounts\/([0-9a-f-]+)\/password$/i);
  if (adminPasswordMatch && request.method === 'POST') return resetAccountPassword(request, env, user, adminPasswordMatch[1]);

  if (path === '/api/contacts/recent' && request.method === 'GET') return listRecentContacts(env, user);
  if (path === '/api/contacts/suggest' && request.method === 'GET') return suggestContacts(request, env, user);
  if (path === '/api/contacts' && request.method === 'GET') return listContacts(env, user);
  if (path === '/api/contacts' && request.method === 'POST') return createContact(request, env, user);
  const contactFavoriteMatch = path.match(/^\/api\/contacts\/([0-9a-f-]+)\/favorite$/i);
  if (contactFavoriteMatch && request.method === 'POST') return setContactFavorite(request, env, user, contactFavoriteMatch[1]);
  const contactMatch = path.match(/^\/api\/contacts\/([0-9a-f-]+)$/i);
  if (contactMatch && request.method === 'PUT') return updateContact(request, env, user, contactMatch[1]);
  if (contactMatch && request.method === 'DELETE') return deleteContact(env, user, contactMatch[1]);

  if (path === '/api/messages' && request.method === 'GET') return listThreadedMessages(request, env, user);
  if (path === '/api/messages/stats' && request.method === 'GET') return messageStats(env, user);
  if (path === '/api/messages/send' && request.method === 'POST') return sendMessageRich(request, env, user);
  if (path === '/api/messages/draft' && request.method === 'POST') return saveDraftRich(request, env, user);

  const threadMatch = path.match(/^\/api\/threads\/([0-9a-f-]+)$/i);
  if (threadMatch && request.method === 'GET') return threadMessageIds(env, user, threadMatch[1]);
  const messageMatch = path.match(/^\/api\/messages\/([0-9a-f-]+)$/i);
  if (messageMatch && request.method === 'GET') return getThreadedMessage(env, user, messageMatch[1]);
  const actionMatch = path.match(/^\/api\/messages\/([0-9a-f-]+)\/(read|star|trash|archive|restore|delete)$/i);
  if (actionMatch && request.method === 'POST') {
    let value: boolean | undefined;
    if (actionMatch[2] === 'read' || actionMatch[2] === 'star') {
      try { value = (await readJson<{ value?: boolean }>(request)).value; } catch { value = true; }
    }
    return updateMessageActionRich(env, user, actionMatch[1], actionMatch[2] as 'read' | 'star' | 'trash' | 'archive' | 'restore' | 'delete', value);
  }
  const attachmentMatch = path.match(/^\/api\/attachments\/([0-9a-f-]+)$/i);
  if (attachmentMatch && request.method === 'GET') return downloadAttachmentRich(request, env, user, attachmentMatch[1]);
  return json({ error: 'Rota não encontrada.' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const response = url.pathname.startsWith('/api/') ? await api(request, env) : await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'request.failed', message: error instanceof Error ? error.message : 'Unknown error' }));
      return withSecurityHeaders(json({ error: 'Erro interno.' }, 500));
    }
  },
  async email(message, env, ctx): Promise<void> {
    try {
      await receiveEmailFast(message, env);
      ctx.waitUntil(notifyLatestInbound(env, message.to, message.from).catch((error) => {
        console.error(JSON.stringify({ level: 'warn', event: 'push.inbound_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
      }));
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'email.receive.failed', from: message.from, to: message.to, size: message.rawSize, message: error instanceof Error ? error.message : 'Unknown error' }));
      message.setReject('GTRZ Mail temporary processing error');
    }
  }
} satisfies ExportedHandler<AppEnv>;
