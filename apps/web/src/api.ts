export type User = {
  id: string;
  email: string;
  displayName: string;
};

export type Mailbox = {
  id: string;
  address: string;
  display_name: string;
  is_default: number;
};

export type MessageSummary = {
  id: string;
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
  attachments: Attachment[];
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new ApiError(payload.error || 'Falha na comunicação com o GTRZ Mail.', response.status);
  return payload;
}

export const mailApi = {
  session: () => apiFetch<{ user: User; mailboxes: Mailbox[] }>('/api/session'),
  login: (email: string, password: string) => apiFetch<{ user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  }),
  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  list: (folder: string, query = '') => apiFetch<{ messages: MessageSummary[] }>(
    `/api/messages?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(query)}`
  ),
  get: (id: string) => apiFetch<{ message: MessageDetail }>(`/api/messages/${id}`),
  action: (id: string, action: 'read' | 'star' | 'trash' | 'archive', value?: boolean) =>
    apiFetch<{ ok: boolean }>(`/api/messages/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ value })
    }),
  send: (payload: unknown) => apiFetch<{ ok: boolean; messageId: string; providerId: string; status: string }>('/api/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
};
