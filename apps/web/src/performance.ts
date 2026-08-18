import {
  ApiError,
  mailApi,
  type FolderStats,
  type Mailbox,
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

function clearAllCache() {
  microcache.clear();
  inflight.clear();
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
    if (payload.messages) microcache.set('list:inbox::000', { expiresAt, value: { messages: payload.messages } });
    if (payload.folders) microcache.set('stats', { expiresAt, value: { folders: payload.folders } });
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
  const originalLogin = mailApi.login;
  const originalLogout = mailApi.logout;
  const originalSwitchAccount = mailApi.switchAccount;

  mailApi.session = () => cachedCall('session', 5000, () => bootstrapSession(originalSession));
  mailApi.stats = () => cachedCall('stats', 20_000, originalStats);
  mailApi.list = (folder: string, query = '', filters: MessageFilters = {}) =>
    cachedCall(`list:${folder}:${query}:${filterKey(filters)}`, 20_000, () => originalList(folder, query, filters));
  mailApi.get = (id: string) => cachedCall(`message:${id}`, 60_000, async () => {
    const result = await originalGet(id);
    microcache.delete('stats');
    return result;
  });
  mailApi.thread = (threadId: string) => cachedCall(`thread:${threadId}`, 15_000, () => originalThread(threadId));

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

  mailApi.login = async (...args: Parameters<typeof originalLogin>) => {
    clearAllCache();
    const result = await originalLogin(...args);
    clearAllCache();
    return result;
  };

  mailApi.logout = async (...args: Parameters<typeof originalLogout>) => {
    const result = await originalLogout(...args);
    clearAllCache();
    return result;
  };

  mailApi.switchAccount = async (...args: Parameters<typeof originalSwitchAccount>) => {
    clearAllCache();
    const result = await originalSwitchAccount(...args);
    clearAllCache();
    return result;
  };

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[aria-label="Atualizar"]')) clearPerformanceReadCache();
  }, true);
  window.addEventListener('gtrz-force-refresh', clearPerformanceReadCache);
}
