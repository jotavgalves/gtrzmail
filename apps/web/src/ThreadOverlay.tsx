import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mailApi, type MessageDetail, type MessageSummary } from './api';
import ThreadConversation from './ThreadConversation';

type ThreadState = {
  threadId: string;
  messages: MessageSummary[];
  initialDetail: MessageDetail;
};

export default function ThreadOverlay() {
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const originalGet = mailApi.get;
    mailApi.get = async (id: string) => {
      const result = await originalGet(id);
      window.dispatchEvent(new CustomEvent('gtrz-message-opened', { detail: result.message }));
      return result;
    };
    return () => {
      mailApi.get = originalGet;
    };
  }, []);

  useEffect(() => {
    const opened = async (event: Event) => {
      const message = (event as CustomEvent<MessageDetail>).detail;
      const current = ++sequence.current;
      setThread(null);

      if (!message?.threadId) return;
      try {
        const listing = await mailApi.thread(message.threadId);
        if (current !== sequence.current || listing.messages.length <= 1) return;
        setThread({
          threadId: message.threadId,
          messages: listing.messages,
          initialDetail: message
        });
      } catch {
        setThread(null);
      }
    };

    window.addEventListener('gtrz-message-opened', opened as EventListener);
    return () => window.removeEventListener('gtrz-message-opened', opened as EventListener);
  }, []);

  useEffect(() => {
    if (!thread) {
      document.querySelector('.message-detail')?.classList.remove('thread-mode');
      setMount(null);
      return;
    }

    const attach = () => {
      const detail = document.querySelector<HTMLElement>('.message-detail');
      const body = detail?.querySelector<HTMLElement>(':scope > .mail-body');
      if (!detail || !body) return false;
      detail.classList.add('thread-mode');
      let host = detail.querySelector<HTMLElement>(':scope > .thread-overlay-host');
      if (!host) {
        host = document.createElement('div');
        host.className = 'thread-overlay-host';
        detail.insertBefore(host, body);
      }
      setMount(host);
      return true;
    };

    if (attach()) return () => document.querySelector('.message-detail')?.classList.remove('thread-mode');
    const observer = new MutationObserver(() => {
      if (attach()) observer.disconnect();
    });
    observer.observe(document.querySelector('#root') || document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelector('.message-detail')?.classList.remove('thread-mode');
    };
  }, [thread]);

  if (!thread || !mount) return null;
  return createPortal(
    <ThreadConversation messages={thread.messages} initialDetail={thread.initialDetail} />,
    mount
  );
}
