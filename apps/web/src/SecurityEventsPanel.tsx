import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { mailApi, type SecurityEvent } from './api';

const labels: Record<string, string> = {
  'auth.login': 'Login com senha',
  'auth.passkey_login': 'Login com passkey',
  'auth.password_changed': 'Senha alterada',
  'auth.session_rotated_after_password_change': 'Token da sessão renovado',
  'auth.session_revoked': 'Sessão encerrada',
  'auth.other_sessions_revoked': 'Outras sessões encerradas',
  'auth.session_idle_expired': 'Sessão expirada por inatividade',
  'auth.session_user_agent_mismatch_revoked': 'Sessão revogada por mudança de navegador',
  'auth.session_network_changed': 'Rede da sessão alterada',
  'auth.passkey_registered': 'Passkey cadastrada',
  'auth.passkey_deleted': 'Passkey removida',
  'auth.step_up_password_succeeded': 'Identidade confirmada por senha',
  'auth.step_up_password_failed': 'Falha na confirmação por senha',
  'auth.step_up_passkey_succeeded': 'Identidade confirmada por passkey',
  'admin.account_created': 'Conta criada pelo administrador',
  'admin.account_enabled': 'Conta ativada',
  'admin.account_disabled': 'Conta desativada',
  'admin.password_reset': 'Senha de conta redefinida',
  'admin.mailbox_created': 'Caixa adicional criada',
  'crypto.key_rotation_started': 'Rotação da chave mestra iniciada',
  'crypto.key_rotation_completed': 'Rotação da chave mestra concluída',
  'mail.rate_limited': 'Envio bloqueado por limite de segurança'
};

function suspicious(action: string): boolean {
  return action.includes('failed') || action.includes('mismatch') || action.includes('network_changed') || action === 'mail.rate_limited';
}

function when(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp * 1000));
}

export default function SecurityEventsPanel() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await mailApi.securityEvents();
      setEvents(result.events);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o histórico de segurança.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return <section className="settings-section security-events-panel">
    <div className="security-events-title">
      <h3><ShieldCheck size={15} /> Atividade de segurança</h3>
      <button className="icon-button" type="button" onClick={() => void load()} disabled={loading} aria-label="Atualizar atividade de segurança"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
    </div>
    <p className="settings-hint">Logins, passkeys, mudanças de sessão, bloqueios de envio e ações administrativas recentes. Se você não reconhecer um evento, troque a senha e encerre as outras sessões.</p>
    {loading && events.length === 0 ? <div className="settings-loading"><LoaderCircle size={18} className="spin" /> Carregando atividade</div> : null}
    {!loading && events.length === 0 ? <div className="settings-hint">Nenhum evento de segurança registrado ainda.</div> : null}
    <div className="security-event-list">
      {events.slice(0, 20).map((event) => <article className={`security-event ${suspicious(event.action) ? 'warning' : ''}`} key={event.id}>
        <div>{suspicious(event.action) ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}</div>
        <div><strong>{labels[event.action] || event.action}</strong><span>{when(event.createdAt)}</span></div>
      </article>)}
    </div>
    {error && <div className="form-error settings-error">{error}</div>}
  </section>;
}
