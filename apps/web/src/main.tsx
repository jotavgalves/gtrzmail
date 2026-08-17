import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installPerformanceTuning } from './performance';
import './styles.css';
import './enhancements.css';
import './rich-email.css';
import './toolbar.css';
import './thread-push.css';
import './ui-fixes.css';
import './mobile.css';
import './mobile-account.css';
import './mobile-native.css';

const MobileApp = lazy(() => import('./MobileApp'));
const AccountMenuOverlay = lazy(() => import('./AccountMenuOverlay'));
const PushEnhancer = lazy(() => import('./PushEnhancer'));
const ThreadListEnhancer = lazy(() => import('./ThreadListEnhancer'));
const ThreadOverlay = lazy(() => import('./ThreadOverlay'));
const ToolbarEnhancer = lazy(() => import('./ToolbarEnhancer'));

installPerformanceTuning();

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => undefined);
  });
}

function useMobileViewport() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 820px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const change = () => setMobile(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  return mobile;
}

function DeferredEnhancers() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const reveal = () => setReady(true);
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(reveal, { timeout: 700 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }

    const timer = window.setTimeout(reveal, 250);
    return () => window.clearTimeout(timer);
  }, []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <AccountMenuOverlay />
      <ToolbarEnhancer />
      <ThreadListEnhancer />
      <ThreadOverlay />
      <PushEnhancer />
    </Suspense>
  );
}

function RootApp() {
  const mobile = useMobileViewport();

  if (mobile) {
    return (
      <Suspense fallback={<main className="m-boot"><img src="/brand/gtrz-symbol.svg" alt="GTRZ" /></main>}>
        <MobileApp />
      </Suspense>
    );
  }

  return (
    <>
      <App />
      <DeferredEnhancers />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
