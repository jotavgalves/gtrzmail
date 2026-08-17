import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AccountMenuOverlay from './AccountMenuOverlay';
import './styles.css';
import './enhancements.css';

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AccountMenuOverlay />
  </StrictMode>
);
