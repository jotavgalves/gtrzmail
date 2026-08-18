import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, LoaderCircle, LogIn, MailPlus, PenLine, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { mailApi, type AccountSession, type AdminAccount, type SessionAccount } from './api';
import RichTextEditor from './RichTextEditor';
import { PasskeyPanel, StepUpGate } from './PasskeySecurityPanel';

function formatSessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp * 1000));
}

function deviceLabel(userAgent: string): string {
  const value = userAgent.toLowerCase();
  if (value.includes('iphone') || value.includes('ipad')) return 'iPhone / iPad';
  if (value.includes('android')) return 'Android';
  if (value.includes('windows')) return 'Windows';
  if (value.includes('macintosh') || value.includes('mac os')) return 'Mac';
  if (value.includes('linux')) return 'Linux';
  return 'Dispositivo';
}

function AccountSessionsBlock({ onNotice }: { onNotice: (message: string) => void }) {
  const [accounts, setAccounts] = useState<SessionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await mailApi.sessionAccounts();
      setAccounts(result.accounts);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar as contas conectadas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const switchTo = async (account: SessionAccount) => {
    if (account.current) return;
    setSwitchingTo(account.id);
    setError('');
    try {
      await mailApi.switchAccount(account.id);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alternar a conta.');
      setSwitchingTo(null);
    }
  };

  const addAccount = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await mailApi.login(email, password);
      onNotice('Conta adicionada com segurança.');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível adicionar a conta.');
      setSubmitting(false);
    }
  };

  return (
    <section className="settings-section account-switcher-panel">
      <h3><Users size={15} /> Alternar conta</h3>
      <p className="settings-hint">Contas autenticadas neste navegador ficam disponíveis para troca rápida. As sessões são mantidas em cookies HttpOnly; a senha não é armazenada no navegador.</p>
      {loading ? <div className="settings-loading"><LoaderCircle size={18} className="spin" /> Carregando contas</div> : (
        <div className="admin-account-list">
          {accounts.map((account) => (
            <article className="admin-account" key={account.id}>
              <div className="admin-account-head">
                <div><strong>{account.displayName}</strong><span>{account.email}</span></div>
                <div className="admin-tags">{account.current && <b className="active"><CheckCircle2 size={11} /> Atual</b>}{account.isAdmin && <b>Admin</b>}</div>
              </div>
              {!account.current && <div className="admin-actions"><button className="secondary-button" type="button" disabled={switchingTo !== null} onClick={() => void switchTo(account)}>{switchingTo === account.id ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />} Entrar nesta conta</button></div>}
            </article>
          ))}
        </div>
      )}
      {!adding ? <button className="secondary-button" type="button" onClick={() => setAdding(true)}><UserPlus size={14} /> Adicionar outra conta</button> : (
        <form className="settings-form" onSubmit={addAccount}>
          <input type="email" autoComplete="username" placeholder="outra-conta@gtrz.com.br" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" autoComplete="current-password" placeholder="Senha desta conta" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <div className="admin-actions">
            <button className="primary-button" disabled={submitting}>{submitting ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />} Adicionar e entrar</button>
            <button className="secondary-button" type="button" disabled={submitting} onClick={() => { setAdding(false); setEmail(''); setPassword(''); setError(''); }}>Cancelar</button>
          </div>
        </form>
      )}
      {error && <div className="form-error settings-error">{error}</div>}
    </section>
  );
}

function DeviceSessionsBlock({ onNotice }: { onNotice: (message: string) => void }) {
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await mailApi.accountSessions();
      setSessions(result.sessions);
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível carregar as sessões.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const revoke = async (session: AccountSession) => {
    if (session.current) return;
    setWorking(true); setError('');
    try { await mailApi.revokeSession(session.id); onNotice('Sessão encerrada.'); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível encerrar a sessão.'); }
    finally { setWorking(false); }
  };

  const revokeOthers = async () => {
    setWorking(true); setError('');
    try {
      const result = await mailApi.revokeOtherSessions();
      onNotice(result.revoked ? `${result.revoked} sessão(ões) encerrada(s).` : 'Não havia outras sessões ativas.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível encerrar as outras sessões.'); }
    finally { setWorking(false); }
  };

  return <section className="settings-section device-sessions-panel">
    <h3><ShieldCheck size={15} /> Dispositivos conectados</h3>
    <p className="settings-hint">Sessões ficam inativas após 12 horas sem uso. Ao trocar sua senha, todas as outras sessões são encerradas e a sessão atual recebe um novo token.</p>
    {loading ? <div className="settings-loading"><LoaderCircle size={18} className="spin" /> Carregando dispositivos</div> : <>
      <div className="admin-account-list">{sessions.map((session) => <article className="admin-account" key={session.id}>
        <div className="admin-account-head"><div><strong>{deviceLabel(session.userAgent)}</strong><span>Último uso: {formatSessionDate(session.lastSeenAt)} · expira: {formatSessionDate(session.expiresAt)}</span></div><div className="admin-tags">{session.current && <b className="active"><CheckCircle2 size={11} /> Este dispositivo</b>}</div></div>
        {!session.current && <div className="admin-actions"><button className="secondary-button" type="button" disabled={working} onClick={() => void revoke(session)}>Encerrar sessão</button></div>}
      </article>)}</div>
      {sessions.some((session) => !session.current) && <button className="secondary-button" type="button" disabled={working} onClick={() => void revokeOthers()}>{working ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />} Encerrar todas as outras sessões</button>}
    </>}
    {error && <div className="form-error settings-error">{error}</div>}
  </section>;
}

export function SignaturePanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { mailApi.signature().then((result) => setHtml(result.html)).catch((err) => setError(err instanceof Error ? err.message : 'Não foi possível carregar a assinatura.')).finally(() => setLoading(false)); }, []);
  const save = async () => {
    setSaving(true); setError('');
    try { const result = await mailApi.updateSignature(html); setHtml(result.html); onNotice('Assinatura salva.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível salvar a assinatura.'); }
    finally { setSaving(false); }
  };
  return <section className="settings-section signature-panel">
    <h3><PenLine size={15} /> Assinatura</h3>
    <p className="settings-hint">A assinatura é adicionada automaticamente às novas mensagens, respostas e encaminhamentos. Formatação e links são permitidos; imagens da assinatura ficam bloqueadas por segurança.</p>
    {loading ? <div className="settings-loading"><LoaderCircle size={18} className="spin" /> Carregando assinatura</div> : <>
      <RichTextEditor value={html} compact allowImages={false} placeholder="Ex.: João Gonçalves · GTRZ Eventos" onChange={setHtml} onError={setError} />
      {error && <div className="form-error settings-error">{error}</div>}
      <button className="secondary-button signature-save" type="button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="spin" /> : <PenLine size={15} />} Salvar assinatura</button>
    </>}
  </section>;
}

export function PasswordPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (newPassword.length < 12) { setError('A nova senha precisa ter pelo menos 12 caracteres.'); return; }
    if (newPassword !== confirm) { setError('A confirmação não coincide com a nova senha.'); return; }
    setLoading(true);
    try {
      await mailApi.changePassword(currentPassword, newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirm('');
      onNotice('Senha alterada. Outras sessões foram encerradas e este dispositivo recebeu um novo token.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível alterar a senha.'); }
    finally { setLoading(false); }
  };

  return <>
    <AccountSessionsBlock onNotice={onNotice} />
    <PasskeyPanel onNotice={onNotice} />
    <DeviceSessionsBlock onNotice={onNotice} />
    <section className="settings-section">
      <h3><KeyRound size={15} /> Alterar senha</h3>
      <form className="settings-form" onSubmit={submit}>
        <input type="password" autoComplete="current-password" placeholder="Senha atual" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="Nova senha (12+ caracteres)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="Confirmar nova senha" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error && <div className="form-error">{error}</div>}
        <button className="secondary-button" disabled={loading}>{loading ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />} Atualizar senha</button>
      </form>
    </section>
  </>;
}

function AdminPanelBody({ onNotice }: { onNotice: (message: string) => void }) {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [aliasAddress, setAliasAddress] = useState('');
  const [aliasName, setAliasName] = useState('');

  const load = async () => {
    setLoading(true);
    try { const result = await mailApi.adminAccounts(); setAccounts(result.accounts); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Falha ao carregar contas.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setCreating(true);
    try {
      await mailApi.createAccount({ email, displayName, password });
      setEmail(''); setDisplayName(''); setPassword('');
      onNotice('Conta criada. Para alternar para ela, use “Adicionar outra conta” e autentique a nova conta uma vez.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Falha ao criar conta.'); }
    finally { setCreating(false); }
  };

  const toggle = async (account: AdminAccount) => {
    try { await mailApi.setAccountStatus(account.id, !account.isActive); onNotice(account.isActive ? 'Conta desativada.' : 'Conta ativada.'); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Falha ao atualizar conta.'); }
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault(); if (!resetFor) return;
    try { await mailApi.resetAccountPassword(resetFor, resetPassword); setResetFor(null); setResetPassword(''); onNotice('Senha redefinida e sessões da conta encerradas. Ela precisará ser autenticada novamente no alternador.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Falha ao redefinir senha.'); }
  };

  const submitAlias = async (event: FormEvent) => {
    event.preventDefault(); if (!aliasFor) return;
    try {
      await mailApi.addMailbox({ userId: aliasFor, address: aliasAddress, displayName: aliasName });
      setAliasFor(null); setAliasAddress(''); setAliasName(''); onNotice('Caixa adicional criada.'); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Falha ao criar caixa.'); }
  };

  return <section className="settings-section admin-panel">
    <h3><Users size={15} /> Administração</h3>
    <p className="settings-hint">Crie contas e endereços @gtrz.com.br sem usar o terminal. A confirmação forte expira em 10 minutos.</p>
    <form className="settings-form settings-form-grid" onSubmit={create}>
      <input type="text" placeholder="Nome exibido" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      <input type="email" placeholder="usuario@gtrz.com.br" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" autoComplete="new-password" placeholder="Senha inicial (12+ caracteres)" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button className="primary-button" disabled={creating}>{creating ? <LoaderCircle size={15} className="spin" /> : <UserPlus size={15} />} Criar conta</button>
    </form>
    {error && <div className="form-error settings-error">{error}</div>}
    {loading ? <div className="settings-loading"><LoaderCircle size={18} className="spin" /> Carregando contas</div> : <div className="admin-account-list">{accounts.map((account) => <article className="admin-account" key={account.id}>
      <div className="admin-account-head"><div><strong>{account.displayName}</strong><span>{account.email}</span></div><div className="admin-tags">{account.isAdmin && <b>Admin</b>}<b className={account.isActive ? 'active' : 'inactive'}>{account.isActive ? 'Ativa' : 'Desativada'}</b></div></div>
      <div className="admin-mailboxes">{account.mailboxes.map((mailbox) => <span key={mailbox.id}>{mailbox.address}{mailbox.isDefault ? ' · principal' : ''}</span>)}</div>
      <div className="admin-actions">
        {!account.isAdmin && <button className="secondary-button" type="button" onClick={() => void toggle(account)}>{account.isActive ? 'Desativar' : 'Ativar'}</button>}
        <button className="secondary-button" type="button" onClick={() => { setResetFor(account.id); setAliasFor(null); }}>Redefinir senha</button>
        <button className="secondary-button" type="button" onClick={() => { setAliasFor(account.id); setResetFor(null); setAliasName(account.displayName); }}><MailPlus size={14} /> Nova caixa</button>
      </div>
      {resetFor === account.id && <form className="inline-admin-form" onSubmit={submitReset}><input type="password" autoComplete="new-password" placeholder="Nova senha (12+ caracteres)" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} required /><button className="primary-button">Salvar senha</button><button className="secondary-button" type="button" onClick={() => setResetFor(null)}>Cancelar</button></form>}
      {aliasFor === account.id && <form className="inline-admin-form" onSubmit={submitAlias}><input type="email" placeholder="alias@gtrz.com.br" value={aliasAddress} onChange={(e) => setAliasAddress(e.target.value)} required /><input type="text" placeholder="Nome exibido" value={aliasName} onChange={(e) => setAliasName(e.target.value)} required /><button className="primary-button">Criar caixa</button><button className="secondary-button" type="button" onClick={() => setAliasFor(null)}>Cancelar</button></form>}
    </article>)}</div>}
  </section>;
}

export function AdminPanel({ onNotice }: { onNotice: (message: string) => void }) {
  return <StepUpGate onNotice={onNotice} title="Administração protegida" description="Criar contas, alterar senhas, criar caixas e ativar ou desativar usuários exige confirmação recente por senha ou passkey."><AdminPanelBody onNotice={onNotice} /></StepUpGate>;
}
