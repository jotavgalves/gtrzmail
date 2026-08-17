import {
  ApiError,
  mailApi,
  type FolderStats,
  type Mailbox,
  type MessageDetail,
  type MessageFilters,
  type MessageSummary,
  type User
} from './api';

type TimedValue<T> = { expiresAt: number; value: T };
type BootstrapPayload = {
  user: User;
  mailboxes: Mailbox[];
  messages: MessageSummary[];
  folders: FolderStats;
  error?: string;
};

const inflight = new Map<string, Promise<unknown>>();
const microcache = new Map<string, TimedValue<unknown>>();
const installedAt = Date.now();
let lastMessageTapAt = 0;
let initialMobileAutoOpenSuppressed = false;

function cachedCall<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = microcache.get(key) as TimedValue<T> | undefined;
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const promise = producer()
    .then((value) => {
      if (ttlMs > 0) microcache.set(key, { expiresAt: Date.now() + ttlMs, value });
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

function filterKey(filters: MessageFilters): string {
  return `${filters.starred ? 1 : 0}${filters.unread ? 1 : 0}${filters.hasAttachment ? 1 : 0}`;
}

function cachedSummary(id: string): MessageSummary | null {
  for (const [key, entry] of microcache.entries()) {
    if (!key.startsWith('list:') || entry.expiresAt <= Date.now()) continue;
    const value = entry.value as { messages?: MessageSummary[] };
    const found = value.messages?.find((message) => message.id === id);
    if (found) return found;
  }
  return null;
}

function lightweightDetail(summary: MessageSummary): MessageDetail {
  return {
    ...summary,
    cc: [],
    bcc: [],
    bodyText: '',
    bodyHtml: null,
    messageId: null,
    inReplyTo: null,
    references: [],
    attachments: []
  };
}

function shouldSuppressInitialMobileOpen(): boolean {
  if (initialMobileAutoOpenSuppressed) return false;
  if (!window.matchMedia('(max-width: 820px)').matches) return false;
  if (Date.now() - installedAt > 7000) return false;
  if (Date.now() - lastMessageTapAt < 1000) return false;
  if (new URL(window.location.href).searchParams.has('message')) return false;
  return true;
}

export function clearPerformanceReadCache(): void {
  for (const key of microcache.keys()) {
    if (key.startsWith('list:') || key === 'stats' || key.startsWith('thread:')) microcache.delete(key);
  }
}

async function bootstrapSession(fallback: typeof mailApi.session): Promise<{ user: User; mailboxes: Mailbox[] }> {
  try {
    const response = await fetch('/api/bootstrap', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({})) as Partial<BootstrapPayload>;

    if (response.status === 401) throw new ApiError(payload.error || 'Sessão expirada.', 401);
    if (!response.ok || !payload.user || !payload.mailboxes) return fallback();

    const expiresAt = Date.now() + 20_000;
    if (payload.messages) {
      microcache.set('list:inbox::000', { expiresAt, value: { messages: payload.messages } });
    }
    if (payload.folders) {
      microcache.set('stats', { expiresAt, value: { folders: payload.folders } });
    }
    return { user: payload.user, mailboxes: payload.mailboxes };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return fallback();
  }
}

export function installPerformanceTuning(): void {
  const originalSession = mailApi.session;
  const originalList = mailApi.list;
  const originalStats = mailApi.stats;
  const originalGet = mailApi.get;
  const originalThread = mailApi.thread;
  const originalAction = mailApi.action;
  const originalSend = mailApi.send;
  const originalDraft = mailApi.saveDraft;

  mailApi.session = () => cachedCall('session', 5000, () => bootstrapSession(originalSession));
  mailApi.stats = () => cachedCall('stats', 20000, originalStats);
  mailApi.list = (folder: string, query = '', filters: MessageFilters = {}) =>
    cachedCall(`list:${folder}:${query}:${filterKey(filters)}`, 20000, () => originalList(folder, query, filters));

  mailApi.get = (id: string) => {
    // App.tsx historically auto-selects the first row after boot. On mobile that
    // caused an unnecessary R2 decrypt/MIME parse before the user touched a mail.
    if (shouldSuppressInitialMobileOpen()) {
      const summary = cachedSummary(id);
      if (summary) {
        initialMobileAutoOpenSuppressed = true;
        queueMicrotask(() => document.querySelector<HTMLButtonElement>('.reader-back')?.click());
        return Promise.resolve({ message: lightweightDetail(summary) });
      }
    }

    return cachedCall(`message:${id}`, 60000, async () => {
      const result = await originalGet(id);
      microcache.delete('stats');
      return result;
    });
  };

  mailApi.thread = (threadId: string) => cachedCall(`thread:${threadId}`, 15000, () => originalThread(threadId));

  mailApi.action = async (...args: Parameters<typeof originalAction>) => {
    const result = await originalAction(...args);
    clearPerformanceReadCache();
    microcache.delete(`message:${args[0]}`);
    return result;
  };

  mailApi.send = async (...args: Parameters<typeof originalSend>) => {
    const result = await originalSend(...args);
    clearPerformanceReadCache();
    return result;
  };

  mailApi.saveDraft = async (...args: Parameters<typeof originalDraft>) => {
    const result = await originalDraft(...args);
    clearPerformanceReadCache();
    return result;
  };

  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.message-row')) lastMessageTapAt = Date.now();
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[aria-label="Atualizar"]')) clearPerformanceReadCache();
  }, true);
  window.addEventListener('gtrz-force-refresh', clearPerformanceReadCache);
}
