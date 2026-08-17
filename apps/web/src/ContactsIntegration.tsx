import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Mail, Pencil, Phone, Plus, Save, Search, Star, Trash2, Users, X } from 'lucide-react';

type ContactEmail = { id?: string; email: string; label: string; isPrimary: boolean };
type SavedContact = {
  id: string;
  displayName: string;
  phone: string | null;
  notes: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  emails: ContactEmail[];
};
type Suggestion = {
  address: string;
  name: string | null;
  favorite: boolean;
  source: 'saved' | 'recent';
  contactId: string | null;
  count: number;
  lastUsedAt: number;
};
type ContactDraft = {
  id?: string;
  displayName: string;
  phone: string;
  notes: string;
  favorite: boolean;
  emails: Array<{ email: string; label: string; isPrimary: boolean }>;
};

async function contactFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || 'Não foi possível concluir a ação.');
  return payload;
}

function blankDraft(): ContactDraft {
  return {
    displayName: '',
    phone: '',
    notes: '',
    favorite: false,
    emails: [{ email: '', label: 'Principal', isPrimary: true }]
  };
}

function fromContact(contact: SavedContact): ContactDraft {
  return {
    id: contact.id,
    displayName: contact.displayName,
    phone: contact.phone || '',
    notes: contact.notes,
    favorite: contact.favorite,
    emails: contact.emails.length
      ? contact.emails.map((email) => ({ email: email.email, label: email.label, isPrimary: email.isPrimary }))
      : [{ email: '', label: 'Principal', isPrimary: true }]
  };
}

function isRecipientInput(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  const mobile = target.closest('.m-compose-row');
  const desktop = target.closest('.composer-field');
  const label = (mobile || desktop)?.querySelector('label')?.textContent?.trim().toLowerCase();
  return label === 'para' || label === 'cc' || label === 'cco';
}

function currentToken(value: string): string {
  const index = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  return value.slice(index + 1).trim();
}

function setReactInput(input: HTMLInputElement, address: string) {
  const value = input.value;
  const comma = value.lastIndexOf(',');
  const semicolon = value.lastIndexOf(';');
  const index = Math.max(comma, semicolon);
  const prefix = index >= 0 ? `${value.slice(0, index + 1)} ` : '';
  const next = `${prefix}${address}, `;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(next.length, next.length);
}

export default function ContactsIntegration() {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<SavedContact[]>([]);
  const [recent, setRecent] = useState<Suggestion[]>([]);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [activeInput, setActiveInput] = useState<HTMLInputElement | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionRect, setSuggestionRect] = useState<DOMRect | null>(null);
  const suggestTimer = useRef<number | null>(null);
  const requestSerial = useRef(0);

  const loadBook = async () => {
    setLoading(true);
    setError('');
    try {
      const [saved, suggested] = await Promise.all([
        contactFetch<{ contacts: SavedContact[] }>('/api/contacts'),
        contactFetch<{ suggestions: Suggestion[] }>('/api/contacts/suggest?limit=30')
      ]);
      setContacts(saved.contacts);
      setRecent(suggested.suggestions.filter((item) => item.source === 'recent'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os contatos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadBook();
  }, [open]);

  useEffect(() => {
    const scheduleSuggestions = (input: HTMLInputElement) => {
      setActiveInput(input);
      setSuggestionRect(input.getBoundingClientRect());
      const query = currentToken(input.value);
      if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
      const serial = ++requestSerial.current;
      suggestTimer.current = window.setTimeout(async () => {
        try {
          const result = await contactFetch<{ suggestions: Suggestion[] }>(`/api/contacts/suggest?q=${encodeURIComponent(query)}&limit=10`);
          if (serial !== requestSerial.current || document.activeElement !== input) return;
          setSuggestions(result.suggestions);
          setSuggestionIndex(0);
          setSuggestionRect(input.getBoundingClientRect());
        } catch {
          if (serial === requestSerial.current) setSuggestions([]);
        }
      }, query ? 100 : 60);
    };

    const focus = (event: FocusEvent) => {
      if (isRecipientInput(event.target)) scheduleSuggestions(event.target);
    };
    const input = (event: Event) => {
      if (isRecipientInput(event.target)) scheduleSuggestions(event.target);
    };
    const keydown = (event: KeyboardEvent) => {
      if (!activeInput || document.activeElement !== activeInput || !suggestions.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSuggestionIndex((value) => (value + 1) % suggestions.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSuggestionIndex((value) => (value - 1 + suggestions.length) % suggestions.length);
      } else if (event.key === 'Enter' && suggestions[suggestionIndex]) {
        event.preventDefault();
        setReactInput(activeInput, suggestions[suggestionIndex].address);
        setSuggestions([]);
      } else if (event.key === 'Escape') {
        setSuggestions([]);
      }
    };
    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.contact-suggestions') && target !== activeInput) setSuggestions([]);
    };
    const reposition = () => {
      if (activeInput && document.activeElement === activeInput) setSuggestionRect(activeInput.getBoundingClientRect());
    };

    document.addEventListener('focusin', focus, true);
    document.addEventListener('input', input, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', click, true);
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    return () => {
      if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('input', input, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', click, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [activeInput, suggestions, suggestionIndex]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((contact) =>
      `${contact.displayName} ${contact.phone || ''} ${contact.emails.map((email) => email.email).join(' ')}`.toLowerCase().includes(q)
    );
  }, [contacts, search]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const emails = draft.emails.filter((email) => email.email.trim());
    if (!emails.length) {
      setError('Informe ao menos um e-mail.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        displayName: draft.displayName,
        phone: draft.phone || null,
        notes: draft.notes,
        favorite: draft.favorite,
        emails
      };
      if (draft.id) {
        await contactFetch(`/api/contacts/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await contactFetch('/api/contacts', { method: 'POST', body: JSON.stringify(payload) });
      }
      setDraft(null);
      await loadBook();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o contato.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (contact: SavedContact) => {
    if (!window.confirm(`Excluir ${contact.displayName || contact.emails[0]?.email || 'este contato'}?`)) return;
    setError('');
    try {
      await contactFetch(`/api/contacts/${contact.id}`, { method: 'DELETE' });
      setContacts((items) => items.filter((item) => item.id !== contact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível excluir o contato.');
    }
  };

  const toggleFavorite = async (contact: SavedContact) => {
    const favorite = !contact.favorite;
    setContacts((items) => items.map((item) => item.id === contact.id ? { ...item, favorite } : item));
    try {
      await contactFetch(`/api/contacts/${contact.id}/favorite`, { method: 'POST', body: JSON.stringify({ favorite }) });
    } catch {
      setContacts((items) => items.map((item) => item.id === contact.id ? { ...item, favorite: !favorite } : item));
    }
  };

  const editEmail = (index: number, patch: Partial<ContactDraft['emails'][number]>) => {
    setDraft((current) => {
      if (!current) return current;
      const emails = current.emails.map((email, itemIndex) => itemIndex === index ? { ...email, ...patch } : email);
      if (patch.isPrimary) emails.forEach((email, itemIndex) => { email.isPrimary = itemIndex === index; });
      return { ...current, emails };
    });
  };

  const suggestionStyle = suggestionRect ? {
    left: Math.max(8, Math.min(suggestionRect.left, window.innerWidth - Math.min(420, Math.max(280, suggestionRect.width)) - 8)),
    top: Math.min(suggestionRect.bottom + 5, window.innerHeight - 300),
    width: Math.min(420, Math.max(280, suggestionRect.width))
  } : undefined;

  return <>
    <button className="contacts-launcher" onClick={() => setOpen(true)} aria-label="Contatos"><Users size={19} /><span>Contatos</span></button>

    {suggestions.length > 0 && activeInput && suggestionRect && <div className="contact-suggestions" style={suggestionStyle} role="listbox">
      {suggestions.map((suggestion, index) => <button
        type="button"
        key={`${suggestion.source}-${suggestion.contactId || suggestion.address}-${suggestion.address}`}
        className={index === suggestionIndex ? 'active' : ''}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          setReactInput(activeInput, suggestion.address);
          setSuggestions([]);
        }}
      >
        <span className="contact-suggestion-avatar">{(suggestion.name || suggestion.address).slice(0, 1).toUpperCase()}</span>
        <span><strong>{suggestion.name || suggestion.address}</strong><small>{suggestion.address}</small></span>
        {suggestion.favorite && <Star size={14} fill="currentColor" />}
        {!suggestion.favorite && suggestion.source === 'recent' && <em>recente</em>}
      </button>)}
    </div>}

    {open && <div className="contacts-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className="contacts-book" role="dialog" aria-modal="true" aria-label="Contatos">
        <header className="contacts-header">
          <div><Users size={20} /><span><strong>Contatos</strong><small>{contacts.length} salvo{contacts.length === 1 ? '' : 's'}</small></span></div>
          <div><button className="contacts-add" onClick={() => setDraft(blankDraft())}><Plus size={17} /> Novo</button><button className="contacts-icon" onClick={() => setOpen(false)} aria-label="Fechar"><X size={20} /></button></div>
        </header>

        {!draft && <>
          <div className="contacts-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nome, e-mail ou telefone" /></div>
          {error && <div className="contacts-error">{error}</div>}
          <div className="contacts-scroll">
            {loading && <div className="contacts-empty">Carregando contatos…</div>}
            {!loading && filtered.length === 0 && <div className="contacts-empty"><Users size={28} /><strong>Nenhum contato salvo</strong><span>Os endereços usados recentemente continuam disponíveis no autocomplete.</span></div>}
            {filtered.map((contact) => <article className="contact-card" key={contact.id}>
              <button className={`contact-star ${contact.favorite ? 'active' : ''}`} onClick={() => void toggleFavorite(contact)} aria-label="Favoritar"><Star size={17} fill={contact.favorite ? 'currentColor' : 'none'} /></button>
              <div className="contact-card-main"><strong>{contact.displayName || contact.emails[0]?.email}</strong>{contact.emails.map((email) => <span key={email.id || email.email}><Mail size={13} />{email.email}{email.isPrimary && <b>Principal</b>}</span>)}{contact.phone && <span><Phone size={13} />{contact.phone}</span>}</div>
              <div className="contact-card-actions"><button onClick={() => setDraft(fromContact(contact))} aria-label="Editar"><Pencil size={16} /></button><button className="danger" onClick={() => void remove(contact)} aria-label="Excluir"><Trash2 size={16} /></button></div>
            </article>)}

            {recent.length > 0 && <section className="contacts-recent"><h3>Recentes não salvos</h3>{recent.slice(0, 12).map((item) => <button key={item.address} onClick={() => setDraft({ ...blankDraft(), displayName: item.name || '', emails: [{ email: item.address, label: 'Principal', isPrimary: true }] })}><span><strong>{item.name || item.address}</strong><small>{item.address}</small></span><Plus size={16} /></button>)}</section>}
          </div>
        </>}

        {draft && <form className="contact-editor" onSubmit={save}>
          <div className="contact-editor-title"><button type="button" className="contacts-icon" onClick={() => { setDraft(null); setError(''); }}><X size={18} /></button><strong>{draft.id ? 'Editar contato' : 'Novo contato'}</strong><button className="contacts-save" disabled={saving}><Save size={16} />{saving ? 'Salvando…' : 'Salvar'}</button></div>
          {error && <div className="contacts-error">{error}</div>}
          <label>Nome<input value={draft.displayName} onChange={(event) => setDraft((current) => current ? { ...current, displayName: event.target.value } : current)} placeholder="Nome do contato" /></label>
          <label>Telefone <small>opcional</small><input type="tel" value={draft.phone} onChange={(event) => setDraft((current) => current ? { ...current, phone: event.target.value } : current)} placeholder="Telefone" /></label>
          <div className="contact-email-editor"><div className="contact-email-heading"><strong>E-mails</strong><button type="button" onClick={() => setDraft((current) => current ? { ...current, emails: [...current.emails, { email: '', label: 'Outro', isPrimary: false }] } : current)}><Plus size={15} /> Adicionar</button></div>
            {draft.emails.map((email, index) => <div className="contact-email-row" key={index}>
              <input className="email-address" type="email" value={email.email} onChange={(event) => editEmail(index, { email: event.target.value })} placeholder="email@exemplo.com" required={index === 0} />
              <input className="email-label" value={email.label} onChange={(event) => editEmail(index, { label: event.target.value })} placeholder="Rótulo" />
              <label className="primary-radio" title="Definir como principal"><input type="radio" name="primary-email" checked={email.isPrimary} onChange={() => editEmail(index, { isPrimary: true })} /><span>Principal</span></label>
              {draft.emails.length > 1 && <button type="button" className="remove-email" onClick={() => setDraft((current) => {
                if (!current) return current;
                const remaining = current.emails.filter((_, itemIndex) => itemIndex !== index);
                if (remaining.length && !remaining.some((mail) => mail.isPrimary)) remaining[0] = { ...remaining[0], isPrimary: true };
                return { ...current, emails: remaining };
              })}><X size={15} /></button>}
            </div>)}
          </div>
          <label>Observações <small>opcional</small><textarea value={draft.notes} onChange={(event) => setDraft((current) => current ? { ...current, notes: event.target.value } : current)} placeholder="Notas sobre este contato" /></label>
          <label className="contact-favorite-check"><input type="checkbox" checked={draft.favorite} onChange={(event) => setDraft((current) => current ? { ...current, favorite: event.target.checked } : current)} /><Star size={16} fill={draft.favorite ? 'currentColor' : 'none'} /> Favorito</label>
        </form>}
      </section>
    </div>}
  </>;
}
