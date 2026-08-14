import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  File,
  FileText,
  Forward,
  Inbox,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  X
} from 'lucide-react';
import { ApiError, mailApi, type Mailbox, type MessageDetail, type MessageSummary, type User } from './api';
import { demoDetails, demoMailboxes, demoMessages, demoUser } from './demo';

const DEMO = import.meta.env.DEV;

type Folder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash';

type ComposeState = {
  fromMailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  files: File[];
};

const folderItems: Array<{ id: Folder; label: string; icon: typeof Inbox }> = [
  { id: 'inbox', label: 'Entrada', icon: Inbox },
  { id: 'sent', label: 'Enviados', icon: Send },
  { id: 'drafts', label: 'Rascunhos', icon: FileText },
  { id: 'archive', label: 'Arquivo', icon: Archive },
  { id: 'trash', label: 'Lixeira', icon: Trash2 }
];

function splitEmails(value: string): string[] {
  return value.split(/[;,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'GM';
  return `${parts[0][0] || ''}${parts[1]?.[0] || ''}`.toUpperCase();
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, Math.min(i + chunk, buffer.length)));
  }
  return btoa(binary);
}

function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível entrar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand">
          <img className="login-symbol" src="/brand/gtrz-symbol.svg" alt="GTRZ" />
          <img className="login-lockup" src="/brand/gtrz-lockup.svg" alt="GTRZ" />
          <span>MAIL</span>
        </div>
        <div className="login-copy">
          <h1>Acesse seu e-mail</h1>
          <p>Caixa privada do domínio gtrz.com.br</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            E-mail
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@gtrz.com.br" required />
          </label>
          <label>
            Senha
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Sua senha" required />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button login-button" disabled={loading}>
            {loading ? <LoaderCircle size={18} className="spin" /> : <ShieldCheck size={18} />}
            Entrar com segurança
          </button>
        </form>
        <div className="login-security"><ShieldCheck size={15} /> Sessão protegida por cookie HttpOnly e TLS</div>
      </section>
    </main>
  );
}

function Composer({ mailboxes, onClose, onSent, initial }: {
  mailboxes: Mailbox[];
  onClose: () => void;
  onSent: () => void;
  initial?: Partial<ComposeState>;
}) {
  const [state, setState] = useState<ComposeState>({
    fromMailboxId: initial?.fromMailboxId || mailboxes.find((m) => m.is_default)?.id || mailboxes[0]?.id || '',
    to: initial?.to || '',
    cc: initial?.cc || '',
    bcc: initial?.bcc || '',
    subject: initial?.subject || '',
    text: initial?.text || '',
    files: initial?.files || []
  });
  const [showCopies, setShowCopies] = useState(Boolean(initial?.cc || initial?.bcc));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, sending]);

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
      if (!DEMO) {
        await mailApi.send({
          fromMailboxId: state.fromMailboxId,
          to: splitEmails(state.to),
          cc: splitEmails(state.cc),
          bcc: splitEmails(state.bcc),
          subject: state.subject,
          text: state.text,
          attachments
        });
      }
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar.');
    } finally {
      setSending(false);
    }
  };

  const total = state.files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !sending && onClose()}>
      <section className="composer" role="dialog" aria-modal="true" aria-label="Nova mensagem">
        <header className="composer-header">
          <div><PenLine size={17} /> Nova mensagem</div>
          <button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </header>
        <div className="composer-field">
          <label>De</label>
          <select value={state.fromMailboxId} onChange={(e) => setState((s) => ({ ...s, fromMailboxId: e.target.value }))}>
            {mailboxes.map((mailbox) => <option value={mailbox.id} key={mailbox.id}>{mailbox.address}</option>)}
          </select>
        </div>
        <div className="composer-field">
          <label>Para</label>
          <input autoFocus value={state.to} onChange={(e) => setState((s) => ({ ...s, to: e.target.value }))} placeholder="destinatario@email.com" />
          {!showCopies && <button className="text-button" onClick={() => setShowCopies(true)}>Cc / Cco</button>}
        </div>
        {showCopies && <>
          <div className="composer-field"><label>Cc</label><input value={state.cc} onChange={(e) => setState((s) => ({ ...s, cc: e.target.value }))} /></div>
          <div className="composer-field"><label>Cco</label><input value={state.bcc} onChange={(e) => setState((s) => ({ ...s, bcc: e.target.value }))} /></div>
        </>}
        <div className="composer-field"><label>Assunto</label><input value={state.subject} onChange={(e) => setState((s) => ({ ...s, subject: e.target.value }))} placeholder="Assunto" /></div>
        <textarea className="composer-editor" value={state.text} onChange={(e) => setState((s) => ({ ...s, text: e.target.value }))} placeholder="Escreva sua mensagem..." />
        {state.files.length > 0 && <div className="compose-files">
          {state.files.map((file, index) => (
            <div className="compose-file" key={`${file.name}-${index}`}>
              <Paperclip size={15} />
              <span>{file.name}</span>
              <small>{bytesLabel(file.size)}</small>
              <button className="icon-button compact" onClick={() => setState((s) => ({ ...s, files: s.files.filter((_, i) => i !== index) }))} aria-label={`Remover ${file.name}`}><X size={14} /></button>
            </div>
          ))}
          <div className="file-total">Total: {bytesLabel(total)}</div>
        </div>}
        {error && <div className="composer-error">{error}</div>}
        <footer className="composer-footer">
          <label className="attach-button">
            <Paperclip size={17} />
            Anexar
            <input type="file" multiple hidden onChange={(e) => setState((s) => ({ ...s, files: [...s.files, ...Array.from(e.target.files || [])] }))} />
          </label>
          <button className="primary-button" disabled={sending} onClick={submit}>
            {sending ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}
            Enviar
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User | null>(DEMO ? demoUser : null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(DEMO ? demoMailboxes : []);
  const [folder, setFolder] = useState<Folder>('inbox');
  const [messages, setMessages] = useState<MessageSummary[]>(DEMO ? demoMessages : []);
  const [selectedId, setSelectedId] = useState<string | null>(DEMO ? demoMessages[0].id : null);
  const [detail, setDetail] = useState<MessageDetail | null>(DEMO ? demoDetails[demoMessages[0].id] : null);
  const [search, setSearch] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [composer, setComposer] = useState<Partial<ComposeState> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (DEMO) {
      setBooting(false);
      return;
    }
    mailApi.session()
      .then(({ user: nextUser, mailboxes: nextMailboxes }) => {
        setUser(nextUser);
        setMailboxes(nextMailboxes);
      })
      .catch((error) => {
        if (!(error instanceof ApiError) || error.status !== 401) console.error(error);
      })
      .finally(() => setBooting(false));
  }, []);

  const loadList = async (nextFolder = folder, nextSearch = search) => {
    setLoadingList(true);
    try {
      if (DEMO) {
        const lower = nextSearch.toLowerCase();
        const filtered = demoMessages.filter((message) => message.folder === nextFolder && (!lower || `${message.fromName} ${message.fromAddress} ${message.subject} ${message.preview}`.toLowerCase().includes(lower)));
        setMessages(filtered);
        if (!filtered.some((message) => message.id === selectedId)) {
          setSelectedId(filtered[0]?.id || null);
          setDetail(filtered[0] ? demoDetails[filtered[0].id] : null);
        }
      } else {
        const result = await mailApi.list(nextFolder, nextSearch);
        setMessages(result.messages);
        if (!result.messages.some((message) => message.id === selectedId)) {
          setSelectedId(result.messages[0]?.id || null);
          setDetail(null);
        }
      }
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => void loadList(folder, search), 250);
    return () => window.clearTimeout(timer);
  }, [folder, search, user]);

  useEffect(() => {
    if (!selectedId || !user) {
      setDetail(null);
      return;
    }
    if (DEMO) {
      setDetail(demoDetails[selectedId] || null);
      setMessages((items) => items.map((m) => m.id === selectedId ? { ...m, isRead: true } : m));
      return;
    }
    setLoadingDetail(true);
    mailApi.get(selectedId)
      .then(({ message }) => {
        setDetail(message);
        setMessages((items) => items.map((m) => m.id === selectedId ? { ...m, isRead: true } : m));
      })
      .finally(() => setLoadingDetail(false));
  }, [selectedId, user]);

  const unreadCount = useMemo(() => messages.filter((m) => !m.isRead && folder === 'inbox').length, [messages, folder]);

  const login = async (email: string, password: string) => {
    const result = await mailApi.login(email, password);
    const session = await mailApi.session();
    setUser(result.user);
    setMailboxes(session.mailboxes);
  };

  const logout = async () => {
    if (!DEMO) await mailApi.logout();
    setUser(null);
    setMailboxes([]);
    setMessages([]);
    setDetail(null);
    setSelectedId(null);
  };

  const toggleStar = async (message: MessageSummary) => {
    const next = !message.isStarred;
    setMessages((items) => items.map((m) => m.id === message.id ? { ...m, isStarred: next } : m));
    setDetail((current) => current?.id === message.id ? { ...current, isStarred: next } : current);
    if (!DEMO) await mailApi.action(message.id, 'star', next);
  };

  const moveMessage = async (action: 'trash' | 'archive') => {
    if (!detail) return;
    if (!DEMO) await mailApi.action(detail.id, action);
    setMessages((items) => items.filter((m) => m.id !== detail.id));
    setSelectedId(null);
    setDetail(null);
    setNotice(action === 'trash' ? 'Mensagem movida para a lixeira.' : 'Mensagem arquivada.');
    window.setTimeout(() => setNotice(''), 2600);
  };

  const reply = () => {
    if (!detail) return;
    setComposer({
      to: detail.fromAddress,
      subject: detail.subject.toLowerCase().startsWith('re:') ? detail.subject : `Re: ${detail.subject}`,
      text: `\n\n---\nEm ${fullDate(detail.receivedAt)}, ${detail.fromName || detail.fromAddress} escreveu:\n${detail.bodyText}`
    });
  };

  if (booting) {
    return <main className="boot-screen"><img src="/brand/gtrz-symbol.svg" alt="GTRZ" /><LoaderCircle size={24} className="spin" /></main>;
  }
  if (!user) return <Login onLogin={login} />;

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <img src="/brand/gtrz-symbol.svg" alt="GTRZ" />
          <div><strong>GTRZ Mail</strong><span>mail.gtrz.com.br</span></div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>

        <button className="compose-main" onClick={() => setComposer({})}><PenLine size={18} /> Escrever</button>

        <nav className="nav-list" aria-label="Pastas">
          {folderItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={folder === item.id ? 'active' : ''} onClick={() => { setFolder(item.id); setSidebarOpen(false); }}>
              <Icon size={18} />
              <span>{item.label}</span>
              {item.id === 'inbox' && unreadCount > 0 && <b>{unreadCount}</b>}
            </button>;
          })}
        </nav>

        <div className="sidebar-section-title">CAIXAS</div>
        <div className="mailbox-list">
          {mailboxes.map((mailbox) => <div key={mailbox.id} className="mailbox-row"><span className="status-dot" /><span>{mailbox.address}</span></div>)}
        </div>

        <div className="sidebar-bottom">
          <button onClick={() => setSettingsOpen(true)}><Settings size={18} /><span>Configurações</span></button>
          <button onClick={logout}><LogOut size={18} /><span>Sair</span></button>
          <div className="storage-card">
            <div><span>Armazenamento</span><strong>R2</strong></div>
            <div className="storage-track"><span /></div>
            <small>Bucket privado e criptografado</small>
          </div>
        </div>
      </aside>

      <section className="message-pane">
        <header className="list-toolbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Abrir menu"><Menu size={20} /></button>
          <div className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar no GTRZ Mail" /><kbd>Ctrl K</kbd></div>
          <button className="icon-button" onClick={() => void loadList()} aria-label="Atualizar"><RefreshCw size={18} className={loadingList ? 'spin' : ''} /></button>
          <button className="icon-button" aria-label="Filtros"><SlidersHorizontal size={18} /></button>
        </header>

        <div className="list-heading">
          <div><h1>{folderItems.find((item) => item.id === folder)?.label}</h1><span>{messages.length} mensagens</span></div>
          {DEMO && <span className="demo-badge">MODO DEMONSTRAÇÃO</span>}
        </div>

        <div className="message-list">
          {loadingList && messages.length === 0 ? <div className="empty-list"><LoaderCircle className="spin" size={24} /><span>Carregando mensagens</span></div> : null}
          {!loadingList && messages.length === 0 ? <div className="empty-list"><Mail size={28} /><strong>Nenhuma mensagem</strong><span>Esta pasta está vazia.</span></div> : null}
          {messages.map((message) => {
            const sender = message.direction === 'outbound' ? `Para: ${message.to[0] || ''}` : (message.fromName || message.fromAddress);
            return <article key={message.id} className={`message-row ${selectedId === message.id ? 'selected' : ''} ${!message.isRead ? 'unread' : ''}`} onClick={() => setSelectedId(message.id)}>
              <div className="avatar">{initials(sender)}</div>
              <div className="message-row-content">
                <div className="message-row-top"><strong>{sender}</strong><time>{relativeDate(message.receivedAt)}</time></div>
                <div className="message-subject">{message.subject}</div>
                <div className="message-preview">{message.preview}</div>
                <div className="message-meta">
                  {message.attachmentCount > 0 && <span><Paperclip size={12} />{message.attachmentCount}</span>}
                  {message.sentStatus && <span className={`delivery ${message.sentStatus}`}><CheckCircle2 size={12} />{message.sentStatus}</span>}
                </div>
              </div>
              <button className={`star-button ${message.isStarred ? 'active' : ''}`} aria-label="Favoritar" onClick={(e) => { e.stopPropagation(); void toggleStar(message); }}><Star size={17} fill={message.isStarred ? 'currentColor' : 'none'} /></button>
            </article>;
          })}
        </div>
      </section>

      <main className={`reader-pane ${selectedId ? 'mobile-visible' : ''}`}>
        {selectedId && <header className="reader-toolbar">
          <button className="icon-button reader-back" onClick={() => setSelectedId(null)} aria-label="Voltar"><ArrowLeft size={19} /></button>
          <div className="toolbar-group">
            <button className="icon-button" onClick={() => void moveMessage('archive')} aria-label="Arquivar"><Archive size={18} /></button>
            <button className="icon-button" onClick={() => void moveMessage('trash')} aria-label="Excluir"><Trash2 size={18} /></button>
            <button className="icon-button" aria-label="Mais ações"><MoreHorizontal size={18} /></button>
          </div>
          <div className="user-chip"><span>{initials(user.displayName)}</span><div><strong>{user.displayName}</strong><small>{user.email}</small></div><ChevronDown size={15} /></div>
        </header>}

        {!selectedId ? <div className="reader-empty"><img src="/brand/gtrz-symbol.svg" alt="" /><h2>GTRZ Mail</h2><p>Selecione uma mensagem para abrir.</p></div> : loadingDetail ? <div className="reader-empty"><LoaderCircle size={25} className="spin" /><p>Abrindo mensagem</p></div> : detail ? <article className="message-detail">
          <div className="breadcrumb">{folderItems.find((item) => item.id === folder)?.label} / {detail.direction === 'outbound' ? 'Enviado' : 'Mensagem'}</div>
          <h2>{detail.subject}</h2>
          <div className="detail-badges">
            {detail.isStarred && <span><Star size={12} fill="currentColor" /> Favorito</span>}
            {detail.sentStatus && <span><CheckCircle2 size={12} /> {detail.sentStatus}</span>}
          </div>
          <div className="sender-card">
            <div className="avatar large">{initials(detail.fromName || detail.fromAddress)}</div>
            <div className="sender-info"><strong>{detail.fromName || detail.fromAddress}</strong><span>{detail.fromAddress}</span><small>para {detail.to.join(', ') || user.email}</small></div>
            <time>{fullDate(detail.receivedAt)}</time>
          </div>
          <div className="mail-body">{detail.bodyText || 'Mensagem sem conteúdo de texto.'}</div>

          {detail.attachments.length > 0 && <section className="attachments-section">
            <h3><Paperclip size={16} /> Anexos <span>{detail.attachments.length}</span></h3>
            <div className="attachment-grid">
              {detail.attachments.map((attachment) => {
                const isPdf = attachment.mimeType === 'application/pdf';
                const Icon = isPdf ? FileText : File;
                return <div className="attachment-card" key={attachment.id}>
                  <div className="file-icon"><Icon size={20} /></div>
                  <div><strong>{attachment.filename}</strong><span>{bytesLabel(attachment.sizeBytes)} · {attachment.mimeType}</span></div>
                  {DEMO ? <button className="icon-button" aria-label="Download indisponível no modo demonstração"><Download size={17} /></button> : <a className="icon-button" href={`/api/attachments/${attachment.id}`} aria-label={`Baixar ${attachment.filename}`}><Download size={17} /></a>}
                </div>;
              })}
            </div>
          </section>}

          <div className="reply-actions">
            <button className="primary-button" onClick={reply}><Reply size={17} /> Responder</button>
            <button className="secondary-button"><Forward size={17} /> Encaminhar</button>
          </div>
        </article> : null}
      </main>

      {composer !== null && <Composer mailboxes={mailboxes} initial={composer} onClose={() => setComposer(null)} onSent={() => { setNotice('Mensagem enviada.'); window.setTimeout(() => setNotice(''), 2600); if (folder === 'sent') void loadList(); }} />}

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Configurações">
          <header><div><Settings size={19} /><strong>Configurações</strong></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Fechar"><X size={18} /></button></header>
          <div className="settings-body">
            <section><h3>Suas caixas</h3>{mailboxes.map((mailbox) => <div className="settings-mailbox" key={mailbox.id}><Mail size={18} /><div><strong>{mailbox.address}</strong><span>{mailbox.display_name}</span></div>{mailbox.is_default === 1 && <b>Principal</b>}</div>)}</section>
            <section className="security-panel"><ShieldCheck size={22} /><div><h3>Proteção da conta</h3><p>Sessões usam cookie HttpOnly, Secure e SameSite Strict. O conteúdo armazenado no R2 recebe criptografia AES-256-GCM no nível da aplicação.</p></div></section>
          </div>
        </section>
      </div>}

      {notice && <div className="toast"><CheckCircle2 size={17} />{notice}</div>}
    </div>
  );
}
