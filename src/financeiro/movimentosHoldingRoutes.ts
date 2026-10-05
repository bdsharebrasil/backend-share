import { Hono } from "hono"
import { mensagemFinanceiraStatements } from "./financeiroNotifications"
import { errorResponse } from "./errorResponse"
import { requireCaixaShareAccess } from "./access"
import { listar } from "./repositories/d1"

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }

export const movimentosHoldingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
movimentosHoldingRoutes.get('/movimentos-holding/pendentes', async (c) => {
  try {
    const movimentos = await listar(c.env.SHARE_DB, `SELECT mh.id, mh.holding_id, h.nome AS holding_nome,
        mh.socio_id, hs.nome AS socio_nome, mh.aeronave_id, a.matricula_registro AS aeronave,
        mh.data_emissao, mh.data_vencimento, mh.descricao, mh.categoria_nome, mh.valor_centavos,
        mh.status, mh.fornecedor_nome,
        COALESCE((SELECT SUM(rh.valor_rateado_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS rateado_centavos,
        COALESCE((SELECT SUM(rh.valor_pago_real_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS pago_centavos
      FROM movimentos_holding mh
      LEFT JOIN holdings h ON h.id = mh.holding_id
      LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
      LEFT JOIN aeronave a ON a.id = mh.aeronave_id
      WHERE mh.tipo_caixa = 'HOLD' AND UPPER(mh.fluxo) = 'SAIDA'
        AND UPPER(mh.status) IN ('EM_ABERTO', 'EM_ATRASO', 'AGUARDANDO_REEMBOLSO')
        AND COALESCE(mh.pago_diretamente, 0) = 0
      ORDER BY date(mh.data_vencimento) ASC, mh.criado_em DESC LIMIT 500`)
    return c.json({ movimentos })
  } catch (error) { return errorResponse(c, error) }
})

movimentosHoldingRoutes.post('/movimentos-holding/:id/baixa', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const movimentoId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const dataPagamento = String(body.data_pagamento ?? '').trim()
    const bancoId = String(body.conta_bancaria_id ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPagamento) || !bancoId) return c.json({ error: 'data_e_conta_bancaria_obrigatorias' }, 400)
    const movimento = await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first<Record<string, unknown>>()
    if (!movimento) return c.json({ error: 'movimento_holding_nao_encontrado' }, 404)
    if (String(movimento.status).toUpperCase() === 'PAGO') return c.json({ ...movimento, idempotent: true })
    if (String(movimento.status).toUpperCase() === 'CANCELADO') return c.json({ error: 'movimento_holding_cancelado' }, 409)
    const conta = await db.prepare("SELECT id FROM contas_bancarias WHERE id = ? AND tipo_caixa = 'HOLDING' AND holding_id = ? AND ativo = 1").bind(bancoId, movimento.holding_id).first()
    if (!conta) return c.json({ error: 'conta_bancaria_holding_invalida' }, 400)
    const envio = await db.prepare(`SELECT id, criado_por, descricao FROM envio_despesas
      WHERE movimentos_holding_id = ? OR movimentacao_id = ? LIMIT 1`).bind(movimentoId, movimentoId).first<Record<string, unknown>>()
    const statements = [
      db.prepare("UPDATE movimentos_holding SET status = 'PAGO', data_pagamento = ?, conta_bancaria_id = ?, forma_pagamento = ?, comprovante_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(dataPagamento, bancoId, body.forma_pagamento ?? null, body.comprovante_url ?? null, movimentoId),
      db.prepare("UPDATE rateio_hold SET status = 'PAGO', data_pagamento = ?, valor_pago_real_centavos = valor_rateado_centavos, atualizado_em = CURRENT_TIMESTAMP WHERE movimento_id = ? AND status <> 'CANCELADO'")
        .bind(dataPagamento, movimentoId),
      ...(envio ? [
        db.prepare("UPDATE envio_despesas SET status = 'CONCLUIDO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('CONVERTIDO', 'APROVADO')").bind(envio.id),
        ...mensagemFinanceiraStatements(db, String(envio.criado_por ?? '') || null, c.get('userId') || null, 'Solicitação Holding concluída', `O pagamento da solicitação “${String(envio.descricao ?? 'Despesa Holding')}” foi concluído em ${dataPagamento}.`),
      ] : []),
    ]
    await db.batch(statements)
    return c.json({ ...(await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first()), idempotent: false })
  } catch (error) { return errorResponse(c, error) }
})
