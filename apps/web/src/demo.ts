import type { Mailbox, MessageDetail, MessageSummary, User } from './api';

export const demoUser: User = {
  id: 'demo-user',
  email: 'joao@gtrz.com.br',
  displayName: 'João Victor'
};

export const demoMailboxes: Mailbox[] = [
  { id: 'mb-main', address: 'joao@gtrz.com.br', display_name: 'João Victor', is_default: 1 },
  { id: 'mb-contact', address: 'contato@gtrz.com.br', display_name: 'GTRZ Eventos', is_default: 0 },
  { id: 'mb-finance', address: 'financeiro@gtrz.com.br', display_name: 'GTRZ Financeiro', is_default: 0 }
];

const now = Math.floor(Date.now() / 1000);

export const demoMessages: MessageSummary[] = [
  {
    id: 'demo-1', direction: 'inbound', folder: 'inbox', fromName: 'Ana Armazém da Estampa',
    fromAddress: 'ana@armazemdaestampa.com.br', to: ['joao@gtrz.com.br'],
    subject: 'Orçamento dos painéis para o evento de sábado',
    preview: 'Bom dia, João. Segue o orçamento atualizado para a produção dos painéis e materiais do próximo evento.',
    isRead: false, isStarred: true, sentStatus: null, receivedAt: now - 420, attachmentCount: 1
  },
  {
    id: 'demo-2', direction: 'inbound', folder: 'inbox', fromName: 'Sympla',
    fromAddress: 'notificacoes@sympla.com.br', to: ['eventos@gtrz.com.br'],
    subject: 'Novo ingresso vendido — La Rumba',
    preview: 'Uma nova venda foi confirmada. Confira os detalhes do pedido e o status do pagamento.',
    isRead: false, isStarred: false, sentStatus: null, receivedAt: now - 2820, attachmentCount: 0
  },
  {
    id: 'demo-3', direction: 'inbound', folder: 'inbox', fromName: 'María González',
    fromAddress: 'maria.gonzalez@example.com', to: ['contato@gtrz.com.br'],
    subject: 'Lista final de invitados',
    preview: 'Te envío la lista final para el evento del sábado. Quedaron confirmadas las personas de la mesa reservada.',
    isRead: true, isStarred: false, sentStatus: null, receivedAt: now - 7240, attachmentCount: 1
  },
  {
    id: 'demo-4', direction: 'inbound', folder: 'inbox', fromName: 'Cloudflare',
    fromAddress: 'notifications@cloudflare.com', to: ['joao@gtrz.com.br'],
    subject: 'Email Routing activity',
    preview: 'Your domain received new messages through Email Routing. Review routing activity in your dashboard.',
    isRead: true, isStarred: false, sentStatus: null, receivedAt: now - 30240, attachmentCount: 0
  }
];

export const demoDetails: Record<string, MessageDetail> = {
  'demo-1': {
    ...demoMessages[0], cc: [], bcc: [],
    bodyText: `Bom dia, João.\n\nSegue o orçamento atualizado para a produção dos painéis e materiais do próximo evento.\n\nConseguimos manter o prazo combinado para amanhã. Estou anexando o PDF com os valores, medidas e especificações de cada peça.\n\nQualquer ajuste me avise.\n\nAna\nArmazém da Estampa`,
    attachments: [{ id: 'att-demo-1', filename: 'orcamento_gtrz_140826.pdf', mimeType: 'application/pdf', sizeBytes: 2867200, contentId: null, disposition: 'attachment' }]
  },
  'demo-2': { ...demoMessages[1], cc: [], bcc: [], bodyText: 'Uma nova venda foi confirmada para La Rumba. Acesse o painel do evento para conferir os detalhes.', attachments: [] },
  'demo-3': { ...demoMessages[2], cc: [], bcc: [], bodyText: 'Hola, João.\n\nTe envío la lista final para el evento del sábado. Quedaron confirmadas las personas de la mesa reservada.\n\nNos vemos allá.', attachments: [{ id: 'att-demo-3', filename: 'lista_invitados.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 92032, contentId: null, disposition: 'attachment' }] },
  'demo-4': { ...demoMessages[3], cc: [], bcc: [], bodyText: 'Your Email Routing configuration is active and processing messages for gtrz.com.br.', attachments: [] }
};
