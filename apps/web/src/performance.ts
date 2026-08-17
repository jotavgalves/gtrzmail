import { mailApi, type MessageFilters } from './api';

type TimedValue<T> = { expiresAt: number; value: T };

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

export function clearPerformanceReadCache(): void {
  for (const key of microcache.keys()) {
    if (key.startsWith('list:') || key === 'stats' || key.startsWith('thread:')) microcache.delete(key);
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

  // The app currently polls every 15s. A short in-memory cache means alternate
  // poll cycles are free while explicit refreshes and data mutations invalidate it.
  // Nothing is persisted to localStorage/IndexedDB.
  mailApi.session = () => cachedCall('session', 5000, originalSession);
  mailApi.stats = () => cachedCall('stats', 20000, originalStats);
  mailApi.list = (folder: string, query = '', filters: MessageFilters = {}) =>
    cachedCall(`list:${folder}:${query}:${filterKey(filters)}`, 20000, () => originalList(folder, query, filters));
  mailApi.get = (id: string) => cachedCall(`message:${id}`, 60000, async () => {
    const result = await originalGet(id);
    // Opening a message can mark it read on the server.
    microcache.delete('stats');
    return result;
  });
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

  // Manual refresh must always bypass the microcache.
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[aria-label="Atualizar"]')) clearPerformanceReadCache();
  }, true);
  window.addEventListener('gtrz-force-refresh', clearPerformanceReadCache);
}
