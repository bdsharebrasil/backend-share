import { Hono } from "hono"
import { mensagemFinanceiraStatements } from "./financeiroNotifications"
import { errorResponse } from "./errorResponse"
import { listar } from "./repositories/d1"

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }
type Row = Record<string, unknown>

const movimentoEhEntrada = (fluxo: unknown) => ['ENTRADA', 'APORTE', 'ESTORNO', 'REEMBOLSO'].includes(String(fluxo ?? '').toUpperCase())
const periodicidadesValidas = ['ÚNICO', 'EVENTUAL', 'MENSAL', 'BIMESTRAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'A CADA 50 H', 'A CADA 100 H']
const isoDate = (value: unknown) => {
  const date = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}
const text = (value: unknown) => String(value ?? '').trim()
const nullable = (value: unknown) => text(value) || null

export const movimentosHoldingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

movimentosHoldingRoutes.get('/movimentos-holding/pendentes', async (c) => {
  try {
    const movimentos = await listar(c.env.SHARE_DB, `SELECT mh.id, mh.holding_id, h.nome AS holding_nome,
        mh.socio_id, hs.nome AS socio_nome, mh.aeronave_id, a.matricula_registro AS aeronave,
        mh.data_emissao, mh.data_vencimento, mh.descricao, mh.numero_doc, mh.url_doc, mh.numero_nf, mh.url_nf, mh.numero_recibo, mh.url_recibo, mh.numero_boleto, mh.url_boleto, mh.numero_demonstrativo, mh.url_demonstrativo, mh.comprovante_url, mh.categoria_nome, mh.valor_centavos,
        mh.status, mh.fluxo, COALESCE(NULLIF(TRIM(mh.fornecedor_nome), ''), NULLIF(TRIM(ff.apelido), ''), ff.nome_completo) AS fornecedor_nome, mh.fornecedor_id,
        COALESCE((SELECT SUM(rh.valor_rateado_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS rateado_centavos,
        COALESCE((SELECT SUM(rh.valor_pago_real_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS pago_centavos
      FROM movimentos_holding mh
      LEFT JOIN holdings h ON h.id = mh.holding_id
      LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
      LEFT JOIN aeronave a ON a.id = mh.aeronave_id
      LEFT JOIN fornecedores_favoritos ff ON ff.id = mh.fornecedor_id
      WHERE mh.tipo_caixa = 'HOLD'
        AND UPPER(mh.fluxo) IN ('SAIDA', 'ENTRADA', 'APORTE', 'ESTORNO', 'REEMBOLSO')
        AND UPPER(mh.status) IN ('EM_ABERTO', 'EM_ATRASO', 'AGUARDANDO_REEMBOLSO', 'ENTRADA', 'APORTE_MENSAL', 'RENDIMENTO_BANCARIO')
        AND COALESCE(mh.pago_diretamente, 0) = 0
      ORDER BY date(mh.data_vencimento) ASC, mh.criado_em DESC LIMIT 500`)
    return c.json({ movimentos })
  } catch (error) { return errorResponse(c, error) }
})

movimentosHoldingRoutes.get('/movimentos-holding', async (c) => {
  try {
    const movimentos = await listar(c.env.SHARE_DB, `SELECT mh.id, mh.holding_id, h.nome AS holding_nome,
        mh.socio_id, hs.nome AS socio_nome, mh.aeronave_id, a.matricula_registro AS aeronave,
        mh.data_emissao, mh.data_vencimento, mh.data_pagamento, mh.descricao, mh.categoria_nome,
        mh.valor_centavos, mh.fluxo, mh.status, COALESCE(NULLIF(TRIM(mh.fornecedor_nome), ''), NULLIF(TRIM(ff.apelido), ''), ff.nome_completo) AS fornecedor_nome, mh.fornecedor_id, mh.periodicidade,
        mh.conta_bancaria_id, cb.tipo_caixa AS conta_tipo_caixa,
        COALESCE(NULLIF(cb.nome, ''), NULLIF(cb.banco, ''), mh.conta_bancaria_id) AS conta_bancaria_nome,
        mh.numero_doc, mh.url_doc, mh.numero_nf, mh.url_nf, mh.numero_recibo, mh.url_recibo, mh.numero_boleto, mh.url_boleto, mh.numero_demonstrativo, mh.url_demonstrativo, mh.comprovante_url, mh.pago_diretamente, mh.criado_em, mh.atualizado_em,
        COALESCE((SELECT SUM(rh.valor_rateado_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS rateado_centavos,
        COALESCE((SELECT SUM(rh.valor_pago_real_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS pago_centavos
      FROM movimentos_holding mh
      LEFT JOIN holdings h ON h.id = mh.holding_id
      LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
      LEFT JOIN aeronave a ON a.id = mh.aeronave_id
      LEFT JOIN contas_bancarias cb ON cb.id = mh.conta_bancaria_id
      LEFT JOIN fornecedores_favoritos ff ON ff.id = mh.fornecedor_id
      WHERE mh.tipo_caixa = 'HOLD'
      ORDER BY date(mh.data_emissao) DESC, mh.criado_em DESC LIMIT 1000`)
    return c.json({ movimentos })
  } catch (error) { return errorResponse(c, error) }
})

// Fluxo próprio do caixa conjunto da Holding, separado das rotas de receita/despesa Share.
movimentosHoldingRoutes.post('/movimentos-holding', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const body = await c.req.json<Row>().catch(() => ({} as Row))
    const holdingId = text(body.holding_id)
    const data = text(body.data_emissao ?? body.data)
    const periodicidade = text(body.periodicidade ?? 'ÚNICO')
    const descricao = text(body.descricao)
    const fluxo = text(body.fluxo).toUpperCase()
    const valor = Number(body.valor_centavos)
    if (!holdingId || !isoDate(data) || !descricao || !Number.isSafeInteger(valor) || valor <= 0 || !['ENTRADA', 'SAIDA', 'APORTE', 'ESTORNO', 'REEMBOLSO'].includes(fluxo)) {
      return c.json({ error: 'dados_movimento_holding_invalidos' }, 400)
    }
    if (!periodicidadesValidas.includes(periodicidade)) return c.json({ error: 'periodicidade_holding_invalida' }, 400)
    const holding = await db.prepare('SELECT id FROM holdings WHERE id = ? LIMIT 1').bind(holdingId).first<{ id: string }>()
    if (!holding) return c.json({ error: 'holding_nao_encontrada' }, 400)
    const aircraftId = nullable(body.aeronave_id)
    if (aircraftId && !await db.prepare('SELECT id FROM aeronave WHERE id = ? LIMIT 1').bind(aircraftId).first()) return c.json({ error: 'aeronave_invalida' }, 400)
    const socioId = nullable(body.socio_id)
    if (socioId) {
      const socio = await db.prepare('SELECT id FROM hold_socios WHERE id = ? AND holding_id = ? LIMIT 1').bind(socioId, holdingId).first()
      if (!socio) return c.json({ error: 'socio_nao_pertence_a_holding' }, 400)
    }
    const categoryId = nullable(body.categoria_id)
    let categoryName = nullable(body.categoria_nome)
    if (categoryId) {
      const category = await db.prepare('SELECT id, nome FROM categoria_movimentacao_cliente WHERE id = ? LIMIT 1').bind(categoryId).first<{ id: string; nome: string | null }>()
      if (!category) return c.json({ error: 'categoria_holding_invalida' }, 400)
      categoryName = category.nome ?? categoryName
    }
    const supplierId = nullable(body.fornecedor_id)
    let supplierName = nullable(body.fornecedor_nome)
    if (supplierId) {
      const supplier = await db.prepare('SELECT id, COALESCE(NULLIF(TRIM(apelido), \'\'), nome_completo) AS nome FROM fornecedores_favoritos WHERE id = ? LIMIT 1').bind(supplierId).first<{ id: string; nome: string | null }>()
      if (!supplier) return c.json({ error: 'fornecedor_holding_invalido' }, 400)
      supplierName = supplier.nome ?? supplierName
    }
    const key = nullable(body.idempotency_key)
    if (key) {
      const existing = await db.prepare('SELECT * FROM movimentos_holding WHERE idempotency_key = ? LIMIT 1').bind(key).first<Row>()
      if (existing) return c.json({ ...existing, idempotent: true })
    }
    const movementId = crypto.randomUUID()
    const dueDate = isoDate(body.data_vencimento) ? text(body.data_vencimento) : data
    const rateios = Array.isArray(body.rateios) ? body.rateios as Row[] : []
    const preparedRateios: Array<{ id: string; socioId: string; amount: number; percentage: number }> = []
    if (rateios.length) {
      if (!aircraftId) return c.json({ error: 'aeronave_obrigatoria_para_rateio' }, 400)
      let sum = 0
      for (const line of rateios) {
        const participantId = text(line.socio_id)
        const percentage = Number(line.percentual ?? line.percentual_sociedade)
        const lineAmount = Number(line.valor_centavos)
        if (!participantId || !Number.isFinite(percentage) || percentage <= 0 || !Number.isSafeInteger(lineAmount) || lineAmount <= 0) return c.json({ error: 'rateio_holding_invalido' }, 400)
        const validParticipant = await db.prepare(`SELECT hs.id FROM hold_socios hs
          JOIN cotista_aeronave ca ON ca.socio_id = hs.id
          WHERE hs.id = ? AND hs.holding_id = ? AND ca.aeronave_id = ? AND COALESCE(ca.status, 'ativo') <> 'inativo' LIMIT 1`).bind(participantId, holdingId, aircraftId).first()
        if (!validParticipant) return c.json({ error: 'socio_rateio_invalido' }, 400)
        sum += lineAmount
        preparedRateios.push({ id: crypto.randomUUID(), socioId: participantId, amount: lineAmount, percentage })
      }
      if (sum !== valor || Math.abs(preparedRateios.reduce((total, line) => total + line.percentage, 0) - 100) > 0.01) return c.json({ error: 'rateio_nao_confere_com_movimento' }, 400)
    }
    const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO movimentos_holding
      (id, holding_id, socio_id, aeronave_id, tipo_caixa, data_emissao, data_vencimento, periodicidade, descricao, numero_doc,
       fornecedor_id, fornecedor_nome, categoria_id, categoria_nome, grupo_categoria, fluxo,
       valor_centavos, status, pago_diretamente, observacoes, criado_por, idempotency_key)
      VALUES (?, ?, ?, ?, 'HOLD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EM_ABERTO', 0, ?, ?, ?)`)
      .bind(movementId, holdingId, socioId, aircraftId, data, dueDate, periodicidade, descricao, nullable(body.numero_doc), supplierId, supplierName, categoryId, categoryName, nullable(body.grupo_categoria), fluxo, valor, nullable(body.observacoes), c.get('userId') || null, key)]
    for (const line of preparedRateios) {
      statements.push(db.prepare(`INSERT INTO rateio_hold
        (id, movimento_id, aeronave_id, socio_id, data_emissao, data_vencimento, categoria_id, categoria_nome,
         tipo_rateio, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos,
         valor_pago_real_centavos, status, descricao_despesa, fornecedor_id, fornecedor, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, 0, 'EM_ABERTO', ?, ?, ?, ?)`)
        .bind(line.id, movementId, aircraftId, line.socioId, data, dueDate, categoryId, categoryName, nullable(body.tipo_rateio) || 'EXTRA', line.percentage, valor, line.amount, descricao, supplierId, supplierName, nullable(body.observacoes)))
    }
    await db.batch(statements)
    const created = await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movementId).first<Row>()
    return c.json(created, 201)
  } catch (error) { return errorResponse(c, error) }
})

movimentosHoldingRoutes.post('/movimentos-holding/:id/baixa', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const movimentoId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const dataPagamento = String(body.data_pagamento ?? '').trim()
    const bancoId = String(body.conta_bancaria_id ?? '').trim()
    if (!isoDate(dataPagamento) || !bancoId) return c.json({ error: 'data_e_conta_bancaria_obrigatorias' }, 400)
    const movimento = await db.prepare('SELECT * FROM movimentos_holding WHERE id = ? AND tipo_caixa = \'HOLD\'').bind(movimentoId).first<Row>()
    if (!movimento) return c.json({ error: 'movimento_holding_nao_encontrado' }, 404)
    const entrada = movimentoEhEntrada(movimento.fluxo)
    const statusFinal = entrada ? 'RECEBIDO' : 'PAGO'
    if (String(movimento.status).toUpperCase() === statusFinal) return c.json({ ...movimento, idempotent: true })
    if (['PAGO', 'RECEBIDO', 'CANCELADO'].includes(String(movimento.status).toUpperCase())) return c.json({ error: 'movimento_holding_ja_baixado_ou_cancelado' }, 409)
    const conta = await db.prepare("SELECT id, tipo_caixa, holding_id FROM contas_bancarias WHERE id = ? AND UPPER(tipo_caixa) = 'HOLDING' AND ativo = 1").bind(bancoId).first<{ id: string; tipo_caixa: string; holding_id: string | null }>()
    if (!conta || conta.holding_id !== movimento.holding_id) return c.json({ error: 'conta_bancaria_holding_invalida' }, 400)
    const envio = await db.prepare(`SELECT id, criado_por, descricao FROM envio_despesas
      WHERE movimentos_holding_id = ? OR movimentacao_id = ? LIMIT 1`).bind(movimentoId, movimentoId).first<Record<string, unknown>>()
    const statements = [
      db.prepare('UPDATE movimentos_holding SET status = ?, data_pagamento = ?, conta_bancaria_id = ?, forma_pagamento = ?, comprovante_url = COALESCE(?, comprovante_url), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(statusFinal, dataPagamento, bancoId, body.forma_pagamento ?? null, body.comprovante_url ?? null, movimentoId),
      db.prepare('UPDATE rateio_hold SET status = ?, data_pagamento = ?, valor_pago_real_centavos = valor_rateado_centavos, atualizado_em = CURRENT_TIMESTAMP WHERE movimento_id = ? AND status <> \'CANCELADO\'')
        .bind(statusFinal, dataPagamento, movimentoId),
      ...(!entrada ? [db.prepare("UPDATE contas_apagar SET status = 'PAGO', data_pagamento = ?, banco_pagamento = ?, comprovante_pagamento_url = COALESCE(?, comprovante_pagamento_url), atualizado_em = CURRENT_TIMESTAMP WHERE movimentos_id = ? AND UPPER(status) NOT IN ('PAGO', 'CANCELADO')")
        .bind(dataPagamento, bancoId, body.comprovante_url ?? null, movimentoId)] : []),
      ...(envio ? [
        db.prepare("UPDATE envio_despesas SET status = 'CONCLUIDO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('CONVERTIDO', 'APROVADO')").bind(envio.id),
        ...mensagemFinanceiraStatements(db, String(envio.criado_por ?? '') || null, c.get('userId') || null, entrada ? 'Recebimento Holding registrado' : 'Solicitação Holding concluída', `${entrada ? 'O recebimento' : 'O pagamento'} do movimento “${String(envio.descricao ?? 'Movimento Holding')}” foi registrado em ${dataPagamento}.`),
      ] : []),
    ]
    await db.batch(statements)
    return c.json({ ...(await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first()), idempotent: false })
  } catch (error) { return errorResponse(c, error) }
})
