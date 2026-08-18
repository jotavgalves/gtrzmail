import { useEffect } from 'react';

/**
 * Keep the full-screen mobile composer aligned to the iOS visual viewport.
 * We intentionally do not mirror offsetTop or react to VisualViewport.scroll:
 * doing so makes contentEditable fight the keyboard/caret and causes bouncing.
 */
function settleViewportHeight(): void {
  const compose = document.querySelector<HTMLElement>('.m-compose');
  if (!compose) return;

  const viewport = window.visualViewport;
  if (!viewport) {
    compose.style.removeProperty('--compose-viewport-height');
    return;
  }

  const height = Math.max(320, Math.round(viewport.height));
  compose.style.setProperty('--compose-viewport-height', `${height}px`);
}

export default function MobileUXFixes() {
  useEffect(() => {
    let resizeTimer = 0;

    const settle = () => {
      window.clearTimeout(resizeTimer);
      // Let the iOS keyboard animation settle before changing the composer height.
      resizeTimer = window.setTimeout(settleViewportHeight, 120);
    };

    settleViewportHeight();
    window.addEventListener('resize', settle, { passive: true });
    window.visualViewport?.addEventListener('resize', settle, { passive: true });

    return () => {
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', settle);
      window.visualViewport?.removeEventListener('resize', settle);
    };
  }, []);

  return null;
}
