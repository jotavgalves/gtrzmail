import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  EyeOff,
  Forward,
  MoreHorizontal,
  Printer,
  Reply,
  ReplyAll,
  RotateCcw,
  Star,
  Trash2,
  X
} from 'lucide-react';

type Position = { top: number; right: number };
type ApiErrorEvent = CustomEvent<{ message?: string }>;

const TOOLTIP_LABELS = new Set([
  'Atualizar',
  'Filtros',
  'Arquivar',
  'Excluir',
  'Restaurar',
  'Excluir permanentemente',
  'Marcar como não lida',
  'Mais ações'
]);

function toolbarButton(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`.reader-toolbar button[aria-label="${label}"]`);
}

function replyButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.reply-actions button'))
    .find((button) => button.textContent?.trim().toLowerCase() === label.toLowerCase()) || null;
}

export default function ToolbarEnhancer() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ top: 68, right: 18 });
  const [notice, setNotice] = useState('');
  const [available, setAvailable] = useState({
    archive: false,
    trash: false,
    restore: false,
    permanentDelete: false,
    unread: false,
    reply: false,
    replyAll: false,
    forward: false,
    star: false
  });

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? '' : current), 3200);
  };

  const refreshAvailable = () => {
    setAvailable({
      archive: Boolean(toolbarButton('Arquivar')),
      trash: Boolean(toolbarButton('Excluir')),
      restore: Boolean(toolbarButton('Restaurar')),
      permanentDelete: Boolean(toolbarButton('Excluir permanentemente')),
      unread: Boolean(toolbarButton('Marcar como não lida')),
      reply: Boolean(replyButton('Responder')),
      replyAll: Boolean(replyButton('Responder a todos')),
      forward: Boolean(replyButton('Encaminhar')),
      star: Boolean(document.querySelector('.message-row.selected .star-button'))
    });
  };

  useEffect(() => {
    const pointerOver = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const element = target?.closest<HTMLElement>('[aria-label]');
      const label = element?.getAttribute('aria-label') || '';
      if (element && TOOLTIP_LABELS.has(label) && !element.title) element.title = label;
    };

    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const moreButton = target?.closest<HTMLButtonElement>('.reader-toolbar button[aria-label="Mais ações"]');
      if (moreButton) {
        event.preventDefault();
        event.stopPropagation();
        const rect = moreButton.getBoundingClientRect();
        setPosition({
          top: Math.min(window.innerHeight - 12, rect.bottom + 8),
          right: Math.max(10, window.innerWidth - rect.right)
        });
        refreshAvailable();
        setOpen((current) => !current);
        return;
      }

      const refreshButton = target?.closest<HTMLElement>('[aria-label="Atualizar"]');
      if (refreshButton) showNotice('Atualizando a caixa…');

      if (open && !target?.closest('.message-more-menu')) setOpen(false);
    };

    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    const apiError = (event: Event) => {
      const detail = (event as ApiErrorEvent).detail;
      showNotice(detail?.message || 'Não foi possível concluir a ação.');
    };

    document.addEventListener('pointerover', pointerOver, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('gtrz-api-error', apiError as EventListener);
    return () => {
      document.removeEventListener('pointerover', pointerOver, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('gtrz-api-error', apiError as EventListener);
    };
  }, [open]);

  const invoke = (callback: () => void) => {
    setOpen(false);
    callback();
  };

  const items = useMemo(() => [
    available.reply && { label: 'Responder', icon: Reply, action: () => replyButton('Responder')?.click() },
    available.replyAll && { label: 'Responder a todos', icon: ReplyAll, action: () => replyButton('Responder a todos')?.click() },
    available.forward && { label: 'Encaminhar', icon: Forward, action: () => replyButton('Encaminhar')?.click() },
    available.star && { label: 'Favoritar / desfavoritar', icon: Star, action: () => document.querySelector<HTMLButtonElement>('.message-row.selected .star-button')?.click() },
    available.unread && { label: 'Marcar como não lida', icon: EyeOff, action: () => toolbarButton('Marcar como não lida')?.click() },
    available.archive && { label: 'Arquivar', icon: Archive, action: () => toolbarButton('Arquivar')?.click() },
    available.restore && { label: 'Restaurar', icon: RotateCcw, action: () => toolbarButton('Restaurar')?.click() },
    available.trash && { label: 'Mover para lixeira', icon: Trash2, action: () => toolbarButton('Excluir')?.click(), danger: true },
    available.permanentDelete && { label: 'Excluir permanentemente', icon: Trash2, action: () => toolbarButton('Excluir permanentemente')?.click(), danger: true },
    { label: 'Imprimir mensagem', icon: Printer, action: () => window.print() }
  ].filter(Boolean) as Array<{ label: string; icon: typeof MoreHorizontal; action: () => void; danger?: boolean }>, [available]);

  return (
    <>
      {open && <div className="message-more-menu" role="menu" aria-label="Mais ações da mensagem" style={{ top: position.top, right: position.right }}>
        <div className="message-more-head">
          <strong>Mais ações</strong>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fechar menu"><X size={15} /></button>
        </div>
        {items.map(({ label, icon: Icon, action, danger }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            className={danger ? 'danger' : ''}
            onClick={() => invoke(action)}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </div>}
      {notice && <div className="toolbar-notice" role="status">{notice}</div>}
    </>
  );
}
