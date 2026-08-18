import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock3, LoaderCircle, ShieldCheck } from 'lucide-react';
import { ApiError, mailApi, type LoginProtectionState } from './api';

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = 'gtrz-turnstile-api';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let currentTurnstileToken = '';

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      const wait = window.setInterval(() => {
        if (!window.turnstile) return;
        window.clearInterval(wait);
        resolve();
      }, 50);
      window.setTimeout(() => {
        window.clearInterval(wait);
        if (!window.turnstile) reject(new Error('Turnstile não carregou.'));
      }, 8000);
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.defer = true;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Não foi possível carregar a verificação anti-bot.'));
    document.head.appendChild(script);
  });
}

export default function LoginProtectionEnhancer() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<LoginProtectionState | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const widgetHostRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  const refresh = async () => {
    try {
      const next = await mailApi.loginProtectionState();
      setState(next);
      setRemaining(next.cooldownSeconds);
      setError('');
      if (!next.captchaRequired) currentTurnstileToken = '';
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) return;
      setError(cause instanceof Error ? cause.message : 'Não foi possível verificar o estado de segurança do login.');
    }
  };

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    let cancelled = false;
    const timers: number[] = [];

    const locate = () => {
      if (cancelled || host?.isConnected) return;
      const form = root.querySelector<HTMLFormElement>('form.login-form, form.m-login-card');
      if (!form) return;
      let target = form.querySelector<HTMLElement>('[data-gtrz-login-protection-host]');
      if (!target) {
        target = document.createElement('div');
        target.dataset.gtrzLoginProtectionHost = '1';
        target.className = 'login-protection-host';
        form.appendChild(target);
      }
      if (!cancelled) setHost(target);
    };

    locate();
    for (const delay of [50, 150, 350, 700, 1400, 2500]) timers.push(window.setTimeout(locate, delay));
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (!host) return;
    void refresh();
  }, [host]);

  useEffect(() => {
    if (!host) return;
    const originalLogin = mailApi.login;
    mailApi.login = async (email: string, password: string, suppliedToken?: string) => {
      if (state?.cooldownSeconds && state.cooldownSeconds > 0) {
        throw new ApiError('Este IP ainda está no bloqueio temporário de 30 minutos.', 429);
      }
      if (state?.captchaRequired && !(suppliedToken || currentTurnstileToken)) {
        throw new ApiError('Conclua a verificação anti-bot antes de tentar novamente.', 428);
      }
      setLoading(true);
      try {
        const result = await originalLogin(email, password, suppliedToken || currentTurnstileToken || undefined);
        currentTurnstileToken = '';
        return result;
      } finally {
        setLoading(false);
        window.setTimeout(() => void refresh(), 80);
      }
    };
    return () => { mailApi.login = originalLogin; };
  }, [host, state?.captchaRequired, state?.cooldownSeconds]);

  useEffect(() => {
    if (!state?.cooldownSeconds) return;
    setRemaining(state.cooldownSeconds);
    const timer = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          window.setTimeout(() => void refresh(), 50);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state?.cooldownSeconds]);

  useEffect(() => {
    if (!state?.captchaRequired || !state.siteKey || !widgetHostRef.current) return;
    let cancelled = false;
    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile || !widgetHostRef.current) return;
        if (widgetIdRef.current) {
          try { window.turnstile.remove(widgetIdRef.current); } catch { /* noop */ }
          widgetIdRef.current = null;
        }
        currentTurnstileToken = '';
        widgetIdRef.current = window.turnstile.render(widgetHostRef.current, {
          sitekey: state.siteKey,
          theme: 'dark',
          size: 'flexible',
          action: 'login_after_failures',
          callback: (token: string) => {
            currentTurnstileToken = token;
            setError('');
          },
          'expired-callback': () => {
            currentTurnstileToken = '';
          },
          'error-callback': () => {
            currentTurnstileToken = '';
            setError('A verificação anti-bot falhou. Atualize o desafio e tente novamente.');
          }
        });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o CAPTCHA.'));

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* noop */ }
      }
      widgetIdRef.current = null;
      currentTurnstileToken = '';
    };
  }, [state?.captchaRequired, state?.siteKey]);

  const description = useMemo(() => {
    if (!state) return '';
    if (remaining > 0) return `Três senhas incorretas. Novas tentativas serão liberadas em ${formatRemaining(remaining)}.`;
    if (state.captchaRequired) return 'Antes das próximas três tentativas, confirme que você é uma pessoa.';
    if (state.attemptsRemaining < 3) return `Proteção ativa: restam ${state.attemptsRemaining} tentativa${state.attemptsRemaining === 1 ? '' : 's'} nesta etapa.`;
    return '';
  }, [state, remaining]);

  if (!host?.isConnected) return null;
  const mobile = Boolean(host.closest('.m-login-card'));

  return createPortal(<div className={`login-protection ${mobile ? 'mobile' : ''}`}>
    {(description || loading) && <div className="login-protection-status">
      {remaining > 0 ? <Clock3 size={16} /> : loading ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
      <span>{loading ? 'Validando acesso…' : description}</span>
    </div>}

    {state?.captchaRequired && state.captchaConfigured && state.siteKey && <div className="login-turnstile" ref={widgetHostRef} />}
    {state?.captchaRequired && !state.captchaConfigured && <div className={mobile ? 'm-form-error' : 'form-error'}>Turnstile ainda não está configurado no servidor.</div>}
    {error && <div className={mobile ? 'm-form-error' : 'form-error'}>{error}</div>}
  </div>, host);
}
