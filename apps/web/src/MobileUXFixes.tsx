import { useEffect } from 'react';

function prepareComposer(): void {
  const compose = document.querySelector<HTMLElement>('.m-compose');
  if (!compose) return;

  if (compose.dataset.copiesAutoExpanded !== '1') {
    const toggle = Array.from(compose.querySelectorAll<HTMLButtonElement>('.m-compose-row > button'))
      .find((button) => (button.textContent || '').replace(/\s+/g, '').toLowerCase().includes('cc/cco'));

    if (toggle) {
      compose.dataset.copiesAutoExpanded = '1';
      toggle.click();
      window.requestAnimationFrame(() => {
        toggle.hidden = true;
        for (const row of Array.from(compose.querySelectorAll<HTMLElement>('.m-compose-row'))) {
          const label = row.querySelector('label')?.textContent?.trim().toLowerCase();
          if (label === 'cc' || label === 'cco') row.classList.add('copy-row');
        }
      });
    }
  }
}

/**
 * iOS updates VisualViewport many times while its keyboard animates and while
 * the user scrolls a contentEditable. Moving the fixed composer on every one
 * of those events creates a feedback loop (the visible "bounce").
 *
 * We never mirror offsetTop and never listen to VisualViewport.scroll. We only
 * take a settled height snapshot after resize, so the editor can shrink for
 * the keyboard without fighting the user's finger/caret scrolling.
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
    let prepareFrame = 0;
    let resizeTimer = 0;

    const prepare = () => {
      window.cancelAnimationFrame(prepareFrame);
      prepareFrame = window.requestAnimationFrame(prepareComposer);
    };

    const settle = () => {
      window.clearTimeout(resizeTimer);
      // Wait until the iOS keyboard/viewport animation is essentially settled.
      resizeTimer = window.setTimeout(settleViewportHeight, 140);
    };

    prepare();
    settleViewportHeight();

    document.addEventListener('click', prepare, true);
    document.addEventListener('focusin', prepare, true);
    window.addEventListener('resize', settle, { passive: true });
    window.visualViewport?.addEventListener('resize', settle, { passive: true });

    return () => {
      window.cancelAnimationFrame(prepareFrame);
      window.clearTimeout(resizeTimer);
      document.removeEventListener('click', prepare, true);
      document.removeEventListener('focusin', prepare, true);
      window.removeEventListener('resize', settle);
      window.visualViewport?.removeEventListener('resize', settle);
    };
  }, []);

  return null;
}
