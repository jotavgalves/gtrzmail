import type { AppEnv, SessionUser } from './env';
import { json } from './http';

type ThreadRow = {
  id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  thread_id: string | null;
  received_at: number;
};

const THREAD_RECONCILE_TTL_MS = 5 * 60 * 1000;
const reconciledAt = new Map<string, number>();
const reconciling = new Map<string, Promise<void>>();

function parseReferences(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function canonicalMessageId(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  const bracketed = trimmed.match(/<[^>]+>/)?.[0] || trimmed.split(/\s+/)[0] || '';
  return bracketed.replace(/^<|>$/g, '').trim().toLowerCase();
}

function referenceTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/<[^>]+>|[^\s]+/g) || [];
  return matches.map(canonicalMessageId).filter(Boolean);
}

async function updateThreadIds(env: AppEnv, changes: Array<{ id: string; threadId: string }>): Promise<void> {
  for (let offset = 0; offset < changes.length; offset += 80) {
    const chunk = changes.slice(offset, offset + 80);
    await env.DB.batch(chunk.map((change) =>
      env.DB.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').bind(change.threadId, change.id)
    ));
  }
}

async function reconcileUserThreads(env: AppEnv, userId: string): Promise<void> {
  const result = await env.DB.prepare(
    `SELECT m.id, m.message_id, m.in_reply_to, m.references_json, m.thread_id, m.received_at
     FROM messages m
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE mb.user_id = ?
     ORDER BY m.received_at ASC
     LIMIT 5000`
  ).bind(userId).all<ThreadRow>();

  if (!result.results.length) return;

  const rows = result.results;
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  const byMessageId = new Map<string, string>();
  const receivedAt = new Map<string, number>();

  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  const union = (a: string, b: string) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    const rankA = rank.get(rootA) || 0;
    const rankB = rank.get(rootB) || 0;
    if (rankA < rankB) [rootA, rootB] = [rootB, rootA];
    parent.set(rootB, rootA);
    if (rankA === rankB) rank.set(rootA, rankA + 1);
  };

  for (const row of rows) {
    parent.set(row.id, row.id);
    rank.set(row.id, 0);
    receivedAt.set(row.id, row.received_at);
    const messageId = canonicalMessageId(row.message_id);
    if (messageId && !byMessageId.has(messageId)) byMessageId.set(messageId, row.id);
  }

  for (const row of rows) {
    const refs = new Set<string>([
      ...referenceTokens(row.in_reply_to),
      ...parseReferences(row.references_json).flatMap(referenceTokens)
    ]);
    for (const ref of refs) {
      const other = byMessageId.get(ref);
      if (other) union(row.id, other);
    }
  }

  const components = new Map<string, string[]>();
  for (const row of rows) {
    const root = find(row.id);
    const members = components.get(root) || [];
    members.push(row.id);
    components.set(root, members);
  }

  const desired = new Map<string, string>();
  for (const members of components.values()) {
    members.sort((a, b) => (receivedAt.get(a) || 0) - (receivedAt.get(b) || 0) || a.localeCompare(b));
    const threadId = members[0];
    for (const id of members) desired.set(id, threadId);
  }

  const changes = rows
    .map((row) => ({ id: row.id, threadId: desired.get(row.id) || row.id, current: row.thread_id }))
    .filter((row) => row.current !== row.threadId)
    .map(({ id, threadId }) => ({ id, threadId }));

  if (changes.length) await updateThreadIds(env, changes);
}

export async function ensureUserThreads(env: AppEnv, userId: string, force = false): Promise<void> {
  const now = Date.now();
  const last = reconciledAt.get(userId) || 0;
  if (!force && now - last < THREAD_RECONCILE_TTL_MS) return;

  const running = reconciling.get(userId);
  if (running) {
    await running;
    if (!force) return;
  }

  const task = reconcileUserThreads(env, userId);
  reconciling.set(userId, task);
  try {
    await task;
    reconciledAt.set(userId, Date.now());
  } finally {
    if (reconciling.get(userId) === task) reconciling.delete(userId);
  }
}

export function invalidateUserThreads(userId: string): void {
  reconciledAt.delete(userId);
}

export async function threadMessageIds(env: AppEnv, user: SessionUser, threadId: string): Promise<Response> {
  await ensureUserThreads(env, user.id);
  const result = await env.DB.prepare(
    `SELECT m.id, m.folder, m.received_at
     FROM messages m
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE mb.user_id = ? AND COALESCE(m.thread_id, m.id) = ?
     ORDER BY m.received_at ASC
     LIMIT 100`
  ).bind(user.id, threadId).all<{ id: string; folder: string; received_at: number }>();

  return json({
    threadId,
    messages: result.results.map((row) => ({
      id: row.id,
      folder: row.folder,
      receivedAt: row.received_at
    }))
  });
}
