export const STATUS_RECIBO = ['CRIADO', 'ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMITIDO', 'ERRO_ANEXO', 'ERRO_PDF', 'CANCELADO'] as const;
export type StatusRecibo = typeof STATUS_RECIBO[number];
