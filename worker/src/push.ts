import { sendNotification, type PushSubscription as WebPushSubscription } from 'web-push-neo';
import type { AppEnv, SessionUser } from './env';
import { json, readJson } from './http';

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type SubscriptionPayload = {
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
};

export type PushMailPayload = {
  messageId: string;
  threadId?: string;
  title: string;
  body: string;
  fromAddress?: string;
};

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function pushConfigured(env: AppEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export async function pushPublicKey(env: AppEnv): Promise<Response> {
  if (!pushConfigured(env)) {
    return json({ configured: false, publicKey: null });
  }
  return json({ configured: true, publicKey: env.VAPID_PUBLIC_KEY });
}

export async function subscribePush(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  if (!pushConfigured(env)) return json({ error: 'Web Push ainda não foi configurado no servidor.' }, 503);

  let payload: SubscriptionPayload;
  try {
    payload = await readJson<SubscriptionPayload>(request);
  } catch {
    return json({ error: 'Inscrição push inválida.' }, 400);
  }

  const endpoint = (payload.endpoint || '').trim();
  const p256dh = (payload.keys?.p256dh || '').trim();
  const auth = (payload.keys?.auth || '').trim();
  if (!validEndpoint(endpoint) || !p256dh || !auth || endpoint.length > 4096 || p256dh.length > 512 || auth.length > 512) {
    return json({ error: 'Inscrição push inválida.' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare(
    'SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ? LIMIT 1'
  ).bind(user.id, endpoint).first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      'UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = ?, updated_at = ? WHERE id = ?'
    ).bind(p256dh, auth, request.headers.get('user-agent')?.slice(0, 500) || null, now, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      user.id,
      endpoint,
      p256dh,
      auth,
      request.headers.get('user-agent')?.slice(0, 500) || null,
      now,
      now
    ).run();
  }

  return json({ ok: true });
}

export async function unsubscribePush(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: { endpoint?: string };
  try {
    payload = await readJson<{ endpoint?: string }>(request);
  } catch {
    return json({ error: 'Solicitação inválida.' }, 400);
  }
  const endpoint = (payload.endpoint || '').trim();
  if (!endpoint) return json({ error: 'Endpoint não informado.' }, 400);
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .bind(user.id, endpoint)
    .run();
  return json({ ok: true });
}

async function deleteExpiredSubscription(env: AppEnv, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run();
}

export async function sendPushToUser(env: AppEnv, userId: string, payload: PushMailPayload): Promise<void> {
  if (!pushConfigured(env)) return;
  const result = await env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20'
  ).bind(userId).all<StoredSubscription>();
  if (!result.results.length) return;

  const body = JSON.stringify({
    type: 'mail.received',
    title: payload.title,
    body: payload.body,
    messageId: payload.messageId,
    threadId: payload.threadId || payload.messageId,
    fromAddress: payload.fromAddress || '',
    url: `/?message=${encodeURIComponent(payload.messageId)}`
  });

  const vapidDetails = {
    subject: env.APP_ORIGIN,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };

  await Promise.allSettled(result.results.map(async (subscription) => {
    const pushSubscription: WebPushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth
      }
    };

    try {
      await sendNotification(pushSubscription, body, {
        vapidDetails,
        TTL: 60 * 60 * 6,
        urgency: 'high',
        topic: `mail-${payload.messageId.replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'new'}`,
        signal: AbortSignal.timeout(8000)
      });
    } catch (error) {
      const statusCode = typeof error === 'object' && error && 'statusCode' in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) await deleteExpiredSubscription(env, subscription.id);
      else console.error(JSON.stringify({ level: 'warn', event: 'push.send_failed', statusCode }));
    }
  }));
}
