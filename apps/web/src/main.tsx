import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AccountMenuOverlay from './AccountMenuOverlay';
import PushEnhancer from './PushEnhancer';
import ThreadListEnhancer from './ThreadListEnhancer';
import ThreadOverlay from './ThreadOverlay';
import ToolbarEnhancer from './ToolbarEnhancer';
import './styles.css';
import './enhancements.css';
import './rich-email.css';
import './toolbar.css';
import './thread-push.css';
import './ui-fixes.css';
import './mobile.css';

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AccountMenuOverlay />
    <ToolbarEnhancer />
    <ThreadListEnhancer />
    <ThreadOverlay />
    <PushEnhancer />
  </StrictMode>
);
