import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Download, File, FileText, Paperclip } from 'lucide-react';
import type { MessageDetail } from './api';

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

export default function ThreadConversation({ messages }: { messages: MessageDetail[] }) {
  const ordered = useMemo(() => [...messages].sort((a, b) => a.receivedAt - b.receivedAt), [messages]);
  const latestId = ordered.at(-1)?.id || '';
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(latestId ? [latestId] : []));

  useEffect(() => {
    setExpanded(new Set(latestId ? [latestId] : []));
  }, [latestId, ordered.length]);

  if (ordered.length <= 1) return null;

  return (
    <section className="thread-conversation" aria-label={`Conversa com ${ordered.length} mensagens`}>
      <div className="thread-conversation-title">
        <strong>{ordered.length} mensagens nesta conversa</strong>
        <span>agrupadas por Message-ID, In-Reply-To e References</span>
      </div>

      {ordered.map((message) => {
        const open = expanded.has(message.id);
        const sender = message.fromName || message.fromAddress;
        const attachments = visibleAttachments(message);
        return (
          <article className={`thread-card ${open ? 'expanded' : ''}`} key={message.id}>
            <button
              type="button"
              className="thread-card-header"
              onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(message.id)) next.delete(message.id);
                else next.add(message.id);
                return next;
              })}
              aria-expanded={open}
            >
              <span className="thread-avatar">{initials(sender)}</span>
              <span className="thread-card-copy">
                <span className="thread-card-line">
                  <strong>{sender}</strong>
                  {message.direction === 'outbound' && <b>Enviado</b>}
                  {message.sentStatus && message.direction === 'outbound' && <em><CheckCircle2 size={11} />{message.sentStatus}</em>}
                </span>
                <small>{message.direction === 'outbound' ? `para ${message.to.join(', ')}` : `para ${message.to.join(', ') || 'você'}`}</small>
                {!open && <span className="thread-snippet">{message.preview}</span>}
              </span>
              <span className="thread-card-time">{fullDate(message.receivedAt)}</span>
              {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {open && <div className="thread-card-body">
              {message.bodyHtml ? (
                <div className="rich-mail-body thread-rich-body" dangerouslySetInnerHTML={{ __html: htmlForDisplay(message) }} />
              ) : (
                <div className="thread-text-body">{message.bodyText || 'Mensagem sem conteúdo de texto.'}</div>
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
            </div>}
          </article>
        );
      })}
    </section>
  );
}
