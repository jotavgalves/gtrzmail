import type { AppEnv, SessionUser } from './env';
import { json, readJson } from './http';

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

type ContactRow = {
  id: string;
  display_name: string;
  phone: string | null;
  notes: string;
  is_favorite: number;
  created_at: number;
  updated_at: number;
};

type ContactEmailRow = {
  id: string;
  contact_id: string;
  email: string;
  label: string;
  is_primary: number;
};

type ContactEmailInput = {
  email: string;
  label?: string;
  isPrimary?: boolean;
};

type ContactInput = {
  displayName?: string;
  phone?: string | null;
  notes?: string;
  favorite?: boolean;
  emails?: ContactEmailInput[];
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

function sanitizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeEmails(input: ContactEmailInput[] | undefined): Array<{ email: string; label: string; isPrimary: boolean }> {
  const result: Array<{ email: string; label: string; isPrimary: boolean }> = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(input) ? input.slice(0, 10) : []) {
    const email = validAddress(item?.email || '');
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push({
      email,
      label: sanitizeText(item?.label, 32) || 'E-mail',
      isPrimary: Boolean(item?.isPrimary)
    });
  }

  if (result.length && !result.some((item) => item.isPrimary)) result[0].isPrimary = true;
  if (result.filter((item) => item.isPrimary).length > 1) {
    let primarySeen = false;
    for (const item of result) {
      if (!item.isPrimary) continue;
      if (primarySeen) item.isPrimary = false;
      primarySeen = true;
    }
  }
  return result;
}

async function ownAddresses(env: AppEnv, user: SessionUser): Promise<Set<string>> {
  const mailboxes = await env.DB.prepare('SELECT address FROM mailboxes WHERE user_id = ?')
    .bind(user.id)
    .all<{ address: string }>();
  return new Set(mailboxes.results.map((row) => row.address.toLowerCase()));
}

async function recentContactsData(env: AppEnv, user: SessionUser, limit = 120): Promise<ContactAccumulator[]> {
  const [rows, own] = await Promise.all([
    env.DB.prepare(
      `SELECT m.direction, m.from_name, m.from_address, m.to_json, m.cc_json, m.bcc_json, m.received_at
       FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
       WHERE mb.user_id = ? AND m.folder != 'drafts'
       ORDER BY m.received_at DESC
       LIMIT 500`
    ).bind(user.id).all<MessageContactRow>(),
    ownAddresses(env, user)
  ]);

  const contacts = new Map<string, ContactAccumulator>();
  const add = (rawAddress: string, name: string | null, timestamp: number) => {
    const address = validAddress(rawAddress);
    if (!address || own.has(address)) return;
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

  return [...contacts.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, limit);
}

async function savedContactsData(env: AppEnv, user: SessionUser) {
  const [contacts, emails] = await Promise.all([
    env.DB.prepare(
      `SELECT id, display_name, phone, notes, is_favorite, created_at, updated_at
       FROM contacts
       WHERE user_id = ?
       ORDER BY is_favorite DESC, display_name COLLATE NOCASE ASC, updated_at DESC`
    ).bind(user.id).all<ContactRow>(),
    env.DB.prepare(
      `SELECT id, contact_id, email, label, is_primary
       FROM contact_emails
       WHERE user_id = ?
       ORDER BY is_primary DESC, created_at ASC`
    ).bind(user.id).all<ContactEmailRow>()
  ]);

  const byContact = new Map<string, ContactEmailRow[]>();
  for (const email of emails.results) {
    const list = byContact.get(email.contact_id) || [];
    list.push(email);
    byContact.set(email.contact_id, list);
  }

  return contacts.results.map((contact) => ({
    id: contact.id,
    displayName: contact.display_name,
    phone: contact.phone,
    notes: contact.notes,
    favorite: contact.is_favorite === 1,
    createdAt: contact.created_at,
    updatedAt: contact.updated_at,
    emails: (byContact.get(contact.id) || []).map((email) => ({
      id: email.id,
      email: email.email,
      label: email.label,
      isPrimary: email.is_primary === 1
    }))
  }));
}

export async function listRecentContacts(env: AppEnv, user: SessionUser): Promise<Response> {
  return json({ contacts: await recentContactsData(env, user) });
}

export async function listContacts(env: AppEnv, user: SessionUser): Promise<Response> {
  return json({ contacts: await savedContactsData(env, user) });
}

export async function suggestContacts(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(30, Math.max(5, Number(url.searchParams.get('limit') || 12) || 12));
  const [saved, recent] = await Promise.all([
    savedContactsData(env, user),
    recentContactsData(env, user, 120)
  ]);

  const suggestions: Array<{
    address: string;
    name: string | null;
    favorite: boolean;
    source: 'saved' | 'recent';
    contactId: string | null;
    count: number;
    lastUsedAt: number;
  }> = [];
  const seen = new Set<string>();

  for (const contact of saved) {
    for (const email of contact.emails) {
      const haystack = `${contact.displayName} ${email.email} ${contact.phone || ''}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;
      seen.add(email.email);
      suggestions.push({
        address: email.email,
        name: contact.displayName || null,
        favorite: contact.favorite,
        source: 'saved',
        contactId: contact.id,
        count: 0,
        lastUsedAt: contact.updatedAt
      });
    }
  }

  for (const contact of recent) {
    if (seen.has(contact.address)) continue;
    const haystack = `${contact.name || ''} ${contact.address}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    suggestions.push({
      address: contact.address,
      name: contact.name,
      favorite: false,
      source: 'recent',
      contactId: null,
      count: contact.count,
      lastUsedAt: contact.lastUsedAt
    });
  }

  suggestions.sort((a, b) =>
    Number(b.favorite) - Number(a.favorite) ||
    Number(b.source === 'saved') - Number(a.source === 'saved') ||
    b.lastUsedAt - a.lastUsedAt ||
    b.count - a.count ||
    (a.name || a.address).localeCompare(b.name || b.address)
  );

  return json({ suggestions: suggestions.slice(0, limit) });
}

async function assertContactOwner(env: AppEnv, user: SessionUser, contactId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM contacts WHERE id = ? AND user_id = ?')
    .bind(contactId, user.id)
    .first<{ id: string }>();
  return Boolean(row);
}

async function replaceEmails(
  env: AppEnv,
  user: SessionUser,
  contactId: string,
  emails: Array<{ email: string; label: string; isPrimary: boolean }>
) {
  const statements = [
    env.DB.prepare('DELETE FROM contact_emails WHERE contact_id = ? AND user_id = ?').bind(contactId, user.id)
  ];
  const now = Math.floor(Date.now() / 1000);
  for (const email of emails) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO contact_emails (id, contact_id, user_id, email, label, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), contactId, user.id, email.email, email.label, email.isPrimary ? 1 : 0, now)
    );
  }
  await env.DB.batch(statements);
}

export async function createContact(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const payload = await readJson<ContactInput>(request);
  const displayName = sanitizeText(payload.displayName, 120);
  const phone = sanitizeText(payload.phone, 40) || null;
  const notes = sanitizeText(payload.notes, 1000);
  const emails = normalizeEmails(payload.emails);
  if (!displayName && !emails.length) return json({ error: 'Informe um nome ou e-mail.' }, 400);
  if (!emails.length) return json({ error: 'Informe ao menos um e-mail válido.' }, 400);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO contacts (id, user_id, display_name, phone, notes, is_favorite, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, displayName, phone, notes, payload.favorite ? 1 : 0, now, now).run();
    await replaceEmails(env, user, id, emails);
    return json({ ok: true, id }, 201);
  } catch (error) {
    await env.DB.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').bind(id, user.id).run().catch(() => undefined);
    const message = error instanceof Error ? error.message : '';
    if (message.toLowerCase().includes('unique')) return json({ error: 'Esse e-mail já está salvo em outro contato.' }, 409);
    throw error;
  }
}

export async function updateContact(request: Request, env: AppEnv, user: SessionUser, contactId: string): Promise<Response> {
  if (!await assertContactOwner(env, user, contactId)) return json({ error: 'Contato não encontrado.' }, 404);
  const payload = await readJson<ContactInput>(request);
  const displayName = sanitizeText(payload.displayName, 120);
  const phone = sanitizeText(payload.phone, 40) || null;
  const notes = sanitizeText(payload.notes, 1000);
  const emails = normalizeEmails(payload.emails);
  if (!emails.length) return json({ error: 'Informe ao menos um e-mail válido.' }, 400);
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `UPDATE contacts
       SET display_name = ?, phone = ?, notes = ?, is_favorite = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(displayName, phone, notes, payload.favorite ? 1 : 0, now, contactId, user.id).run();
    await replaceEmails(env, user, contactId, emails);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.toLowerCase().includes('unique')) return json({ error: 'Esse e-mail já está salvo em outro contato.' }, 409);
    throw error;
  }
}

export async function setContactFavorite(request: Request, env: AppEnv, user: SessionUser, contactId: string): Promise<Response> {
  if (!await assertContactOwner(env, user, contactId)) return json({ error: 'Contato não encontrado.' }, 404);
  const payload = await readJson<{ favorite?: boolean }>(request);
  await env.DB.prepare('UPDATE contacts SET is_favorite = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(payload.favorite ? 1 : 0, Math.floor(Date.now() / 1000), contactId, user.id)
    .run();
  return json({ ok: true });
}

export async function deleteContact(env: AppEnv, user: SessionUser, contactId: string): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?')
    .bind(contactId, user.id)
    .run();
  if (!result.meta.changes) return json({ error: 'Contato não encontrado.' }, 404);
  return json({ ok: true });
}
