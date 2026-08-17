import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronRight, LogIn, LogOut, Settings, UserPlus, X } from 'lucide-react';
import { mailApi, type SessionAccount } from './api';

type AnchorPosition = {
  top: number;
  right: number;
};

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'GM';
  return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase();
}

function settingsButton(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-bottom > button'));
  return buttons.find((button) => button.textContent?.toLowerCase().includes('configurações')) || null;
}

export default function AccountMenuOverlay() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<AnchorPosition>({ top: 68, right: 18 });
  const [accounts, setAccounts] = useState<SessionAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  const loadAccounts = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await mailApi.sessionAccounts();
      setAccounts(result.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar as contas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const makeChipInteractive = () => {
      for (const chip of document.querySelectorAll<HTMLElement>('.user-chip')) {
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('aria-haspopup', 'menu');
        chip.setAttribute('aria-label', 'Abrir menu da conta');
        chip.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    };

    makeChipInteractive();
    const observer = new MutationObserver(makeChipInteractive);
    observer.observe(document.body, { childList: true, subtree: true });

    const showForChip = (chip: HTMLElement) => {
      const rect = chip.getBoundingClientRect();
      setPosition({
        top: Math.min(window.innerHeight - 16, rect.bottom + 8),
        right: Math.max(10, window.innerWidth - rect.right)
      });
      setOpen((current) => {
        const next = !current;
        if (next) void loadAccounts();
        return next;
      });
      setShowAdd(false);
      setError('');
    };

    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const chip = target?.closest<HTMLElement>('.user-chip');
      if (chip) {
        event.preventDefault();
        event.stopPropagation();
        showForChip(chip);
        return;
      }
      if (open && !target?.closest('.account-menu-popover')) setOpen(false);
    };

    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.classList.contains('user-chip') && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) {
        event.preventDefault();
        showForChip(target);
        return;
      }
      if (event.key === 'Escape') setOpen(false);
    };

    const reposition = () => {
      if (!open) return;
      const chip = document.querySelector<HTMLElement>('.user-chip');
      if (!chip) return;
      const rect = chip.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: Math.max(10, window.innerWidth - rect.right) });
    };

    document.addEventListener('click', click, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const switchAccount = async (account: SessionAccount) => {
    if (account.current || switchingId) return;
    setSwitchingId(account.id);
    setError('');
    try {
      await mailApi.switchAccount(account.id);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alternar a conta.');
      setSwitchingId(null);
    }
  };

  const addAccount = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setError('');
    try {
      await mailApi.login(email, password);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível adicionar a conta.');
      setAdding(false);
    }
  };

  const openSettings = () => {
    setOpen(false);
    settingsButton()?.click();
  };

  const logout = async () => {
    setError('');
    try {
      await mailApi.logout();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível sair.');
    }
  };

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      className="account-menu-popover"
      role="menu"
      aria-label="Contas do GTRZ Mail"
      style={{ top: position.top, right: position.right }}
    >
      <div className="account-menu-head">
        <div>
          <strong>Contas</strong>
          <span>Alterne sem digitar a senha novamente</span>
        </div>
        <button className="account-menu-icon" type="button" onClick={() => setOpen(false)} aria-label="Fechar"><X size={16} /></button>
      </div>

      <div className="account-menu-list">
        {loading && <div className="account-menu-state">Carregando contas…</div>}
        {!loading && accounts.map((account) => (
          <button
            key={account.id}
            className={`account-menu-account ${account.current ? 'current' : ''}`}
            type="button"
            role="menuitem"
            disabled={Boolean(switchingId) || account.current}
            onClick={() => void switchAccount(account)}
          >
            <span className="account-menu-avatar">{initials(account.displayName)}</span>
            <span className="account-menu-copy">
              <strong>{account.displayName}</strong>
              <small>{account.email}</small>
            </span>
            {account.current ? <span className="account-current-mark"><Check size={14} /> Atual</span> : switchingId === account.id ? <span className="account-menu-wait">Entrando…</span> : <ChevronRight size={16} />}
          </button>
        ))}
      </div>

      {showAdd ? (
        <form className="account-menu-add" onSubmit={addAccount}>
          <div className="account-menu-add-title"><LogIn size={15} /> Adicionar outra conta</div>
          <input type="email" autoComplete="username" placeholder="conta@gtrz.com.br" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <input type="password" autoComplete="current-password" placeholder="Senha desta conta" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <div className="account-menu-form-actions">
            <button className="account-menu-primary" type="submit" disabled={adding}>{adding ? 'Entrando…' : 'Adicionar e entrar'}</button>
            <button className="account-menu-secondary" type="button" disabled={adding} onClick={() => { setShowAdd(false); setEmail(''); setPassword(''); setError(''); }}>Cancelar</button>
          </div>
        </form>
      ) : (
        <button className="account-menu-action" type="button" role="menuitem" onClick={() => setShowAdd(true)}><UserPlus size={16} /> Adicionar outra conta</button>
      )}

      {error && <div className="account-menu-error">{error}</div>}

      <div className="account-menu-separator" />
      <button className="account-menu-action" type="button" role="menuitem" onClick={openSettings}><Settings size={16} /> Configurações</button>
      <button className="account-menu-action danger" type="button" role="menuitem" onClick={() => void logout()}><LogOut size={16} /> Sair desta conta</button>
    </div>
  );
}
