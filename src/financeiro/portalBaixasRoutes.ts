import { Hono } from 'hono'
import { contextoBaixaCotista, settleCotista } from './FinanceiroKernel'
import { errorResponse } from './errorResponse'
import { requireCaixaShareAccess } from './access'

type Bindings = { SHARE_DB: D1Database; SHARE_FILES?: R2Bucket; FILES?: R2Bucket }
type Variables = { userId: string | null }
export const portalBaixasRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type Solicitacao = {
  id: string
  rateio_id: string
  pagador_cotista_id: string
  valor_centavos: number
  data_pagamento: string
  data_vencimento: string | null
  comprovante_url: string | null
  observacoes: string | null
  status_solicitacao: string
  criado_em: string
  descricao_despesa: string | null
  valor_rateado_centavos: number
  valor_pago_real_centavos: number
  status_rateio: string
  lancamento_id: string | null
  nome_cotista: string | null
  aeronave: string | null
}

async function solicitacaoPendente(db: D1Database, id: string): Promise<Solicitacao | null> {
  return db.prepare(`SELECT p.id, p.rateio_id, p.pagador_cotista_id, p.valor_centavos, p.data_pagamento,
      p.comprovante_url, p.observacoes, p.status AS status_solicitacao, p.criado_em,
      r.descricao_despesa, r.valor_rateado_centavos, r.valor_pago_real_centavos, r.status AS status_rateio, r.data_vencimento,
      r.lancamento_id,
      COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, 'Cotista') AS nome_cotista,
      a.matricula_registro AS aeronave
    FROM rateio_pagamentos p
    JOIN rateio_despesas r ON r.id = p.rateio_id
    LEFT JOIN cotista_aeronave ca ON ca.id = p.pagador_cotista_id
    LEFT JOIN cliente cl ON cl.id = ca.cliente_id
    LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
    LEFT JOIN aeronave a ON a.id = r.aeronave_id
    WHERE p.id = ? AND p.forma_pagamento = 'COMPROVANTE_PORTAL'
      AND p.status IN ('PENDENTE', 'CANCELADO')
    LIMIT 1`).bind(id).first<Solicitacao>()
}

portalBaixasRoutes.get('/solicitacoes-baixa-portal', async c => {
  const { results } = await c.env.SHARE_DB.prepare(`SELECT p.id
    FROM rateio_pagamentos p
    WHERE p.forma_pagamento = 'COMPROVANTE_PORTAL' AND p.status = 'PENDENTE'
    ORDER BY p.criado_em ASC LIMIT 200`).all<{ id: string }>()
  const solicitacoes = await Promise.all((results ?? []).map(async ({ id }) => {
    const row = await solicitacaoPendente(c.env.SHARE_DB, id)
    if (!row) return null
    const publicRow = { ...row, comprovante_url: undefined }
    try {
      const contexto = await contextoBaixaCotista(c.env.SHARE_DB, row.rateio_id)
      return {
        ...publicRow,
        descricao_despesa: row.descricao_despesa || String((contexto.lancamento as Record<string, unknown> | undefined)?.descricao ?? ''),
        natureza: contexto.natureza,
        comprovante_path: `/api/financeiro/solicitacoes-baixa-portal/${encodeURIComponent(row.id)}/comprovante`,
      }
    } catch (error) {
      return {
        ...publicRow,
        natureza: null,
        erro_contexto: error instanceof Error ? error.message : 'contexto_baixa_indisponivel',
        comprovante_path: `/api/financeiro/solicitacoes-baixa-portal/${encodeURIComponent(row.id)}/comprovante`,
      }
    }
  }))
  return c.json({ solicitacoes: solicitacoes.filter(Boolean) })
})

portalBaixasRoutes.get('/solicitacoes-baixa-portal/:id/comprovante', async c => {
  const request = await solicitacaoPendente(c.env.SHARE_DB, c.req.param('id'))
  const key = String(request?.comprovante_url ?? '')
  if (!request || !key.startsWith(`portal-cliente/comprovantes/rateio/${request.rateio_id}/`)) return c.notFound()
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

portalBaixasRoutes.post('/solicitacoes-baixa-portal/:id/aprovar', async c => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const request = await solicitacaoPendente(db, id)
    if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
    if (request.status_solicitacao === 'CANCELADO') {
      return String(request.observacoes || '').includes('[Solicitação aprovada; baixa conciliada pelo financeiro]')
        ? c.json({ success: true, idempotent: true })
        : c.json({ error: 'solicitacao_ja_processada' }, 409)
    }
    if (String(request.status_rateio).toUpperCase() === 'CANCELADO') return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
    const pending = await db.prepare("SELECT id FROM rateio_pagamentos WHERE id = ? AND status = 'PENDENTE' AND forma_pagamento = 'COMPROVANTE_PORTAL'").bind(id).first()
    if (!pending) return c.json({ error: 'solicitacao_ja_processada' }, 409)
    const body = await c.req.json<{ data_pagamento?: unknown; conta_bancaria_id?: unknown }>().catch(() => null)
    const dataPagamento = String(body?.data_pagamento ?? '').trim()
    const dataValidada = /^\d{4}-\d{2}-\d{2}$/.test(dataPagamento) ? new Date(`${dataPagamento}T00:00:00Z`) : null
    if (!dataValidada || !Number.isFinite(dataValidada.getTime()) || dataValidada.toISOString().slice(0, 10) !== dataPagamento) {
      return c.json({ error: 'data_pagamento_invalida' }, 400)
    }
    const contexto = await contextoBaixaCotista(db, request.rateio_id)
    if (contexto.natureza === 'RECEBIMENTO_SHARE') {
      const denied = await requireCaixaShareAccess(c)
      if (denied) return denied
      const contaId = String(body?.conta_bancaria_id ?? '').trim()
      if (!contaId) return c.json({ error: 'conta_bancaria_obrigatoria' }, 400)
      const contaShare = await db.prepare("SELECT id FROM contas_bancarias WHERE id = ? AND COALESCE(ativo, 1) = 1 AND upper(COALESCE(tipo_caixa, 'SHARE')) = 'SHARE'").bind(contaId).first()
      if (!contaShare) return c.json({ error: 'conta_bancaria_share_invalida' }, 400)
    }
    const settlement = await settleCotista(db, request.rateio_id, {
      pagamentos: [{
        idempotency_key: `PORTAL_BAIXA:${request.id}`,
        tipo_pagador: 'COTISTA',
        pagador_cotista_id: request.pagador_cotista_id,
        valor_centavos: request.valor_centavos,
        data_pagamento: dataPagamento,
        conta_bancaria_id: contexto.natureza === 'RECEBIMENTO_SHARE' ? String(body?.conta_bancaria_id).trim() : null,
        forma_pagamento: 'COMPROVANTE_PORTAL',
        comprovante_url: request.comprovante_url,
        observacoes: request.observacoes || 'Pagamento confirmado após solicitação no Portal Cliente',
        rateios: [{ rateio_id: request.rateio_id, valor_centavos: request.valor_centavos }],
      }],
    }, c.get('userId') || null)
    await db.prepare("UPDATE rateio_pagamentos SET status = 'CANCELADO', observacoes = COALESCE(observacoes, '') || ' [Solicitação aprovada; baixa conciliada pelo financeiro]' WHERE id = ? AND status = 'PENDENTE'")
      .bind(id).run()
    return c.json({ success: true, settlement })
  } catch (error) {
    return errorResponse(c, error)
  }
})
