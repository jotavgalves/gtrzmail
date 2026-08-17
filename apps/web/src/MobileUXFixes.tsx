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

function syncVisualViewport(): void {
  const compose = document.querySelector<HTMLElement>('.m-compose');
  if (!compose) return;

  const viewport = window.visualViewport;
  if (!viewport) {
    compose.style.removeProperty('height');
    compose.style.removeProperty('top');
    compose.style.removeProperty('bottom');
    return;
  }

  compose.style.height = `${Math.round(viewport.height)}px`;
  compose.style.minHeight = '0';
  compose.style.top = `${Math.round(viewport.offsetTop)}px`;
  compose.style.bottom = 'auto';
}

export default function MobileUXFixes() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        prepareComposer();
        syncVisualViewport();
      });
    };

    schedule();
    document.addEventListener('click', schedule, true);
    document.addEventListener('focusin', schedule, true);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('click', schedule, true);
      document.removeEventListener('focusin', schedule, true);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, []);

  return null;
}
