import { garantirTabelasFinanceiras } from "./schema"
import { LancamentoRepository } from "./LancamentoRepository"
import type {
  ConsolidadoBalanco,
  LancamentoConsolidado,
  LancamentoApiInput,
  RegistrarLancamentoInput,
  SaldoCotista,
} from "./types"

export class FinanceValidationError extends Error {
  public readonly code = "VALIDATION"

  public constructor(message: string) {
    super(message)
    this.name = "FinanceValidationError"
  }
}

function validationError(message: string): FinanceValidationError {
  return new FinanceValidationError(message)
}

function stringOrEmpty(value: unknown): string {
  return value == null ? "" : String(value).trim()
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringOrEmpty(value)
  return normalized || undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function booleanOrFalse(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function normalizarFluxo(value: unknown): RegistrarLancamentoInput["fluxo"] {
  const fluxo = stringOrEmpty(value).toUpperCase()
  if (fluxo === "ENTRADA" || fluxo === "SAIDA") return fluxo
  throw validationError("fluxo deve ser ENTRADA ou SAIDA")
}

function normalizarRateios(raw: unknown): RegistrarLancamentoInput["rateios"] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const rateio = item as Record<string, unknown>
    const percentual = numberOrUndefined(rateio.percentual)
    return {
      cotista: stringOrEmpty(rateio.cotista ?? rateio.cotista_id),
      percentual: percentual ?? Number.NaN,
    }
  })
}

export function normalizarLancamentoInput(body: LancamentoApiInput, criadoPor?: string): RegistrarLancamentoInput {
  const valorCentavosInformado = numberOrUndefined(body.valorCentavos ?? body.valor_centavos)
  const valorEmReais = numberOrUndefined(body.valor)
  const valorCentavos = valorCentavosInformado ?? (valorEmReais === undefined ? Number.NaN : Math.round(valorEmReais * 100))
  const rawRateios = body.rateios ?? body.rateio_linhas

  return {
    data: stringOrEmpty(body.data ?? body.data_emissao),
    descricao: stringOrEmpty(body.descricao),
    documento: optionalString(body.documento ?? body.numero_doc),
    fornecedor: optionalString(body.fornecedor ?? body.fornecedor_nome),
    categoria: stringOrEmpty(body.categoria ?? body.categoria_nome ?? body.categoria_id),
    grupoCategoria: optionalString(body.grupoCategoria ?? body.grupo_categoria),
    tipo: optionalString(body.tipo),
    prazo: optionalString(body.prazo ?? body.data_vencimento),
    fluxo: normalizarFluxo(body.fluxo),
    valorCentavos,
    pagoPor: stringOrEmpty(body.pagoPor ?? body.pago_por),
    caixa: optionalString(body.caixa ?? body.tipo_caixa) || "SHARE",
    pagoDiretamente: booleanOrFalse(body.pagoDiretamente ?? body.pago_diretamente),
    reembolsavel: booleanOrFalse(body.reembolsavel),
    reembolsoQuitado: booleanOrFalse(body.reembolsoQuitado ?? body.reembolso_quitado),
    status: optionalString(body.status),
    observacoes: optionalString(body.observacoes),
    criadoPor,
    aeronaveId: optionalString(body.aeronaveId ?? body.aeronave_id),
    rateios: normalizarRateios(rawRateios),
  }
}

function saldoVazio(cotista: string): SaldoCotista {
  return { cotista, totalPagoCentavos: 0, totalDevidoCentavos: 0, saldoCentavos: 0 }
}

function ehPagadorCotista(pagador: string): boolean {
  return !["DGA_ADM", "SHARE", "ADMIN", "ADMINISTRACAO", "HOLDING"].includes(pagador.trim().toUpperCase())
}

export class LancamentoService {
  public constructor(private readonly repository: LancamentoRepository) {}

  public async registrarLancamento(input: RegistrarLancamentoInput): Promise<{ id: string }> {
    if (!input.data || !/^\d{4}-\d{2}-\d{2}$/.test(input.data)) {
      throw validationError("data deve estar no formato YYYY-MM-DD")
    }
    if (!input.descricao.trim()) {
      throw validationError("descricao é obrigatória")
    }
    if (!Number.isInteger(input.valorCentavos) || input.valorCentavos < 0) {
      throw validationError("valorCentavos deve ser inteiro não negativo em centavos")
    }
    if (!input.pagoPor.trim()) {
      throw validationError("pagoPor é obrigatório")
    }
    if (input.rateios.length === 0) {
      throw validationError("informe ao menos um rateio")
    }
    if (input.rateios.some((rateio) => !rateio.cotista.trim())) {
      throw validationError("cotista é obrigatório em cada rateio")
    }
    if (input.rateios.some((rateio) => !Number.isFinite(rateio.percentual) || rateio.percentual < 0)) {
      throw validationError("percentual de rateio deve ser não negativo")
    }

    const totalPercentual = input.rateios.reduce((total, rateio) => total + rateio.percentual, 0)
    if (Math.abs(totalPercentual - 100) > 0.0001) {
      throw validationError("a soma dos percentuais deve ser exatamente 100")
    }

    const id = crypto.randomUUID()
    await this.repository.inserirComRateios(input, id)
    return { id }
  }

  public async listarLancamentos(inicio?: string, fim?: string): Promise<LancamentoConsolidado[]> {
    return this.repository.listarConsolidado(inicio, fim)
  }

  public async obterConsolidadoBalanco(inicio?: string, fim?: string): Promise<ConsolidadoBalanco> {
    const lancamentos = await this.repository.listarConsolidado(inicio, fim)
    const saldos = this.calcularSaldos(lancamentos)
    const matrizCompensacao = this.calcularMatriz(lancamentos)
    const holdings = await this.repository.listarSaldosHolding(inicio, fim)

    return { lancamentos, saldos, matrizCompensacao, holdings }
  }

  private calcularSaldos(lancamentos: LancamentoConsolidado[]): SaldoCotista[] {
    const saldos = new Map<string, SaldoCotista>()
    for (const lancamento of lancamentos) {
      for (const rateio of lancamento.rateios) {
        const saldo = saldos.get(rateio.cotista) ?? saldoVazio(rateio.cotista)
        if (lancamento.fluxo === "SAIDA") saldo.totalDevidoCentavos += rateio.valorCentavos
        saldos.set(rateio.cotista, saldo)
      }

      if (lancamento.fluxo === "SAIDA" && ehPagadorCotista(lancamento.pagoPor)) {
        const pagador = saldos.get(lancamento.pagoPor) ?? saldoVazio(lancamento.pagoPor)
        pagador.totalPagoCentavos += lancamento.valorCentavos
        saldos.set(lancamento.pagoPor, pagador)
      }
    }

    for (const saldo of saldos.values()) saldo.saldoCentavos = saldo.totalPagoCentavos - saldo.totalDevidoCentavos
    return [...saldos.values()].sort((a, b) => a.cotista.localeCompare(b.cotista, "pt-BR"))
  }

  private calcularMatriz(lancamentos: LancamentoConsolidado[]): Record<string, Record<string, number>> {
    const matriz: Record<string, Record<string, number>> = {}
    const garantir = (cotista: string) => {
      matriz[cotista] ??= {}
      for (const existente of Object.keys(matriz)) {
        matriz[existente][cotista] ??= 0
        matriz[cotista][existente] ??= 0
      }
    }

    for (const lancamento of lancamentos) {
      if (lancamento.fluxo !== "SAIDA" || !ehPagadorCotista(lancamento.pagoPor)) continue
      garantir(lancamento.pagoPor)
      for (const rateio of lancamento.rateios) {
        garantir(rateio.cotista)
        if (rateio.cotista === lancamento.pagoPor) continue
        matriz[lancamento.pagoPor][rateio.cotista] += rateio.valorCentavos
      }
    }

    const cotistas = Object.keys(matriz)
    for (const credor of cotistas) {
      for (const devedor of cotistas) {
        if (credor >= devedor) continue
        const credorParaDevedor = matriz[credor][devedor] ?? 0
        const devedorParaCredor = matriz[devedor][credor] ?? 0
        const liquido = credorParaDevedor - devedorParaCredor
        matriz[credor][devedor] = liquido > 0 ? liquido : 0
        matriz[devedor][credor] = liquido < 0 ? Math.abs(liquido) : 0
      }
    }
    return matriz
  }
}

export async function prepararFinanceiro(db: ConstructorParameters<typeof LancamentoRepository>[0]): Promise<LancamentoService> {
  await garantirTabelasFinanceiras(db)
  return new LancamentoService(new LancamentoRepository(db))
}
