import type { D1Database } from "@cloudflare/workers-types"
import type {
  D1Row,
  HoldingResumo,
  LancamentoConsolidado,
  RegistrarLancamentoInput,
  SaldoCotista,
} from "./types"

function boolToInt(value: boolean | undefined): number {
  return value ? 1 : 0
}

function valorEmReais(valorCentavos: number): number {
  return valorCentavos / 100
}

export class LancamentoRepository {
  public constructor(private readonly db: D1Database) {}

  public async inserirComRateios(input: RegistrarLancamentoInput, id: string): Promise<void> {
    const rateios = input.rateios.map((rateio, index) => ({
      id: `${id}-r${index + 1}`,
      ...rateio,
      valorCentavos: Math.round(input.valorCentavos * rateio.percentual / 100),
    }))

    const lancamentoStatement = this.db.prepare(`
      INSERT INTO lancamentos (
        id, descricao, fluxo, categoria_nome, grupo_categoria, tipo_rateio,
        numero_doc, valor_centavos, valor_total, valor_rateado, data_emissao, data_vencimento, status,
        fornecedor_nome, observacoes, criado_por, pago_diretamente,
        tipo_caixa, pago_por, reembolsavel, reembolso_quitado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.descricao.trim(),
      input.fluxo.toLowerCase(),
      input.categoria.trim(),
      input.grupoCategoria?.trim() || null,
      input.rateios.length > 0 ? "COTISTAS" : null,
      input.documento?.trim() || null,
      input.valorCentavos,
      valorEmReais(input.valorCentavos),
      valorEmReais(input.valorCentavos),
      input.data,
      input.prazo ?? null,
      input.status?.trim().toLowerCase() || "pago",
      input.fornecedor?.trim() || null,
      input.observacoes?.trim() || null,
      input.criadoPor ?? null,
      boolToInt(input.pagoDiretamente),
      input.caixa?.trim() || "SHARE",
      input.pagoPor.trim(),
      boolToInt(input.reembolsavel),
      boolToInt(input.reembolsoQuitado),
    )

    const rateioStatements = rateios.map((rateio) => this.db.prepare(`
      INSERT INTO rateios_cotistas
        (id, lancamento_id, cotista, percentual, valor_centavos)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      rateio.id,
      id,
      rateio.cotista.trim(),
      rateio.percentual,
      rateio.valorCentavos,
    ))

    const result = await this.db.batch([lancamentoStatement, ...rateioStatements])
    if (result.some((item) => !item.success)) {
      throw new Error("Falha ao gravar lançamento e rateios")
    }
  }

  public async listarConsolidado(inicio?: string, fim?: string): Promise<LancamentoConsolidado[]> {
    const conditions: string[] = []
    const binds: string[] = []

    if (inicio) {
      conditions.push("date(COALESCE(l.data_emissao, l.data_pagamento, l.data_vencimento, l.criado_em)) >= date(?)")
      binds.push(inicio)
    }
    if (fim) {
      conditions.push("date(COALESCE(l.data_emissao, l.data_pagamento, l.data_vencimento, l.criado_em)) <= date(?)")
      binds.push(fim)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const query = `
      SELECT
        l.id,
        COALESCE(l.data_emissao, l.data_pagamento, l.data_vencimento, l.criado_em) AS data,
        l.descricao,
        l.numero_doc AS documento,
        l.fornecedor_nome AS fornecedor,
        COALESCE(l.categoria_nome, 'SEM CATEGORIA') AS categoria,
        COALESCE(l.grupo_categoria, 'SEM GRUPO') AS grupo_categoria,
        NULL AS tipo,
        l.data_vencimento AS prazo,
        UPPER(COALESCE(l.fluxo, 'SAIDA')) AS fluxo,
        COALESCE(l.valor_centavos, ROUND(COALESCE(l.valor_total, l.valor_rateado, 0) * 100)) AS valor_centavos,
        COALESCE(l.pago_por, l.cotista_id, 'DGA_ADM') AS pago_por,
        UPPER(COALESCE(l.tipo_caixa, 'SHARE')) AS caixa,
        COALESCE(l.pago_diretamente, 0) AS pago_diretamente,
        COALESCE(l.reembolsavel, 0) AS reembolsavel,
        COALESCE(l.reembolso_quitado, 0) AS reembolso_quitado,
        COALESCE(l.status, 'PAGO') AS status,
        l.observacoes,
        r.cotista AS rateio_cotista,
        r.percentual AS rateio_percentual,
        r.valor_centavos AS rateio_valor_centavos,
        rd.cotista_id AS legado_cotista,
        rd.valor_rateado AS legado_rateio_valor,
        CASE WHEN rd.cotista_id IS NOT NULL THEN rd.valor_rateado * 100 ELSE NULL END AS legado_rateio_valor_centavos,
        rd.pago_por AS legado_pago_por,
        CASE WHEN rd.cotista_id IS NOT NULL THEN
          CASE WHEN COALESCE(l.valor_total, l.valor_rateado, 0) = 0 THEN 0
          ELSE (rd.valor_rateado * 100.0) / (COALESCE(l.valor_total, l.valor_rateado, 0) * 100.0) * 100 END
        ELSE NULL END AS legado_percentual
      FROM lancamentos l
      LEFT JOIN rateios_cotistas r ON r.lancamento_id = l.id
      LEFT JOIN rateio_despesas rd ON r.id IS NULL AND rd.lancamentos_id = l.id
      ${where}
      ORDER BY date(COALESCE(l.data_emissao, l.data_pagamento, l.data_vencimento, l.criado_em)) ASC, l.criado_em ASC, COALESCE(r.cotista, rd.cotista_id) ASC
    `

    const result = await this.db.prepare(query).bind(...binds).all<D1Row>()
    const grouped = new Map<string, LancamentoConsolidado>()

    for (const row of result.results) {
      const id = String(row.id)
      const existente = grouped.get(id)
      const lancamento = existente ?? {
          id,
          data: String(row.data),
          descricao: String(row.descricao ?? ""),
          documento: row.documento == null ? null : String(row.documento),
          fornecedor: row.fornecedor == null ? null : String(row.fornecedor),
          categoria: String(row.categoria),
          grupoCategoria: String(row.grupo_categoria),
          tipo: row.tipo == null ? null : String(row.tipo),
          prazo: row.prazo == null ? null : String(row.prazo),
          fluxo: row.fluxo === "ENTRADA" ? "ENTRADA" : "SAIDA",
          valorCentavos: Number(row.valor_centavos || 0),
          pagoPor: String(row.pago_por || row.legado_pago_por || "DGA_ADM"),
          caixa: String(row.caixa || "SHARE"),
          pagoDiretamente: Number(row.pago_diretamente) === 1,
          reembolsavel: Number(row.reembolsavel) === 1,
          reembolsoQuitado: Number(row.reembolso_quitado) === 1,
          status: String(row.status || "PAGO"),
          observacoes: row.observacoes == null ? null : String(row.observacoes),
          rateios: [],
        }
      if (!existente) grouped.set(id, lancamento)

      const cotista = row.rateio_cotista ?? row.legado_cotista
      if (cotista !== null && cotista !== undefined && String(cotista).trim()) {
        const percentual = Number(row.rateio_percentual ?? row.legado_percentual ?? 0)
        const valorCentavos = Number(row.rateio_valor_centavos ?? row.legado_rateio_valor_centavos ?? 0)
        lancamento.rateios.push({
          cotista: String(cotista),
          percentual,
          valorCentavos: Math.round(valorCentavos),
        })
        if (row.legado_pago_por && lancamento.pagoPor === "DGA_ADM") {
          lancamento.pagoPor = String(row.legado_pago_por)
        }
      }
    }

    return [...grouped.values()]
  }

  public async listarSaldosHolding(inicio?: string, fim?: string): Promise<HoldingResumo[]> {
    const conditions: string[] = ["h.ativo = 1"]
    const binds: string[] = []
    if (inicio) {
      conditions.push("date(m.data) >= date(?)")
      binds.push(inicio)
    }
    if (fim) {
      conditions.push("date(m.data) <= date(?)")
      binds.push(fim)
    }

    const query = `
      SELECT
        h.id AS holding_id,
        h.nome AS holding_nome,
        h.conta_bancaria,
        hs.cotista_id,
        hs.percentual,
        COALESCE(SUM(CASE WHEN m.tipo IN ('DEPOSITO', 'APORTE', 'REEMBOLSO') THEN m.valor_centavos ELSE 0 END), 0) AS total_depositado,
        COALESCE(SUM(CASE WHEN m.tipo IN ('CONSUMO', 'DESPESA') THEN m.valor_centavos ELSE 0 END), 0) AS total_consumido,
        COALESCE(SUM(CASE WHEN m.tipo IN ('PAGAMENTO_DIRETO', 'ANTECIPACAO') THEN m.valor_centavos ELSE 0 END), 0) AS despesas_pagas_diretamente
      FROM holdings h
      LEFT JOIN hold_socios hs ON hs.holding_id = h.id
      LEFT JOIN movimentos_holding m ON m.holding_id = h.id AND (${conditions.slice(1).join(" AND ") || "1 = 1"})
      WHERE ${conditions[0]}
      GROUP BY h.id, h.nome, h.conta_bancaria, hs.cotista_id, hs.percentual
      ORDER BY h.nome, hs.cotista_id
    `

    const result = await this.db.prepare(query).bind(...binds).all<D1Row>()
    const holdings = new Map<string, HoldingResumo>()
    for (const row of result.results) {
      const holdingId = String(row.holding_id)
      const holding = holdings.get(holdingId) ?? {
        id: holdingId,
        nome: String(row.holding_nome),
        contaBancaria: row.conta_bancaria == null ? null : String(row.conta_bancaria),
        socios: [],
      }
      if (row.cotista_id !== null && row.cotista_id !== undefined) {
        const totalDepositadoCentavos = Number(row.total_depositado || 0)
        const totalConsumidoCentavos = Number(row.total_consumido || 0)
        const despesasPagasDiretamenteCentavos = Number(row.despesas_pagas_diretamente || 0)
        holding.socios.push({
          cotistaId: String(row.cotista_id),
          percentual: Number(row.percentual || 0),
          totalDepositadoCentavos,
          totalConsumidoCentavos,
          despesasPagasDiretamenteCentavos,
          saldoCentavos: totalDepositadoCentavos - totalConsumidoCentavos,
        })
      }
      holdings.set(holdingId, holding)
    }
    return [...holdings.values()]
  }
}

export type { SaldoCotista }
