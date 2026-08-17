import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Fingerprint, LoaderCircle } from 'lucide-react';
import { loginWithPasskey, passkeysSupported } from './passkeys';

export default function PasskeyLoginEnhancer() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;

    const locate = () => {
      if (host?.isConnected) return;
      const form = root.querySelector<HTMLFormElement>('form.login-form, form.m-login-card');
      if (!form) { setHost(null); return; }
      let target = form.querySelector<HTMLElement>('[data-gtrz-passkey-login-host]');
      if (!target) {
        target = document.createElement('div');
        target.dataset.gtrzPasskeyLoginHost = '1';
        target.className = 'passkey-login-host';
        form.appendChild(target);
      }
      setHost(target);
    };

    locate();
    const observer = new MutationObserver(locate);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [host]);

  if (!host || !passkeysSupported()) return null;
  const mobile = Boolean(host.closest('.m-login-card'));

  const login = async () => {
    const form = host.closest('form');
    const email = form?.querySelector<HTMLInputElement>('input[type="email"]')?.value || '';
    setWorking(true); setError('');
    try {
      await loginWithPasskey(email);
      window.location.reload();
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : '';
      if (name === 'NotAllowedError') setError('A passkey foi cancelada ou não pôde ser usada.');
      else setError(cause instanceof Error ? cause.message : 'Não foi possível entrar com a passkey.');
    } finally { setWorking(false); }
  };

  return createPortal(<>
    <button className={mobile ? 'm-secondary passkey-login-button' : 'secondary-button passkey-login-button'} type="button" disabled={working} onClick={() => void login()}>
      {working ? <LoaderCircle size={18} className="spin" /> : <Fingerprint size={18} />}
      Entrar com passkey
    </button>
    {error && <div className={mobile ? 'm-form-error' : 'form-error'}>{error}</div>}
  </>, host);
}
