import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Download, File, FileText, LoaderCircle, Paperclip } from 'lucide-react';
import type { MessageDetail, MessageSummary } from './api';

const deliveryLabels: Record<string, string> = {
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregue',
  delayed: 'Atrasado',
  bounced: 'Devolvido',
  complained: 'Spam',
  failed: 'Falhou',
  suppressed: 'Suprimido',
  draft: 'Rascunho'
};

function fullDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp * 1000)).replace('.', '');
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'GM';
  return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase();
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function visibleAttachments(message: MessageDetail) {
  return message.attachments.filter((attachment) => attachment.disposition !== 'inline');
}

function htmlForDisplay(message: MessageDetail): string {
  let html = message.bodyHtml || '';
  for (const attachment of message.attachments) {
    if (!attachment.contentId) continue;
    const escaped = attachment.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`cid:${escaped}`, 'gi'), `/api/attachments/${attachment.id}?inline=1`);
  }
  return html;
}

async function fetchDetail(id: string): Promise<MessageDetail> {
  const response = await fetch(`/api/messages/${id}`, {
    credentials: 'same-origin',
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({})) as { message?: MessageDetail; error?: string };
  if (!response.ok || !payload.message) throw new Error(payload.error || 'Não foi possível carregar a mensagem.');
  return payload.message;
}

export default function ThreadConversation({
  messages,
  initialDetail
}: {
  messages: MessageSummary[];
  initialDetail: MessageDetail;
}) {
  const ordered = useMemo(() => [...messages].sort((a, b) => a.receivedAt - b.receivedAt), [messages]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([initialDetail.id]));
  const [details, setDetails] = useState<Record<string, MessageDetail>>(() => ({ [initialDetail.id]: initialDetail }));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setExpanded(new Set([initialDetail.id]));
    setDetails({ [initialDetail.id]: initialDetail });
    setLoading(new Set());
    setErrors({});
  }, [initialDetail.id]);

  if (ordered.length <= 1) return null;

  const toggle = (message: MessageSummary) => {
    const currentlyOpen = expanded.has(message.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (currentlyOpen) next.delete(message.id);
      else next.add(message.id);
      return next;
    });

    if (currentlyOpen || details[message.id] || loading.has(message.id)) return;

    setLoading((current) => new Set(current).add(message.id));
    setErrors((current) => {
      const next = { ...current };
      delete next[message.id];
      return next;
    });

    void fetchDetail(message.id)
      .then((detail) => {
        setDetails((current) => ({ ...current, [message.id]: detail }));
      })
      .catch((error) => {
        setErrors((current) => ({
          ...current,
          [message.id]: error instanceof Error ? error.message : 'Não foi possível carregar a mensagem.'
        }));
      })
      .finally(() => {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
      });
  };

  return (
    <section className="thread-conversation" aria-label={`Conversa com ${ordered.length} mensagens`}>
      <div className="thread-conversation-title">
        <strong>{ordered.length} mensagens nesta conversa</strong>
        <span>respostas agrupadas automaticamente</span>
      </div>

      {ordered.map((message) => {
        const open = expanded.has(message.id);
        const detail = details[message.id];
        const sender = message.fromName || message.fromAddress;
        const attachments = detail ? visibleAttachments(detail) : [];
        const isLoading = loading.has(message.id);
        const error = errors[message.id];

        return (
          <article className={`thread-card ${open ? 'expanded' : ''}`} key={message.id}>
            <button
              type="button"
              className="thread-card-header"
              onClick={() => toggle(message)}
              aria-expanded={open}
            >
              <span className="thread-avatar">{initials(sender)}</span>
              <span className="thread-card-copy">
                <span className="thread-card-line">
                  <strong>{sender}</strong>
                  {message.direction === 'outbound' && <b>Enviado</b>}
                  {message.sentStatus && message.direction === 'outbound' && (
                    <em><CheckCircle2 size={11} />{deliveryLabels[message.sentStatus] || message.sentStatus}</em>
                  )}
                </span>
                <small>{message.direction === 'outbound' ? `para ${message.to.join(', ')}` : `para ${message.to.join(', ') || 'você'}`}</small>
                {!open && <span className="thread-snippet">{message.preview}</span>}
              </span>
              <span className="thread-card-time">{fullDate(message.receivedAt)}</span>
              {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {open && <div className="thread-card-body">
              {isLoading && <div className="thread-loading"><LoaderCircle size={18} className="spin" /> Carregando mensagem…</div>}
              {!isLoading && error && <div className="thread-error">{error}</div>}
              {!isLoading && !error && detail && <>
                {detail.bodyHtml ? (
                  <div className="rich-mail-body thread-rich-body" dangerouslySetInnerHTML={{ __html: htmlForDisplay(detail) }} />
                ) : (
                  <div className="thread-text-body">{detail.bodyText || 'Mensagem sem conteúdo de texto.'}</div>
                )}

                {attachments.length > 0 && <div className="thread-attachments">
                  {attachments.map((attachment) => {
                    const Icon = attachment.mimeType === 'application/pdf' ? FileText : File;
                    return (
                      <a className="thread-attachment" href={`/api/attachments/${attachment.id}`} key={attachment.id}>
                        <Icon size={16} />
                        <span><strong>{attachment.filename}</strong><small>{bytesLabel(attachment.sizeBytes)}</small></span>
                        <Download size={15} />
                      </a>
                    );
                  })}
                  <span className="thread-attachment-count"><Paperclip size={12} /> {attachments.length}</span>
                </div>}
              </>}
            </div>}
          </article>
        );
      })}
    </section>
  );
}
