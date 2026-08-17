export type User = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type Mailbox = {
  id: string;
  address: string;
  display_name: string;
  is_default: number;
};

export type MessageSummary = {
  id: string;
  threadId?: string;
  threadCount?: number;
  direction: string;
  folder: string;
  fromName: string | null;
  fromAddress: string;
  to: string[];
  subject: string;
  preview: string;
  isRead: boolean;
  isStarred: boolean;
  sentStatus: string | null;
  receivedAt: number;
  attachmentCount: number;
};

export type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentId: string | null;
  disposition: string | null;
};

export type MessageDetail = MessageSummary & {
  cc: string[];
  bcc: string[];
  bodyText: string;
  bodyHtml: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: Attachment[];
};

export type MessageFilters = {
  starred?: boolean;
  unread?: boolean;
  hasAttachment?: boolean;
};

export type FolderStats = Record<string, { total: number; unread: number }>;

export type RecentContact = {
  address: string;
  name: string | null;
  count: number;
  lastUsedAt: number;
};

export type SessionAccount = User & {
  current: boolean;
};

export type AdminMailbox = {
  id: string;
  address: string;
  displayName: string;
  isDefault: boolean;
};

export type AdminAccount = {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  createdAt: number;
  mailboxes: AdminMailbox[];
};

export type BrowserPushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function reportApiError(path: string, message: string, status: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('gtrz-api-error', {
    detail: { path, message, status }
  }));
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers || {})
      }
    });
  } catch {
    const message = 'Sem conexão com o GTRZ Mail. Verifique a internet e tente novamente.';
    reportApiError(path, message, 0);
    throw new ApiError(message, 0);
  }

  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    const message = payload.error || 'Falha na comunicação com o GTRZ Mail.';
    reportApiError(path, message, response.status);
    throw new ApiError(message, response.status);
  }
  return payload;
}

export const mailApi = {
  session: () => apiFetch<{ user: User; mailboxes: Mailbox[] }>('/api/session'),
  login: (email: string, password: string) => apiFetch<{ user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  }),
  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  sessionAccounts: () => apiFetch<{ accounts: SessionAccount[] }>('/api/auth/accounts'),
  switchAccount: (userId: string) => apiFetch<{ ok: boolean; user: User }>('/api/auth/switch-account', {
    method: 'POST',
    body: JSON.stringify({ userId })
  }),
  changePassword: (currentPassword: string, newPassword: string) => apiFetch<{ ok: boolean }>('/api/account/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword })
  }),
  signature: () => apiFetch<{ html: string }>('/api/account/signature'),
  updateSignature: (html: string) => apiFetch<{ ok: boolean; html: string }>('/api/account/signature', {
    method: 'POST',
    body: JSON.stringify({ html })
  }),
  pushPublicKey: () => apiFetch<{ configured: boolean; publicKey: string | null }>('/api/push/public-key'),
  pushSubscribe: (subscription: BrowserPushSubscription) => apiFetch<{ ok: boolean }>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription)
  }),
  pushUnsubscribe: (endpoint: string) => apiFetch<{ ok: boolean }>('/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint })
  }),
  contacts: () => apiFetch<{ contacts: RecentContact[] }>('/api/contacts'),
  list: (folder: string, query = '', filters: MessageFilters = {}) => {
    const params = new URLSearchParams({ folder, q: query });
    if (filters.starred) params.set('starred', '1');
    if (filters.unread) params.set('unread', '1');
    if (filters.hasAttachment) params.set('hasAttachment', '1');
    return apiFetch<{ messages: MessageSummary[] }>(`/api/messages?${params.toString()}`);
  },
  stats: () => apiFetch<{ folders: FolderStats }>('/api/messages/stats'),
  get: (id: string) => apiFetch<{ message: MessageDetail }>(`/api/messages/${id}`),
  thread: (threadId: string) => apiFetch<{ threadId: string; messages: Array<{ id: string; folder: string; receivedAt: number }> }>(`/api/threads/${threadId}`),
  action: (id: string, action: 'read' | 'star' | 'trash' | 'archive' | 'restore' | 'delete', value?: boolean) =>
    apiFetch<{ ok: boolean }>(`/api/messages/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ value })
    }),
  saveDraft: (payload: unknown) => apiFetch<{ ok: boolean; id: string; savedAt: number }>('/api/messages/draft', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  send: (payload: unknown) => apiFetch<{ ok: boolean; messageId: string; providerId: string; status: string }>('/api/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  adminAccounts: () => apiFetch<{ accounts: AdminAccount[] }>('/api/admin/accounts'),
  createAccount: (payload: { email: string; displayName: string; password: string }) => apiFetch<{ ok: boolean; id: string; mailboxId: string }>('/api/admin/accounts', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  addMailbox: (payload: { userId: string; address: string; displayName: string }) => apiFetch<{ ok: boolean; id: string }>('/api/admin/mailboxes', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  setAccountStatus: (id: string, active: boolean) => apiFetch<{ ok: boolean }>(`/api/admin/accounts/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ active })
  }),
  resetAccountPassword: (id: string, password: string) => apiFetch<{ ok: boolean }>(`/api/admin/accounts/${id}/password`, {
    method: 'POST',
    body: JSON.stringify({ password })
  })
};
