import type { AppEnv } from './env';
import {
  listSessionAccounts,
  logout,
  switchAccount
} from './auth';
import {
  changePasswordHardened,
  getSessionUserHardened,
  listUserSessions,
  revokeOtherSessions,
  revokeUserSession,
  sessionResponseHardened
} from './account-security';
import { downloadAttachmentHardened } from './attachment-security';
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
import {
  ipAccessGate,
  listBlockedIps,
  loginProtectionState,
  unblockIp
} from './ip-security';
import {
  finalizeKeyRotation,
  keyRotationStatus,
  prepareKeyRotation,
  rewrapKeyBatch
} from './key-rotation';
import { loginHardened } from './login-security';
import { messageStats } from './mail';
import { saveDraftRich } from './mail-rich';
import { runSecurityMaintenance } from './maintenance';
import { updateMessageActionRich } from './message-actions-rich';
import {
  deletePasskey,
  listPasskeys,
  loginOptions,
  registrationOptions,
  requireRecentStepUp,
  securityStatus,
  stepUpOptions,
  verifyLogin,
  verifyRegistration,
  verifyStepUp
} from './passkeys';
import { getSignature, updateSignature } from './profile';
import { pushPublicKey, subscribePush, unsubscribePush } from './push';
import { receiveEmailFast } from './receive-fast';
import { passwordStepUpHardened } from './reauth-security';
import { listAdminSecurityEvents, listSecurityEvents } from './security-events';
import { sendMessageGuarded } from './send-security';
import {
  getThreadedMessage,
  handleThreadedResendWebhook,
  listThreadedMessages,
  notifyLatestInbound
} from './thread-mail';
import { threadMessageIds } from './threads';

function processSecret(name: string): string | undefined {
  try {
    const value = Reflect.get(process.env, name);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function withRuntimeSecretFallbacks(env: AppEnv): AppEnv {
  const siteKey = env.TURNSTILE_SITE_KEY || processSecret('TURNSTILE_SITE_KEY');
  const secretKey = env.TURNSTILE_SECRET_KEY || processSecret('TURNSTILE_SECRET_KEY');
  if (!siteKey && !secretKey) return env;

  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'TURNSTILE_SITE_KEY' && siteKey) return siteKey;
      if (property === 'TURNSTILE_SECRET_KEY' && secretKey) return secretKey;
      return Reflect.get(target, property, receiver);
    }
  });
}

async function api(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: env.APP_NAME, time: new Date().toISOString() });
  }

  if (path === '/api/webhooks/resend') {
    if (request.method === 'POST') return handleThreadedResendWebhook(request, env);
    if (request.method === 'GET') return json({ ok: true, endpoint: 'resend-webhook', accepts: ['POST'] });
    return json({ error: 'Método não permitido.' }, 405, { allow: 'GET, POST' });
  }

  if (path === '/api/internal/key-rotation/status' && request.method === 'GET') return keyRotationStatus(request, env);
  if (path === '/api/internal/key-rotation/prepare' && request.method === 'POST') return prepareKeyRotation(request, env);
  if (path === '/api/internal/key-rotation/batch' && request.method === 'POST') return rewrapKeyBatch(request, env);
  if (path === '/api/internal/key-rotation/finalize' && request.method === 'POST') return finalizeKeyRotation(request, env);

  const requestOrigin = new URL(request.url).origin;
  const localOrigin = requestOrigin.startsWith('http://localhost:') || requestOrigin.startsWith('http://127.0.0.1:');
  if (!assertSameOrigin(request, localOrigin ? requestOrigin : env.APP_ORIGIN)) return json({ error: 'Origem não autorizada.' }, 403);

  if (path === '/api/auth/login-state' && request.method === 'GET') return loginProtectionState(request, env);
  if (path === '/api/auth/login' && request.method === 'POST') return loginHardened(request, env);
  if (path === '/api/auth/passkey/options' && request.method === 'POST') return loginOptions(request, env);
  if (path === '/api/auth/passkey/verify' && request.method === 'POST') return verifyLogin(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (path === '/api/session' && request.method === 'GET') return sessionResponseHardened(request, env);

  const user = await getSessionUserHardened(request, env);
  if (!user) return json({ error: 'Sessão expirada.' }, 401);

  if (path === '/api/bootstrap' && request.method === 'GET') return bootstrapApp(request, env, user);
  if (path === '/api/auth/accounts' && request.method === 'GET') return listSessionAccounts(request, env, user);
  if (path === '/api/auth/switch-account' && request.method === 'POST') return switchAccount(request, env, user);

  if (path === '/api/account/security' && request.method === 'GET') return securityStatus(request, env, user);
  if (path === '/api/account/security-events' && request.method === 'GET') return listSecurityEvents(env, user);
  if (path === '/api/account/reauth/password' && request.method === 'POST') return passwordStepUpHardened(request, env, user);
  if (path === '/api/account/reauth/passkey/options' && request.method === 'POST') return stepUpOptions(env, user);
  if (path === '/api/account/reauth/passkey/verify' && request.method === 'POST') return verifyStepUp(request, env, user);
  if (path === '/api/account/passkeys' && request.method === 'GET') return listPasskeys(env, user);
  if (path === '/api/account/passkeys/register/options' && request.method === 'POST') return registrationOptions(request, env, user);
  if (path === '/api/account/passkeys/register/verify' && request.method === 'POST') return verifyRegistration(request, env, user);
  const passkeyMatch = path.match(/^\/api\/account\/passkeys\/(.+)$/);
  if (passkeyMatch && request.method === 'DELETE') return deletePasskey(request, env, user, decodeURIComponent(passkeyMatch[1]));

  if (path === '/api/account/password' && request.method === 'POST') return changePasswordHardened(request, env, user);
  if (path === '/api/account/sessions' && request.method === 'GET') return listUserSessions(request, env, user);
  if (path === '/api/account/sessions/revoke-others' && request.method === 'POST') return revokeOtherSessions(request, env, user);
  const sessionMatch = path.match(/^\/api\/account\/sessions\/([a-f0-9]{64})$/i);
  if (sessionMatch && request.method === 'DELETE') return revokeUserSession(request, env, user, sessionMatch[1]);
  if (path === '/api/account/signature' && request.method === 'GET') return getSignature(env, user);
  if (path === '/api/account/signature' && request.method === 'POST') return updateSignature(request, env, user);

  if (path === '/api/push/public-key' && request.method === 'GET') return pushPublicKey(env);
  if (path === '/api/push/subscribe' && request.method === 'POST') return subscribePush(request, env, user);
  if (path === '/api/push/unsubscribe' && request.method === 'POST') return unsubscribePush(request, env, user);

  if (path === '/api/admin/accounts' && request.method === 'GET') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || listAccounts(env, user);
  }
  if (path === '/api/admin/security-events' && request.method === 'GET') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || listAdminSecurityEvents(env, user);
  }
  if (path === '/api/admin/blocked-ips' && request.method === 'GET') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || listBlockedIps(env, user);
  }
  const unblockIpMatch = path.match(/^\/api\/admin\/blocked-ips\/([a-f0-9]{64})$/i);
  if (unblockIpMatch && request.method === 'DELETE') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || unblockIp(env, user, unblockIpMatch[1]);
  }
  if (path === '/api/admin/accounts' && request.method === 'POST') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || createAccount(request, env, user);
  }
  if (path === '/api/admin/mailboxes' && request.method === 'POST') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || addMailbox(request, env, user);
  }
  const adminStatusMatch = path.match(/^\/api\/admin\/accounts\/([0-9a-f-]+)\/status$/i);
  if (adminStatusMatch && request.method === 'POST') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || setAccountStatus(request, env, user, adminStatusMatch[1]);
  }
  const adminPasswordMatch = path.match(/^\/api\/admin\/accounts\/([0-9a-f-]+)\/password$/i);
  if (adminPasswordMatch && request.method === 'POST') {
    const denied = await requireRecentStepUp(request, env, user);
    return denied || resetAccountPassword(request, env, user, adminPasswordMatch[1]);
  }

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
  if (path === '/api/messages/send' && request.method === 'POST') return sendMessageGuarded(request, env, user);
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
  if (attachmentMatch && request.method === 'GET') return downloadAttachmentHardened(request, env, user, attachmentMatch[1]);
  return json({ error: 'Rota não encontrada.' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const runtimeEnv = withRuntimeSecretFallbacks(env);
      const blocked = await ipAccessGate(request, runtimeEnv);
      if (blocked) return withSecurityHeaders(blocked);

      const url = new URL(request.url);
      const response = url.pathname.startsWith('/api/') ? await api(request, runtimeEnv) : await runtimeEnv.ASSETS.fetch(request);
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
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runSecurityMaintenance(env));
  }
} satisfies ExportedHandler<AppEnv>;