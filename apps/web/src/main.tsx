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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <DeferredEnhancers />
  </StrictMode>
);
