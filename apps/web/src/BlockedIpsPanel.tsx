import { useEffect, useState } from 'react';
import { Ban, LoaderCircle, RefreshCw, ShieldCheck, Unlock } from 'lucide-react';
import { ApiError, mailApi, type BlockedIp } from './api';

function when(timestamp: number | null): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp * 1000));
}

function device(userAgent: string | null): string {
  const value = (userAgent || '').toLowerCase();
  if (value.includes('iphone') || value.includes('ipad')) return 'iPhone / iPad';
  if (value.includes('android')) return 'Android';
  if (value.includes('windows')) return 'Windows';
  if (value.includes('macintosh') || value.includes('mac os')) return 'Mac';
  if (value.includes('linux')) return 'Linux';
  return 'Dispositivo desconhecido';
}

export default function BlockedIpsPanel() {
  const [ips, setIps] = useState<BlockedIp[]>([]);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const status = await mailApi.securityStatus();
      if (!status.stepUpValid) {
        setVisible(false);
        return;
      }
      const result = await mailApi.adminBlockedIps();
      setIps(result.ips);
      setVisible(true);
      setError('');
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 428)) {
        setVisible(false);
        return;
      }
      setVisible(true);
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os IPs bloqueados.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!visible) void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const unblock = async (item: BlockedIp) => {
    setWorking(item.id);
    setError('');
    try {
      await mailApi.unblockIp(item.id);
      setIps((current) => current.filter((row) => row.id !== item.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível desbloquear o IP.');
    } finally {
      setWorking(null);
    }
  };

  if (!visible) return null;

  return <section className="settings-section blocked-ips-panel">
    <div className="security-events-title">
      <h3><Ban size={15} /> IPs bloqueados</h3>
      <button className="icon-button" type="button" onClick={() => void load()} disabled={loading} aria-label="Atualizar IPs bloqueados"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
    </div>
    <p className="settings-hint">Um IP entra aqui somente depois de duas sequências de três senhas incorretas, separadas pelo bloqueio de 30 minutos e pelo Turnstile.</p>

    {loading && ips.length === 0 && <div className="settings-loading"><LoaderCircle size={18} className="spin" /> Carregando bloqueios</div>}
    {!loading && ips.length === 0 && <div className="blocked-ip-empty"><ShieldCheck size={18} /> Nenhum IP bloqueado.</div>}

    <div className="blocked-ip-list">
      {ips.map((item) => <article className="blocked-ip-card" key={item.id}>
        <div className="blocked-ip-copy">
          <strong>{item.ip}</strong>
          <span>Bloqueado em {when(item.blockedAt)}</span>
          <span>Última conta tentada: {item.lastEmail || 'não identificada'}</span>
          <small>{device(item.userAgent)} · ref. {item.id.slice(0, 12)}</small>
        </div>
        <button className="secondary-button" type="button" disabled={working !== null} onClick={() => void unblock(item)}>
          {working === item.id ? <LoaderCircle size={14} className="spin" /> : <Unlock size={14} />}
          Desbloquear
        </button>
      </article>)}
    </div>
    {error && <div className="form-error settings-error">{error}</div>}
  </section>;
}
