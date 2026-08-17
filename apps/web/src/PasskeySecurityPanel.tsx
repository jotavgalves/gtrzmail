import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Fingerprint, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import { mailApi, type PasskeyInfo, type SecurityStatus } from './api';
import { passkeysSupported, registerPasskey, stepUpWithPasskey } from './passkeys';

function dateLabel(timestamp: number | null): string {
  if (!timestamp) return 'Nunca usada';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp * 1000));
}

export function StepUpGate({
  children,
  title = 'Confirme sua identidade',
  description = 'Ações sensíveis exigem uma confirmação recente da sua identidade.',
  onNotice
}: {
  children: ReactNode;
  title?: string;
  description?: string;
  onNotice: (message: string) => void;
}) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try { setStatus(await mailApi.securityStatus()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível verificar a segurança da sessão.'); }
  };
  useEffect(() => { void load(); }, []);

  const passwordUnlock = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true); setError('');
    try {
      await mailApi.passwordStepUp(password);
      setPassword('');
      await load();
      onNotice('Identidade confirmada por 10 minutos.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar sua identidade.');
    } finally { setWorking(false); }
  };

  const passkeyUnlock = async () => {
    setWorking(true); setError('');
    try {
      await stepUpWithPasskey();
      await load();
      onNotice('Identidade confirmada com passkey por 10 minutos.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar a passkey.');
    } finally { setWorking(false); }
  };

  if (status?.stepUpValid) return <>{children}</>;

  return <section className="settings-section security-stepup">
    <h3><ShieldCheck size={15} /> {title}</h3>
    <p className="settings-hint">{description}</p>
    <form className="settings-form" onSubmit={passwordUnlock}>
      <input type="password" autoComplete="current-password" placeholder="Senha atual" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button className="secondary-button" disabled={working}>{working ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} Confirmar com senha</button>
    </form>
    {Boolean(status?.passkeyCount) && passkeysSupported() && <button className="secondary-button" type="button" disabled={working} onClick={() => void passkeyUnlock()}><Fingerprint size={15} /> Confirmar com passkey</button>}
    {error && <div className="form-error settings-error">{error}</div>}
  </section>;
}

export function PasskeyPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('Meu dispositivo');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [nextStatus, keys] = await Promise.all([mailApi.securityStatus(), mailApi.passkeys()]);
      setStatus(nextStatus);
      setPasskeys(keys.passkeys);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as passkeys.');
    }
  };
  useEffect(() => { void load(); }, []);

  const unlockPassword = async (event: FormEvent) => {
    event.preventDefault(); setWorking(true); setError('');
    try {
      await mailApi.passwordStepUp(password);
      setPassword('');
      await load();
      onNotice('Identidade confirmada. Agora você pode gerenciar passkeys por 10 minutos.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Senha incorreta.'); }
    finally { setWorking(false); }
  };

  const unlockPasskey = async () => {
    setWorking(true); setError('');
    try {
      await stepUpWithPasskey();
      await load();
      onNotice('Identidade confirmada com passkey.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Falha ao verificar a passkey.'); }
    finally { setWorking(false); }
  };

  const add = async () => {
    if (!status?.stepUpValid) { setError('Confirme sua identidade antes de adicionar uma passkey.'); return; }
    setWorking(true); setError('');
    try {
      await registerPasskey(name);
      await load();
      onNotice('Passkey cadastrada. Você já pode usá-la para entrar sem senha.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível cadastrar a passkey.'); }
    finally { setWorking(false); }
  };

  const remove = async (passkey: PasskeyInfo) => {
    if (!status?.stepUpValid) { setError('Confirme sua identidade antes de excluir uma passkey.'); return; }
    setWorking(true); setError('');
    try {
      await mailApi.deletePasskey(passkey.id);
      await load();
      onNotice('Passkey removida.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível remover a passkey.'); }
    finally { setWorking(false); }
  };

  return <section className="settings-section passkey-panel">
    <h3><Fingerprint size={16} /> Passkeys</h3>
    <p className="settings-hint">Use Face ID, Touch ID, Windows Hello, PIN ou uma chave FIDO2. A verificação local do dispositivo é obrigatória e a chave privada nunca é enviada ao GTRZ Mail.</p>

    {!status?.stepUpValid && <div className="passkey-unlock">
      <form className="settings-form" onSubmit={unlockPassword}>
        <input type="password" autoComplete="current-password" placeholder="Confirme sua senha para gerenciar passkeys" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="secondary-button" disabled={working}>{working ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} Confirmar senha</button>
      </form>
      {passkeys.length > 0 && passkeysSupported() && <button className="secondary-button" type="button" disabled={working} onClick={() => void unlockPasskey()}><Fingerprint size={15} /> Usar passkey</button>}
    </div>}

    {status?.stepUpValid && passkeysSupported() && <div className="settings-form settings-form-grid">
      <input type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome deste dispositivo" />
      <button className="primary-button" type="button" disabled={working} onClick={() => void add()}>{working ? <LoaderCircle size={15} className="spin" /> : <Fingerprint size={15} />} Adicionar passkey</button>
    </div>}

    {!passkeysSupported() && <div className="form-error settings-error">Este navegador/dispositivo não oferece WebAuthn em contexto seguro.</div>}

    {passkeys.length > 0 && <div className="admin-account-list">
      {passkeys.map((passkey) => <article className="admin-account" key={passkey.id}>
        <div className="admin-account-head"><div><strong>{passkey.name}</strong><span>{passkey.backedUp ? 'Passkey sincronizada/backup disponível' : 'Credencial deste dispositivo'} · último uso: {dateLabel(passkey.lastUsedAt)}</span></div><div className="admin-tags"><b className="active">WebAuthn</b></div></div>
        {status?.stepUpValid && <div className="admin-actions"><button className="secondary-button" type="button" disabled={working} onClick={() => void remove(passkey)}><Trash2 size={14} /> Remover</button></div>}
      </article>)}
    </div>}
    {error && <div className="form-error settings-error">{error}</div>}
  </section>;
}
