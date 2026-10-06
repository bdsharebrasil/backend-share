export type FluxoLancamento = "ENTRADA" | "SAIDA"
export type NaturezaLancamento = "RECEITA" | "DESPESA" | "REEMBOLSO"

export type CaixaLancamento = "SHARE" | "HOLDING" | "COTISTA" | string

export type RateioInput = {
  cotista: string
  percentual: number
}

export type RegistrarLancamentoInput = {
  data: string
  descricao: string
  documento?: string
  fornecedor?: string
  categoria: string
  grupoCategoria?: string
  tipo?: string
  prazo?: string
  fluxo: FluxoLancamento
  natureza: NaturezaLancamento
  valorCentavos: number
  pagoPor: string
  caixa?: CaixaLancamento
  pagoDiretamente?: boolean
  reembolsavel?: boolean
  reembolsoQuitado?: boolean
  status?: string
  observacoes?: string
  criadoPor?: string
  aeronaveId?: string
  rateios: RateioInput[]
}

export type RateioConsolidado = RateioInput & {
  valorCentavos: number
}

export type LancamentoConsolidado = {
  id: string
  data: string
  descricao: string
  documento: string | null
  fornecedor: string | null
  categoria: string
  grupoCategoria: string
  tipo: string | null
  prazo: string | null
  fluxo: FluxoLancamento
  natureza: NaturezaLancamento
  valorCentavos: number
  pagoPor: string
  caixa: CaixaLancamento
  pagoDiretamente: boolean
  reembolsavel: boolean
  reembolsoQuitado: boolean
  status: string
  observacoes: string | null
  rateios: RateioConsolidado[]
}

export type SaldoCotista = {
  cotista: string
  cotistaId?: string
  totalPagoCentavos: number
  totalDevidoCentavos: number
  saldoCentavos: number
}

export type HoldingSocioResumo = {
  cotistaId: string
  nome: string
  percentual: number
  totalDepositadoCentavos: number
  totalConsumidoCentavos: number
  despesasPagasDiretamenteCentavos: number
  saldoCentavos: number
}

export type HoldingResumo = {
  id: string
  nome: string
  contaBancaria: string | null
  saldoContaCentavos: number
  socios: HoldingSocioResumo[]
}

export type MovimentoHoldingExtrato = {
  id: string
  holdingId: string | null
  holdingNome: string | null
  socioId: string | null
  socioNome: string | null
  aeronaveId: string | null
  data: string
  dataPagamento: string | null
  descricao: string
  categoria: string | null
  fluxo: string
  valorCentavos: number
  status: string
  contaBancaria: string | null
  diretamentePago: boolean
}

export type ConsolidadoBalanco = {
  lancamentos: LancamentoConsolidado[]
  movimentos_holding: MovimentoHoldingExtrato[]
  saldos: SaldoCotista[]
  matrizCompensacao: Record<string, Record<string, number>>
  holdings: HoldingResumo[]
}

export type D1Row = Record<string, unknown>

export type LancamentoApiInput = {
  data?: unknown
  data_emissao?: unknown
  descricao?: unknown
  documento?: unknown
  numero_doc?: unknown
  fornecedor?: unknown
  fornecedor_nome?: unknown
  categoria?: unknown
  categoria_id?: unknown
  categoria_nome?: unknown
  grupoCategoria?: unknown
  grupo_categoria?: unknown
  tipo?: unknown
  prazo?: unknown
  data_vencimento?: unknown
  fluxo?: unknown
  natureza?: unknown
  valorCentavos?: unknown
  valor_centavos?: unknown
  valor?: unknown
  pagoPor?: unknown
  pago_por?: unknown
  caixa?: unknown
  tipo_caixa?: unknown
  pagoDiretamente?: unknown
  pago_diretamente?: unknown
  reembolsavel?: unknown
  reembolso_quitado?: unknown
  reembolsoQuitado?: unknown
  status?: unknown
  observacoes?: unknown
  criadoPor?: unknown
  aeronaveId?: unknown
  aeronave_id?: unknown
  rateios?: unknown
  rateio_linhas?: unknown
}

export type LancamentoApiResponse = {
  id: string
}

export type BalancoApiResponse = ConsolidadoBalanco
