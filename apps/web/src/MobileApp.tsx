import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  Bell,
  CheckCircle2,
  ChevronDown,
  File,
  FileText,
  Inbox,
  LoaderCircle,
  LogOut,
  Mail,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  UserPlus,
  X
} from 'lucide-react';
import {
  ApiError,
  mailApi,
  type FolderStats,
  type Mailbox,
  type MessageDetail,
  type MessageSummary,
  type SessionAccount,
  type User
} from './api';
import RichTextEditor from './RichTextEditor';
import { AdminPanel, PasswordPanel, SignaturePanel } from './SettingsPanels';
import { enableWebPush, pushSupported, syncExistingPushSubscription } from './push';

type Folder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam';

type ComposeState = {
  fromMailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  files: File[];
  draftId?: string;
  inReplyTo?: string;
  references?: string[];
};

type BootstrapPayload = {
  user: User;
  mailboxes: Mailbox[];
  messages: MessageSummary[];
  folders: FolderStats;
};

const folderLabels: Record<Folder, string> = {
  inbox: 'Entrada',
  sent: 'Enviados',
  drafts: 'Rascunhos',
  archive: 'Arquivo',
  trash: 'Lixeira',
  spam: 'Spam'
};

const deliveryLabels: Record<string, string> = {
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregue',
  delayed: 'Atrasado',
  bounced: 'Devolvido',
  complained: 'Spam',
  failed: 'Falhou',
  suppressed: 'Suprimido',
  draft: 'Rascunho'
};

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'GM';
  return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase();
}

function relativeDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(date).replace('.', '');
}

function fullDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp * 1000)).replace('.', '');
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function splitEmails(value: string): string[] {
  return value.split(/[;,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtml(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function htmlToText(value: string): string {
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  return (parsed.body.innerText || parsed.body.textContent || '').replace(/\u00a0/g, ' ');
}

function threadReferences(detail: MessageDetail): string[] {
  return [...new Set([...detail.references, ...(detail.messageId ? [detail.messageId] : [])])].filter(Boolean);
}

function quotedHtml(detail: MessageDetail): string {
  return `<br><br><blockquote data-gtrz-quote="1" style="margin:12px 0 0;padding-left:12px;border-left:3px solid #45454b;color:#99999f">Em ${escapeHtml(fullDate(detail.receivedAt))}, ${escapeHtml(detail.fromName || detail.fromAddress)} escreveu:<br><br>${textToHtml(detail.bodyText)}</blockquote>`;
}

function quotedText(detail: MessageDetail): string {
  return `\n\n---\nEm ${fullDate(detail.receivedAt)}, ${detail.fromName || detail.fromAddress} escreveu:\n${detail.bodyText}`;
}

function forwardedHtml(detail: MessageDetail): string {
  return `<br><br><div data-gtrz-forward="1"><hr><strong>Mensagem encaminhada</strong><br><br><strong>De:</strong> ${escapeHtml(detail.fromName || detail.fromAddress)} &lt;${escapeHtml(detail.fromAddress)}&gt;<br><strong>Data:</strong> ${escapeHtml(fullDate(detail.receivedAt))}<br><strong>Assunto:</strong> ${escapeHtml(detail.subject)}<br><strong>Para:</strong> ${escapeHtml(detail.to.join(', '))}<br><br>${detail.bodyHtml || textToHtml(detail.bodyText)}</div>`;
}

function messageHtmlForDisplay(detail: MessageDetail): string {
  let html = detail.bodyHtml || '';
  for (const attachment of detail.attachments) {
    if (!attachment.contentId) continue;
    html = html.split(`cid:${attachment.contentId}`).join(`/api/attachments/${attachment.id}?inline=1`);
  }
  return html;
}

function visibleAttachments(detail: MessageDetail) {
  return detail.attachments.filter((attachment) => attachment.disposition !== 'inline');
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function bootstrap(): Promise<BootstrapPayload> {
  const response = await fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as Partial<BootstrapPayload> & { error?: string };
  if (!response.ok || !payload.user) throw new ApiError(payload.error || 'Não foi possível abrir o GTRZ Mail.', response.status);
  return {
    user: payload.user,
    mailboxes: payload.mailboxes || [],
    messages: payload.messages || [],
    folders: payload.folders || {}
  };
}

function MobileLogin({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onLogin(email, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="m-login">
      <form className="m-login-card" onSubmit={submit}>
        <img src="/brand/gtrz-symbol.svg" alt="GTRZ" />
        <div><h1>GTRZ Mail</h1><p>Entre para acessar sua caixa</p></div>
        <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@gtrz.com.br" required /></label>
        <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="m-form-error">{error}</div>}
        <button className="m-primary" disabled={loading}>{loading ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />} Entrar</button>
      </form>
    </main>
  );
}

function MobileComposer({
  mailboxes,
  initial,
  onClose,
  onSent,
  onDraftChanged
}: {
  mailboxes: Mailbox[];
  initial?: Partial<ComposeState>;
  onClose: () => void;
  onSent: () => void;
  onDraftChanged: () => void;
}) {
  const initialText = initial?.text || '';
  const [state, setState] = useState<ComposeState>({
    fromMailboxId: initial?.fromMailboxId || mailboxes.find((m) => m.is_default)?.id || mailboxes[0]?.id || '',
    to: initial?.to || '',
    cc: initial?.cc || '',
    bcc: initial?.bcc || '',
    subject: initial?.subject || '',
    text: initialText,
    html: initial?.html || (initialText ? textToHtml(initialText) : ''),
    files: initial?.files || [],
    draftId: initial?.draftId,
    inReplyTo: initial?.inReplyTo,
    references: initial?.references || []
  });
  const [draftId, setDraftId] = useState(initial?.draftId);
  const [showCopies, setShowCopies] = useState(Boolean(initial?.cc || initial?.bcc));
  const [formatting, setFormatting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [editorTouched, setEditorTouched] = useState(Boolean(initial?.text || initial?.html || initial?.draftId));
  const hasContent = Boolean(state.to.trim() || state.cc.trim() || state.bcc.trim() || state.subject.trim() || editorTouched);

  useEffect(() => {
    if (initial?.draftId) return;
    void mailApi.signature().then(({ html }) => {
      if (!html) return;
      setState((current) => {
        if (current.html.includes('data-gtrz-signature')) return current;
        const signature = `<div data-gtrz-signature="1"><br>${html}</div>`;
        const markerIndexes = [current.html.indexOf('<blockquote data-gtrz-quote'), current.html.indexOf('<div data-gtrz-forward')].filter((index) => index >= 0);
        const marker = markerIndexes.length ? Math.min(...markerIndexes) : -1;
        const nextHtml = marker >= 0
          ? `${current.html.slice(0, marker)}${signature}${current.html.slice(marker)}`
          : current.html.trim() ? `${current.html}<div><br></div>${signature}` : `<div><br></div>${signature}`;
        return { ...current, html: nextHtml, text: htmlToText(nextHtml) };
      });
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (sending || !hasContent) return;
    const timer = window.setTimeout(() => {
      setSaving(true);
      void mailApi.saveDraft({
        draftId,
        fromMailboxId: state.fromMailboxId,
        to: splitEmails(state.to),
        cc: splitEmails(state.cc),
        bcc: splitEmails(state.bcc),
        subject: state.subject,
        text: state.text,
        html: state.html,
        inReplyTo: state.inReplyTo,
        references: state.references
      }).then((saved) => {
        setDraftId(saved.id);
        onDraftChanged();
      }).catch(() => undefined).finally(() => setSaving(false));
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [state.fromMailboxId, state.to, state.cc, state.bcc, state.subject, state.text, state.html, state.inReplyTo, editorTouched, sending]);

  const submit = async () => {
    if (!splitEmails(state.to).length) {
      setError('Informe ao menos um destinatário.');
      return;
    }
    setSending(true);
    setError('');
    try {
      const attachments = await Promise.all(state.files.map(async (file) => ({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64: await fileToBase64(file)
      })));
      await mailApi.send({
        draftId,
        fromMailboxId: state.fromMailboxId,
        to: splitEmails(state.to),
        cc: splitEmails(state.cc),
        bcc: splitEmails(state.bcc),
        subject: state.subject,
        text: state.text,
        html: state.html,
        attachments,
        inReplyTo: state.inReplyTo,
        references: state.references
      });
      onSent();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao enviar.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={`m-compose ${formatting ? 'formatting-open' : ''}`} aria-label="Nova mensagem">
      <header className="m-compose-header">
        <button className="m-icon" onClick={onClose} aria-label="Fechar"><X size={22} /></button>
        <div><strong>{draftId ? 'Rascunho' : 'Nova mensagem'}</strong><span>{saving ? 'Salvando…' : 'Salvo automaticamente'}</span></div>
        <button className="m-send" disabled={sending} onClick={() => void submit()}>{sending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}<span>Enviar</span></button>
      </header>

      <div className="m-compose-fields">
        <div className="m-compose-row"><label>De</label><select value={state.fromMailboxId} onChange={(e) => setState((current) => ({ ...current, fromMailboxId: e.target.value }))}>{mailboxes.map((mailbox) => <option value={mailbox.id} key={mailbox.id}>{mailbox.address}</option>)}</select></div>
        <div className="m-compose-row"><label>Para</label><input autoFocus value={state.to} onChange={(e) => setState((current) => ({ ...current, to: e.target.value }))} placeholder="nome@email.com" /><button onClick={() => setShowCopies((value) => !value)}>Cc/Cco</button></div>
        {showCopies && <><div className="m-compose-row"><label>Cc</label><input value={state.cc} onChange={(e) => setState((current) => ({ ...current, cc: e.target.value }))} /></div><div className="m-compose-row"><label>Cco</label><input value={state.bcc} onChange={(e) => setState((current) => ({ ...current, bcc: e.target.value }))} /></div></>}
        <div className="m-compose-row subject"><label>Assunto</label><input value={state.subject} onChange={(e) => setState((current) => ({ ...current, subject: e.target.value }))} placeholder="Assunto" /></div>
      </div>

      <div className="m-editor-zone">
        <RichTextEditor
          value={state.html}
          autoFocus={false}
          placeholder="Escreva sua mensagem…"
          onError={setError}
          onChange={(html, text) => {
            setEditorTouched(true);
            setState((current) => ({ ...current, html, text }));
          }}
        />
      </div>

      {state.files.length > 0 && <div className="m-compose-files">{state.files.map((file, index) => <div key={`${file.name}-${index}`}><Paperclip size={14} /><span>{file.name}</span><small>{bytesLabel(file.size)}</small><button onClick={() => setState((current) => ({ ...current, files: current.files.filter((_, itemIndex) => itemIndex !== index) }))}><X size={14} /></button></div>)}</div>}
      {error && <div className="m-compose-error">{error}</div>}

      <footer className="m-compose-bottom">
        <button className={formatting ? 'active' : ''} onClick={() => setFormatting((value) => !value)} aria-label="Formatação"><strong>Aa</strong></button>
        <label><Paperclip size={20} /><input type="file" multiple hidden onChange={(e) => setState((current) => ({ ...current, files: [...current.files, ...Array.from(e.target.files || [])] }))} /></label>
        <span>{state.files.length ? `${state.files.length} anexo${state.files.length > 1 ? 's' : ''}` : 'Formatação e anexos'}</span>
      </footer>
    </section>
  );
}

function AccountSheet({
  user,
  open,
  onClose,
  onReload,
  onSettings,
  onLogout
}: {
  user: User;
  open: boolean;
  onClose: () => void;
  onReload: () => void;
  onSettings: () => void;
  onLogout: () => void;
}) {
  const [accounts, setAccounts] = useState<SessionAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    void mailApi.sessionAccounts().then(({ accounts: next }) => setAccounts(next)).catch(() => setAccounts([]));
  }, [open]);

  if (!open) return null;

  const switchAccount = async (account: SessionAccount) => {
    if (account.current) return;
    setWorking(true);
    try {
      await mailApi.switchAccount(account.id);
      onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível alternar a conta.');
    } finally {
      setWorking(false);
    }
  };

  const addAccount = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError('');
    try {
      await mailApi.login(email, password);
      onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível adicionar a conta.');
    } finally {
      setWorking(false);
    }
  };

  return <div className="m-sheet-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}><section className="m-sheet account-sheet">
    <div className="m-sheet-handle" />
    <div className="m-account-current"><div className="m-avatar big">{initials(user.displayName)}</div><div><strong>{user.displayName}</strong><span>{user.email}</span></div><button className="m-icon" onClick={onClose}><X size={20} /></button></div>
    <div className="m-account-list">{accounts.map((account) => <button key={account.id} className={account.current ? 'current' : ''} disabled={working} onClick={() => void switchAccount(account)}><div className="m-avatar">{initials(account.displayName)}</div><div><strong>{account.displayName}</strong><span>{account.email}</span></div>{account.current && <CheckCircle2 size={18} />}</button>)}</div>
    {adding ? <form className="m-add-account" onSubmit={addAccount}><input type="email" placeholder="outra@gtrz.com.br" value={email} onChange={(e) => setEmail(e.target.value)} required /><input type="password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} required />{error && <div className="m-form-error">{error}</div>}<div><button type="button" onClick={() => setAdding(false)}>Cancelar</button><button className="m-primary" disabled={working}>Entrar</button></div></form> : <button className="m-sheet-action" onClick={() => setAdding(true)}><UserPlus size={19} /> Adicionar outra conta</button>}
    {!adding && <><button className="m-sheet-action" onClick={() => { onClose(); onSettings(); }}><Settings size={19} /> Configurações</button><button className="m-sheet-action danger" onClick={onLogout}><LogOut size={19} /> Sair desta conta</button></>}
  </section></div>;
}

export default function MobileApp() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [folder, setFolder] = useState<Folder>('inbox');
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [stats, setStats] = useState<FolderStats>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [search, setSearch] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composer, setComposer] = useState<Partial<ComposeState> | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const deepLinkRef = useRef<string | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? '' : current), 2600);
  };

  const resetToInbox = () => {
    setFolder('inbox');
    setSelectedId(null);
    setDetail(null);
    setSearch('');
    setSearchMode(false);
    setMoreOpen(false);
  };

  const refreshStats = async () => {
    try {
      const result = await mailApi.stats();
      setStats(result.folders);
    } catch {
      // A lista continua utilizável sem as contagens.
    }
  };

  const loadFolder = async (target: Folder = folder, query = search) => {
    if (!user) return;
    setLoadingList(true);
    try {
      const result = await mailApi.list(target, query, {});
      setMessages(result.messages);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as mensagens.');
    } finally {
      setLoadingList(false);
    }
  };

  const openMessage = async (id: string) => {
    setSelectedId(id);
    setLoadingDetail(true);
    setError('');
    try {
      const { message } = await mailApi.get(id);
      setDetail(message);
      setMessages((items) => items.map((item) => item.id === id ? { ...item, isRead: true } : item));
      void refreshStats();
    } catch (cause) {
      setSelectedId(null);
      setDetail(null);
      setError(cause instanceof Error ? cause.message : 'Não foi possível abrir a mensagem.');
    } finally {
      setLoadingDetail(false);
    }
  };

  const runBootstrap = async () => {
    setBooting(true);
    setError('');
    try {
      const data = await bootstrap();
      setUser(data.user);
      setMailboxes(data.mailboxes);
      setFolder('inbox');
      setMessages(data.messages);
      setStats(data.folders);
      setSelectedId(null);
      setDetail(null);
      void syncExistingPushSubscription().catch(() => undefined);
      const deepLink = deepLinkRef.current;
      deepLinkRef.current = null;
      if (deepLink) void openMessage(deepLink);
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 401) setError(cause instanceof Error ? cause.message : 'Falha ao abrir o GTRZ Mail.');
      setUser(null);
    } finally {
      setBooting(false);
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    deepLinkRef.current = url.searchParams.get('message');
    if (deepLinkRef.current) window.history.replaceState({}, '', url.pathname);
    void runBootstrap();
  }, []);

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => void loadFolder(folder, search), searchMode ? 280 : 0);
    return () => window.clearTimeout(timer);
  }, [folder, search, searchMode, user?.id]);

  useEffect(() => {
    if (!user) return;
    const visibleRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadFolder(folder, search);
      void refreshStats();
    };
    const interval = window.setInterval(visibleRefresh, 60_000);
    return () => window.clearInterval(interval);
  }, [user?.id, folder, search]);

  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt && Date.now() - hiddenAt > 45_000 && !deepLinkRef.current) resetToInbox();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'gtrz-new-mail') {
        if (folder === 'inbox') void loadFolder('inbox', searchMode ? search : '');
        void refreshStats();
      }
      if (event.data?.type === 'gtrz-open-message' && event.data?.messageId) {
        setFolder('inbox');
        setSearchMode(false);
        setSearch('');
        void openMessage(String(event.data.messageId));
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [folder, search, searchMode, user?.id]);

  useEffect(() => {
    if (searchMode) window.setTimeout(() => searchRef.current?.focus(), 80);
  }, [searchMode]);

  const selectFolder = (target: Folder) => {
    setFolder(target);
    setSelectedId(null);
    setDetail(null);
    setSearchMode(false);
    setSearch('');
    setMoreOpen(false);
  };

  const login = async (email: string, password: string) => {
    await mailApi.login(email, password);
    await runBootstrap();
  };

  const logout = async () => {
    await mailApi.logout();
    setAccountOpen(false);
    setUser(null);
    setMessages([]);
    setDetail(null);
    setStats({});
  };

  const messageAction = async (action: 'archive' | 'trash' | 'restore' | 'delete') => {
    if (!detail) return;
    await mailApi.action(detail.id, action);
    setSelectedId(null);
    setDetail(null);
    flash(action === 'archive' ? 'Mensagem arquivada.' : action === 'trash' ? 'Mensagem movida para a lixeira.' : action === 'restore' ? 'Mensagem restaurada.' : 'Mensagem excluída.');
    void loadFolder();
    void refreshStats();
  };

  const toggleStar = async (message: MessageSummary | MessageDetail) => {
    const next = !message.isStarred;
    setMessages((items) => items.map((item) => item.id === message.id ? { ...item, isStarred: next } : item));
    setDetail((current) => current?.id === message.id ? { ...current, isStarred: next } : current);
    await mailApi.action(message.id, 'star', next);
  };

  const markUnread = async () => {
    if (!detail) return;
    await mailApi.action(detail.id, 'read', false);
    setSelectedId(null);
    setDetail(null);
    flash('Marcada como não lida.');
    void loadFolder();
    void refreshStats();
  };

  const reply = (all = false) => {
    if (!detail) return;
    const own = new Set(mailboxes.map((mailbox) => mailbox.address.toLowerCase()));
    const sender = detail.fromAddress.toLowerCase();
    const cc = all
      ? [...new Set([...detail.to, ...detail.cc].map((address) => address.toLowerCase()).filter((address) => !own.has(address) && address !== sender))].join(', ')
      : '';
    setComposer({
      to: detail.direction === 'outbound' ? detail.to.join(', ') : detail.fromAddress,
      cc,
      subject: detail.subject.toLowerCase().startsWith('re:') ? detail.subject : `Re: ${detail.subject}`,
      text: quotedText(detail),
      html: quotedHtml(detail),
      inReplyTo: detail.messageId || undefined,
      references: threadReferences(detail)
    });
  };

  const forward = () => {
    if (!detail) return;
    setComposer({
      subject: /^(enc:|fwd:)/i.test(detail.subject) ? detail.subject : `Fwd: ${detail.subject}`,
      text: `\n\n---------- Mensagem encaminhada ----------\nDe: ${detail.fromName || detail.fromAddress} <${detail.fromAddress}>\nData: ${fullDate(detail.receivedAt)}\nAssunto: ${detail.subject}\nPara: ${detail.to.join(', ')}\n\n${detail.bodyText}`,
      html: forwardedHtml(detail)
    });
  };

  const editDraft = () => {
    if (!detail) return;
    setComposer({
      draftId: detail.id,
      to: detail.to.join(', '),
      cc: detail.cc.join(', '),
      bcc: detail.bcc.join(', '),
      subject: detail.subject,
      text: detail.bodyText,
      html: detail.bodyHtml || textToHtml(detail.bodyText),
      inReplyTo: detail.inReplyTo || undefined,
      references: detail.references
    });
  };

  const currentSummary = useMemo(() => messages.find((message) => message.id === selectedId) || null, [messages, selectedId]);

  if (booting) return <main className="m-boot"><img src="/brand/gtrz-symbol.svg" alt="GTRZ" /><LoaderCircle className="spin" size={24} /></main>;
  if (!user) return <MobileLogin onLogin={login} />;

  if (composer !== null) return <MobileComposer
    mailboxes={mailboxes}
    initial={composer}
    onClose={() => setComposer(null)}
    onDraftChanged={() => { void refreshStats(); if (folder === 'drafts') void loadFolder('drafts', ''); }}
    onSent={() => { flash('Mensagem enviada.'); void refreshStats(); if (folder === 'sent' || folder === 'drafts') void loadFolder(folder, ''); }}
  />;

  if (settingsOpen) return <section className="m-settings-screen">
    <header className="m-screen-header"><button className="m-icon" onClick={() => setSettingsOpen(false)}><ArrowLeft size={22} /></button><strong>Configurações</strong><span /></header>
    <div className="m-settings-content">
      <section className="m-settings-card"><h3>Suas caixas</h3>{mailboxes.map((mailbox) => <div className="m-mailbox-setting" key={mailbox.id}><Mail size={18} /><div><strong>{mailbox.address}</strong><span>{mailbox.display_name}</span></div>{mailbox.is_default === 1 && <b>Principal</b>}</div>)}</section>
      <section className="m-settings-card"><h3><Bell size={17} /> Notificações</h3><p>Receba novos e-mails mesmo com o PWA fechado.</p><button className="m-secondary" onClick={() => void (pushSupported() ? enableWebPush().then(() => flash('Notificações ativadas.')).catch((cause) => flash(cause instanceof Error ? cause.message : 'Não foi possível ativar.')) : Promise.resolve(flash('Este navegador não suporta Web Push.')))}><Bell size={17} /> Ativar notificações</button></section>
      <SignaturePanel onNotice={flash} />
      <PasswordPanel onNotice={flash} />
      {user.isAdmin && <AdminPanel onNotice={flash} />}
      <section className="m-settings-card security"><ShieldCheck size={22} /><div><h3>Proteção da conta</h3><p>Sessão protegida e conteúdo criptografado no armazenamento privado.</p></div></section>
    </div>
  </section>;

  if (selectedId) return <section className="m-reader-screen">
    <header className="m-reader-header">
      <button className="m-icon" onClick={() => { setSelectedId(null); setDetail(null); }} aria-label="Voltar"><ArrowLeft size={22} /></button>
      <div className="m-reader-actions">
        {folder === 'trash' ? <><button className="m-icon" onClick={() => void messageAction('restore')} aria-label="Restaurar"><Archive size={20} /></button><button className="m-icon danger" onClick={() => void messageAction('delete')} aria-label="Excluir permanentemente"><Trash2 size={20} /></button></> : <><button className="m-icon" onClick={() => void messageAction('archive')} aria-label="Arquivar"><Archive size={20} /></button><button className="m-icon" onClick={() => void messageAction('trash')} aria-label="Excluir"><Trash2 size={20} /></button></>}
        <button className="m-icon" onClick={() => detail && void toggleStar(detail)} aria-label="Favoritar"><Star size={20} fill={detail?.isStarred ? 'currentColor' : 'none'} /></button>
        <button className="m-icon" onClick={() => setMoreOpen(true)} aria-label="Mais"><MoreHorizontal size={21} /></button>
      </div>
    </header>
    {loadingDetail ? <div className="m-reader-loading"><LoaderCircle className="spin" size={25} /><span>Abrindo mensagem…</span></div> : detail ? <article className="m-message-detail">
      <div className="m-message-subject"><h1>{detail.subject || '(sem assunto)'}</h1>{currentSummary?.threadCount && currentSummary.threadCount > 1 && <span>{currentSummary.threadCount} mensagens</span>}</div>
      <div className="m-sender-card"><div className="m-avatar big">{initials(detail.fromName || detail.fromAddress)}</div><div><strong>{detail.fromName || detail.fromAddress}</strong><span>{detail.fromAddress}</span><small>para {detail.to.join(', ') || user.email}</small></div><time>{relativeDate(detail.receivedAt)}</time></div>
      {detail.sentStatus && <div className={`m-delivery ${detail.sentStatus}`}><CheckCircle2 size={13} />{deliveryLabels[detail.sentStatus] || detail.sentStatus}</div>}
      {detail.bodyHtml ? <div className="m-mail-body rich-mail-body" dangerouslySetInnerHTML={{ __html: messageHtmlForDisplay(detail) }} /> : <div className="m-mail-body plain">{detail.bodyText || 'Mensagem sem conteúdo.'}</div>}
      {visibleAttachments(detail).length > 0 && <section className="m-attachments"><h3><Paperclip size={17} /> Anexos</h3>{visibleAttachments(detail).map((attachment) => { const Icon = attachment.mimeType === 'application/pdf' ? FileText : File; return <a key={attachment.id} href={`/api/attachments/${attachment.id}`}><Icon size={20} /><div><strong>{attachment.filename}</strong><span>{bytesLabel(attachment.sizeBytes)}</span></div></a>; })}</section>}
      <div className="m-reply-bar">{detail.folder === 'drafts' ? <button className="m-primary" onClick={editDraft}><PenLine size={18} /> Editar rascunho</button> : <><button className="m-primary" onClick={() => reply(false)}>Responder</button><button className="m-secondary" onClick={() => reply(true)}>Todos</button><button className="m-secondary" onClick={forward}>Encaminhar</button></>}</div>
    </article> : <div className="m-reader-loading"><Mail size={24} /><span>Mensagem indisponível.</span></div>}
    {moreOpen && <div className="m-sheet-backdrop" onClick={(event) => event.target === event.currentTarget && setMoreOpen(false)}><section className="m-sheet compact"><div className="m-sheet-handle" /><button className="m-sheet-action" onClick={() => { setMoreOpen(false); void markUnread(); }}><Mail size={19} /> Marcar como não lida</button><button className="m-sheet-action" onClick={() => { setMoreOpen(false); forward(); }}><Send size={19} /> Encaminhar</button></section></div>}
  </section>;

  return <main className="m-app">
    <header className="m-topbar">
      <div className="m-brand"><img src="/brand/gtrz-symbol.svg" alt="GTRZ" /><div><strong>{folderLabels[folder]}</strong><span>{user.email}</span></div></div>
      <button className="m-avatar-button" onClick={() => setAccountOpen(true)} aria-label="Conta"><span>{initials(user.displayName)}</span><ChevronDown size={14} /></button>
    </header>

    <section className={`m-search ${searchMode ? 'open' : ''}`}>
      <Search size={18} />
      <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar e-mails" />
      {search && <button onClick={() => setSearch('')}><X size={17} /></button>}
    </section>

    <section className="m-inbox-summary"><div><strong>{folderLabels[folder]}</strong><span>{messages.length} conversa{messages.length === 1 ? '' : 's'}</span></div><button className="m-icon" onClick={() => { void loadFolder(); void refreshStats(); }} aria-label="Atualizar">{loadingList ? <LoaderCircle className="spin" size={19} /> : <Mail size={19} />}</button></section>

    {error && <div className="m-inline-error">{error}</div>}
    <section className="m-message-list">
      {loadingList && messages.length === 0 && <div className="m-empty"><LoaderCircle className="spin" size={24} /><span>Carregando mensagens…</span></div>}
      {!loadingList && messages.length === 0 && <div className="m-empty"><Mail size={28} /><strong>Nenhuma mensagem</strong><span>Esta pasta está vazia.</span></div>}
      {messages.map((message) => {
        const sender = message.direction === 'outbound' ? `Para: ${message.to[0] || ''}` : (message.fromName || message.fromAddress);
        return <button key={message.id} className={`m-message-row ${!message.isRead ? 'unread' : ''}`} onClick={() => void openMessage(message.id)}>
          <div className="m-avatar">{initials(sender)}</div>
          <div className="m-message-copy"><div className="m-message-line"><strong>{sender}</strong><time>{relativeDate(message.receivedAt)}</time></div><div className="m-subject-line"><span>{message.subject || '(sem assunto)'}</span>{message.threadCount && message.threadCount > 1 && <b>{message.threadCount}</b>}</div><p>{message.preview}</p><div className="m-row-meta">{message.attachmentCount > 0 && <span><Paperclip size={11} />{message.attachmentCount}</span>}{message.sentStatus && <span className={`m-delivery mini ${message.sentStatus}`}>{deliveryLabels[message.sentStatus] || message.sentStatus}</span>}</div></div>
          <span className={`m-star ${message.isStarred ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); void toggleStar(message); }}><Star size={18} fill={message.isStarred ? 'currentColor' : 'none'} /></span>
        </button>;
      })}
    </section>

    <nav className="m-bottom-nav" aria-label="Navegação principal">
      <button className={folder === 'inbox' && !searchMode ? 'active' : ''} onClick={() => selectFolder('inbox')}><Inbox size={21} /><span>Entrada</span>{Boolean(stats.inbox?.unread) && <b>{stats.inbox.unread}</b>}</button>
      <button className={folder === 'sent' && !searchMode ? 'active' : ''} onClick={() => selectFolder('sent')}><Send size={21} /><span>Enviados</span></button>
      <button className="compose" onClick={() => setComposer({})}><span><PenLine size={23} /></span><small>Escrever</small></button>
      <button className={searchMode ? 'active' : ''} onClick={() => setSearchMode(true)}><Search size={21} /><span>Buscar</span></button>
      <button className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen(true)}><MoreHorizontal size={22} /><span>Mais</span></button>
    </nav>

    {moreOpen && <div className="m-sheet-backdrop" onClick={(event) => event.target === event.currentTarget && setMoreOpen(false)}><section className="m-sheet navigation-sheet"><div className="m-sheet-handle" /><div className="m-sheet-title">Outras pastas</div><div className="m-folder-grid"><button onClick={() => selectFolder('drafts')}><FileText size={21} /><span>Rascunhos</span>{Boolean(stats.drafts?.total) && <b>{stats.drafts.total}</b>}</button><button onClick={() => selectFolder('archive')}><Archive size={21} /><span>Arquivo</span>{Boolean(stats.archive?.total) && <b>{stats.archive.total}</b>}</button><button onClick={() => selectFolder('spam')}><ShieldCheck size={21} /><span>Spam</span>{Boolean(stats.spam?.total) && <b>{stats.spam.total}</b>}</button><button onClick={() => selectFolder('trash')}><Trash2 size={21} /><span>Lixeira</span>{Boolean(stats.trash?.total) && <b>{stats.trash.total}</b>}</button></div><button className="m-sheet-action" onClick={() => { setMoreOpen(false); setSettingsOpen(true); }}><Settings size={19} /> Configurações</button><button className="m-sheet-action danger" onClick={() => void logout()}><LogOut size={19} /> Sair</button></section></div>}

    <AccountSheet user={user} open={accountOpen} onClose={() => setAccountOpen(false)} onReload={() => { setAccountOpen(false); void runBootstrap(); }} onSettings={() => setSettingsOpen(true)} onLogout={() => void logout()} />
    {notice && <div className="m-toast"><CheckCircle2 size={16} />{notice}</div>}
  </main>;
}
