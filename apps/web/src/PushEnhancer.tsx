import { useEffect, useState } from 'react';
import { BellRing, LoaderCircle } from 'lucide-react';
import { enableWebPush, pushSupported, syncExistingPushSubscription } from './push';

function notificationButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-section button'))
    .find((button) => button.textContent?.toLowerCase().includes('ativar notificações')) || null;
}

export default function PushEnhancer() {
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? '' : current), 3600);
  };

  useEffect(() => {
    if (!pushSupported()) return;
    const sync = () => {
      if (!document.querySelector('.app-shell')) return;
      void syncExistingPushSubscription().catch(() => undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const decorate = () => {
      const button = notificationButton();
      if (!button) return;
      button.setAttribute('data-web-push', '1');
      button.title = 'Ativar notificações mesmo com o GTRZ Mail fechado';
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(document.body, { childList: true, subtree: true });

    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest<HTMLButtonElement>('button[data-web-push="1"]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      if (working) return;
      setWorking(true);
      void enableWebPush()
        .then(() => showNotice('Web Push ativado. Novos e-mails podem notificar mesmo com o app fechado.'))
        .catch((error) => showNotice(error instanceof Error ? error.message : 'Não foi possível ativar o Web Push.'))
        .finally(() => setWorking(false));
    };

    document.addEventListener('click', click, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', click, true);
    };
  }, [working]);

  return (
    <>
      {working && <div className="push-status-toast"><LoaderCircle size={15} className="spin" /> Configurando notificações…</div>}
      {!working && notice && <div className="push-status-toast"><BellRing size={15} /> {notice}</div>}
    </>
  );
}
