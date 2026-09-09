export type DocumentoSaidaOrigem = "nf_saida" | "recibo_saida";
export type StatusDocumentoSaida = "EM_ABERTO" | "PAGO" | "RECEBIDO" | "CANCELADO";
export type StatusRecibo = "CRIADO" | "ANEXO_PENDENTE" | "PDF_PENDENTE" | "EMITIDO" | "ERRO_ANEXO" | "ERRO_PDF" | "CANCELADO";
export type TipoRecibo = "recibo_reembolso" | "recibo_colaborador" | "recibo_pagamento" | "recibo_saida";

export type CotistaAeronaveRef = {
  cotista_aeronave_id: string;
  aeronave_id: string;
  cliente_id: string | null;
  socio_id: string | null;
};


export const TIPOS_RATEIO = ['FIXO', 'VARIAVEL_POR_VOO', 'VARIAVEL_POR_HORA', 'EXTRA'] as const;
export const PERIODICIDADES_RATEIO = ['ÚNICO', 'EVENTUAL', 'MENSAL', 'BIMESTRAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'] as const;
export const STATUS_RATEIO_DESPESAS = ['EM_ABERTO', 'PAGO', 'PAGO_DIRETAMENTE', 'EM_ATRASO', 'ESTORNO', 'SAIDA', 'AGUARDANDO_REEMBOLSO', 'REEMBOLSADO', 'CANCELADO'] as const;
export type RateioDespesaContract = {
  id: string;
  lancamento_id: string | null;
  aeronave_id: string;
  cotista_id: string;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  data_competencia_demonstrativo: string | null;
  categoria_id: string | null;
  categoria_nome: string | null;
  subcategoria_1: string | null;
  subcategoria_2: string | null;
  subcategoria_3: string | null;
  subcategoria_4: string | null;
  fornecedor_id: string | null;
  tipo_rateio: typeof TIPOS_RATEIO[number];
  periodicidade: typeof PERIODICIDADES_RATEIO[number] | null;
  percentual_sociedade: number | null;
  percentual_uso: number | null;
  valor_total_centavos: number;
  valor_rateado_centavos: number;
  valor_pago_real_centavos: number;
  pago_por_cotista_id: string | null;
  pago_diretamente: 0 | 1;
  status: typeof STATUS_RATEIO_DESPESAS[number] | null;
  descricao_despesa: string | null;
  observacoes: string | null;
  criado_em: string;
  atualizado_em: string;
};
export type RateioHoldContract = Omit<RateioDespesaContract, 'lancamento_id' | 'cotista_id' | 'pago_por_cotista_id' | 'status'> & {
  movimento_holding_id: string | null;
  socio_id: string;
  pago_por_socio_id: string | null;
  status: 'EM_ABERTO' | 'PAGO' | 'PAGO_DIRETAMENTE' | 'RECEBIDO' | 'SAIDA' | 'ESTORNO' | 'EM_ATRASO' | 'ENTRADA' | 'AGUARDANDO_REEMBOLSO' | 'REEMBOLSADO' | 'CANCELADO';
};
