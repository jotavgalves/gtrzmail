import { useEffect, useRef } from 'react';
import { mailApi, type MessageSummary } from './api';

export default function ThreadListEnhancer() {
  const latest = useRef<MessageSummary[]>([]);

  useEffect(() => {
    const originalList = mailApi.list;
    mailApi.list = async (folder, query = '', filters = {}) => {
      const result = await originalList(folder, query, filters);
      latest.current = result.messages;
      window.dispatchEvent(new Event('gtrz-thread-list-updated'));
      return result;
    };
    return () => {
      mailApi.list = originalList;
    };
  }, []);

  useEffect(() => {
    let frameA = 0;
    let frameB = 0;

    const decorate = () => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.message-list .message-row'));
      rows.forEach((row, index) => {
        const message = latest.current[index];
        if (!message) return;
        row.dataset.messageId = message.id;
        row.dataset.threadId = message.threadId || message.id;

        const subject = row.querySelector<HTMLElement>('.message-subject');
        if (!subject) return;
        subject.querySelector('.thread-count')?.remove();
        const count = message.threadCount || 1;
        if (count <= 1) return;
        const badge = document.createElement('span');
        badge.className = 'thread-count';
        badge.textContent = String(count);
        badge.title = `${count} mensagens nesta conversa`;
        subject.appendChild(badge);
      });
    };

    const schedule = () => {
      if (frameA) cancelAnimationFrame(frameA);
      if (frameB) cancelAnimationFrame(frameB);
      frameA = requestAnimationFrame(() => {
        frameB = requestAnimationFrame(decorate);
      });
    };

    window.addEventListener('gtrz-thread-list-updated', schedule);
    schedule();
    return () => {
      window.removeEventListener('gtrz-thread-list-updated', schedule);
      if (frameA) cancelAnimationFrame(frameA);
      if (frameB) cancelAnimationFrame(frameB);
    };
  }, []);

  return null;
}
