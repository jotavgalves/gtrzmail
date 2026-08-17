import type { AppEnv, SessionUser } from './env';
import { json } from './http';

type MessageContactRow = {
  direction: 'inbound' | 'outbound';
  from_name: string | null;
  from_address: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  received_at: number;
};

type ContactAccumulator = {
  address: string;
  name: string | null;
  count: number;
  lastUsedAt: number;
};

function parseAddresses(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function validAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

export async function listRecentContacts(env: AppEnv, user: SessionUser): Promise<Response> {
  const [rows, mailboxes] = await Promise.all([
    env.DB.prepare(
      `SELECT m.direction, m.from_name, m.from_address, m.to_json, m.cc_json, m.bcc_json, m.received_at
       FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
       WHERE mb.user_id = ? AND m.folder != 'drafts'
       ORDER BY m.received_at DESC
       LIMIT 500`
    ).bind(user.id).all<MessageContactRow>(),
    env.DB.prepare('SELECT address FROM mailboxes WHERE user_id = ?').bind(user.id).all<{ address: string }>()
  ]);

  const ownAddresses = new Set(mailboxes.results.map((row) => row.address.toLowerCase()));
  const contacts = new Map<string, ContactAccumulator>();

  const add = (rawAddress: string, name: string | null, timestamp: number) => {
    const address = validAddress(rawAddress);
    if (!address || ownAddresses.has(address)) return;
    const existing = contacts.get(address);
    if (existing) {
      existing.count += 1;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, timestamp);
      if (!existing.name && name?.trim()) existing.name = name.trim().slice(0, 120);
      return;
    }
    contacts.set(address, {
      address,
      name: name?.trim() ? name.trim().slice(0, 120) : null,
      count: 1,
      lastUsedAt: timestamp
    });
  };

  for (const row of rows.results) {
    if (row.direction === 'inbound') add(row.from_address, row.from_name, row.received_at);
    for (const address of parseAddresses(row.to_json)) add(address, null, row.received_at);
    for (const address of parseAddresses(row.cc_json)) add(address, null, row.received_at);
    for (const address of parseAddresses(row.bcc_json)) add(address, null, row.received_at);
  }

  const result = [...contacts.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, 120);

  return json({ contacts: result });
}
