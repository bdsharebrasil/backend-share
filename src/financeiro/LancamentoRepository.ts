import type { D1Database } from "@cloudflare/workers-types"
import type { D1Row, HoldingResumo, LancamentoConsolidado, RegistrarLancamentoInput } from "./types"

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
        id, aeronave_id, data_lancamento, descricao, documento, fornecedor_nome, categoria_nome,
        grupo_categoria, tipo, prazo, fluxo, valor_centavos, pago_por, tipo_caixa,
        pago_diretamente, reembolsavel, reembolso_quitado, status, observacoes,
        criado_por
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.aeronaveId ?? null,
      input.data,
      input.descricao.trim(),
      input.documento?.trim() || null,
      input.fornecedor?.trim() || null,
      input.categoria.trim(),
      input.grupoCategoria?.trim() || "DESPESA",
      input.tipo?.trim() || null,
      input.prazo ?? null,
      input.fluxo,
      input.valorCentavos,
      input.pagoPor.trim(),
      input.caixa === "CLIENTE" ? "CLIENTE" : "SHARE",
      input.pagoDiretamente ? 1 : 0,
      input.reembolsavel ? 1 : 0,
      input.reembolsoQuitado ? 1 : 0,
      input.status?.trim().toUpperCase() || "PAGO",
      input.observacoes?.trim() || null,
      input.criadoPor ?? null,
    )

    const rateioStatements = rateios.map((rateio) => this.db.prepare(`
      INSERT INTO rateios_cotistas
        (id, lancamento_id, cotista, percentual, valor_centavos)
      VALUES (?, ?, ?, ?, ?)
    `).bind(rateio.id, id, rateio.cotista.trim(), rateio.percentual, rateio.valorCentavos))

    const result = await this.db.batch([lancamentoStatement, ...rateioStatements])
    if (result.some((item) => !item.success)) throw new Error("Falha ao gravar lançamento e rateios")
  }

  public async listarConsolidado(inicio?: string, fim?: string): Promise<LancamentoConsolidado[]> {
    const conditions: string[] = []
    const binds: string[] = []
    if (inicio) {
      conditions.push("date(l.data_lancamento) >= date(?)")
      binds.push(inicio)
    }
    if (fim) {
      conditions.push("date(l.data_lancamento) <= date(?)")
      binds.push(fim)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const result = await this.db.prepare(`
      SELECT
        l.id, l.data_lancamento AS data, l.descricao, l.documento,
        l.fornecedor_nome AS fornecedor, l.categoria_nome AS categoria,
        l.grupo_categoria, l.tipo, l.prazo, l.fluxo, l.valor_centavos,
        l.pago_por, l.tipo_caixa AS caixa, l.pago_diretamente, l.reembolsavel,
        l.reembolso_quitado, l.status, l.observacoes,
        r.cotista AS rateio_cotista, r.percentual AS rateio_percentual,
        r.valor_centavos AS rateio_valor_centavos,
        rd.socio_id AS legado_cotista_id, rd.socio_nome AS legado_cotista_nome,
        rd.percentual_sociedade AS legado_percentual,
        rd.valor_rateado AS legado_rateio_valor,
        rd.pago_por AS legado_pago_por
      FROM lancamentos l
      LEFT JOIN rateios_cotistas r ON r.lancamento_id = l.id
      LEFT JOIN rateio_despesas rd ON r.id IS NULL AND rd.lancamentos_id = l.id
      ${where}
      ORDER BY date(l.data_lancamento) ASC, l.criado_em ASC, COALESCE(r.cotista, rd.socio_id, rd.socio_nome) ASC
    `).bind(...binds).all<D1Row>()

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
        categoria: String(row.categoria ?? "SEM CATEGORIA"),
        grupoCategoria: String(row.grupo_categoria ?? "SEM GRUPO"),
        tipo: row.tipo == null ? null : String(row.tipo),
        prazo: row.prazo == null ? null : String(row.prazo),
        fluxo: String(row.fluxo).toUpperCase() === "ENTRADA" ? "ENTRADA" : "SAIDA",
        valorCentavos: Number(row.valor_centavos || 0),
        pagoPor: String(row.pago_por || row.legado_pago_por || "DGA_ADM"),
        caixa: String(row.caixa || "SHARE").toUpperCase(),
        pagoDiretamente: Number(row.pago_diretamente) === 1,
        reembolsavel: Number(row.reembolsavel) === 1,
        reembolsoQuitado: Number(row.reembolso_quitado) === 1,
        status: String(row.status || "PAGO").toUpperCase(),
        observacoes: row.observacoes == null ? null : String(row.observacoes),
        rateios: [],
      }
      if (!existente) grouped.set(id, lancamento)

      const cotista = row.rateio_cotista ?? row.legado_cotista_id ?? row.legado_cotista_nome
      if (cotista !== null && cotista !== undefined && String(cotista).trim()) {
        const valorCentavos = Number(row.rateio_valor_centavos ?? (Number(row.legado_rateio_valor || 0) * 100))
        lancamento.rateios.push({
          cotista: String(cotista),
          percentual: Number(row.rateio_percentual ?? row.legado_percentual ?? 0),
          valorCentavos: Math.round(valorCentavos),
        })
        if (row.legado_pago_por && lancamento.pagoPor === "DGA_ADM") lancamento.pagoPor = String(row.legado_pago_por)
      }
    }
    return [...grouped.values()]
  }

  public async listarSaldosHolding(inicio?: string, fim?: string): Promise<HoldingResumo[]> {
    const conditions: string[] = ["h.ativo = 1"]
    const binds: string[] = []
    if (inicio) { conditions.push("date(m.data) >= date(?)"); binds.push(inicio) }
    if (fim) { conditions.push("date(m.data) <= date(?)"); binds.push(fim) }
    const joinConditions = conditions.slice(1).join(" AND ") || "1 = 1"
    const result = await this.db.prepare(`
      SELECT h.id AS holding_id, h.nome AS holding_nome, h.conta_bancaria,
        hs.cotista_id, COALESCE(ca.percentual_sociedade, 0) AS percentual,
        COALESCE(SUM(CASE WHEN m.tipo IN ('DEPOSITO', 'APORTE', 'REEMBOLSO') THEN m.valor_centavos ELSE 0 END), 0) AS total_depositado,
        COALESCE(SUM(CASE WHEN m.tipo IN ('CONSUMO', 'DESPESA') THEN m.valor_centavos ELSE 0 END), 0) AS total_consumido,
        COALESCE(SUM(CASE WHEN m.tipo IN ('PAGAMENTO_DIRETO', 'ANTECIPACAO') THEN m.valor_centavos ELSE 0 END), 0) AS despesas_pagas_diretamente
      FROM holdings h
      LEFT JOIN hold_socios hs ON hs.holding_id = h.id
      LEFT JOIN cotista_aeronave ca ON ca.id = hs.cotista_id
      LEFT JOIN movimentos_holding m ON m.holding_id = h.id AND (${joinConditions})
      WHERE ${conditions[0]}
      GROUP BY h.id, h.nome, h.conta_bancaria, hs.cotista_id, ca.percentual_sociedade
      ORDER BY h.nome, hs.cotista_id
    `).bind(...binds).all<D1Row>()

    const holdings = new Map<string, HoldingResumo>()
    for (const row of result.results) {
      const holdingId = String(row.holding_id)
      const holding = holdings.get(holdingId) ?? { id: holdingId, nome: String(row.holding_nome), contaBancaria: row.conta_bancaria == null ? null : String(row.conta_bancaria), socios: [] }
      if (row.cotista_id !== null && row.cotista_id !== undefined) {
        const totalDepositadoCentavos = Number(row.total_depositado || 0)
        const totalConsumidoCentavos = Number(row.total_consumido || 0)
        const despesasPagasDiretamenteCentavos = Number(row.despesas_pagas_diretamente || 0)
        holding.socios.push({ cotistaId: String(row.cotista_id), percentual: Number(row.percentual || 0), totalDepositadoCentavos, totalConsumidoCentavos, despesasPagasDiretamenteCentavos, saldoCentavos: totalDepositadoCentavos - totalConsumidoCentavos })
      }
      holdings.set(holdingId, holding)
    }
    return [...holdings.values()]
  }
}
