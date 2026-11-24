import { Hono } from 'hono'
import { getAuthenticatedUserId, requireFlightOperationAccess } from '../lib/auth'
import { buscarPernaPlanejada, colunasPlanejamento, idAgendamentoPlanejado, type PernaPlanejada } from '../lib/pernasPlanejadas'
import { codigoAerodromoValido } from '../lib/aerodromo'
import { instanteUtc } from '../lib/jornadaTempo'
import { validateWorkerSchema } from '../lib/schema'
import type { Env } from '../types/env'

export const pernasPlanejadasRoutes = new Hono<{ Bindings: Env }>()
const root = '/api/interno/agendamento/:id/pernas-planejadas'

pernasPlanejadasRoutes.use(root + '*', async (c, next) => {
  if (!await requireFlightOperationAccess(c, c.req.param('id') || '')) return c.json({ error: 'flight_operation_forbidden' }, 403)
  try { await validateWorkerSchema(c, [{ table: 'solicitacoes_reserva_voo', columns: ['solicitacao_origem_id'] }]) }
  catch (error) {
    console.error('[planejamento-voo] schema indisponível', error)
    return c.json({ error: 'planejamento_indisponivel', detail: 'O planejamento de pernas está temporariamente indisponível.' }, 503)
  }
  const voo = await c.env.SHARE_DB.prepare('SELECT id, status, numero_voo FROM solicitacoes_reserva_voo WHERE id = ?1 AND excluida_em IS NULL AND solicitacao_origem_id IS NULL').bind(c.req.param('id')).first<{ id: string; status: string | null; numero_voo: string | null }>()
  if (!voo) return c.notFound()
  if (!voo.numero_voo?.trim() || !['aprovada', 'acionado', 'decolado', 'em_voo', 'em_rota', 'em_solo', 'pousado'].includes(String(voo.status || '').trim().toLowerCase())) {
    return c.json({ error: 'operacao_indisponivel', detail: 'Selecione uma operação aberta e com número de voo.' }, 409)
  }
  await next()
})

pernasPlanejadasRoutes.get(root, async c => {
  const rows = await c.env.SHARE_DB.prepare(`SELECT ${colunasPlanejamento} FROM solicitacoes_reserva_voo
    WHERE solicitacao_origem_id = ?1 AND lower(status) = 'aprovada' AND excluida_em IS NULL
    ORDER BY data_agendada, horario_previsto_agendamento, criado_em, id`)
    .bind(c.req.param('id')).all<PernaPlanejada>()
  return c.json({ pernas: rows.results || [] })
})

pernasPlanejadasRoutes.post(root, async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || Array.isArray(body)) return c.json({ error: 'payload_invalido' }, 400)
  const data = String(body.data_prevista || '')
  const origem = String(body.origem || '').trim().toUpperCase()
  const destino = String(body.destino || '').trim().toUpperCase()
  const passageiros = Number(body.numero_passageiros)
  const chave = String(body.chave_reenvio || '').trim()
  const instante = instanteUtc(`${data}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || instante === null) return c.json({ error: 'data_prevista_invalida' }, 400)
  if (!codigoAerodromoValido(origem) || !codigoAerodromoValido(destino)) return c.json({ error: 'aerodromos_invalidos' }, 400)
  if (!Number.isInteger(passageiros) || passageiros < 0) return c.json({ error: 'numero_passageiros_invalido' }, 400)
  if (!chave || chave.length > 120) return c.json({ error: 'chave_reenvio_obrigatoria' }, 400)
  const previsto = body.horario_previsto ? instanteUtc(body.horario_previsto) : null
  if (body.horario_previsto && (previsto === null || new Date(previsto).toISOString().slice(0, 10) !== data)) return c.json({ error: 'horario_previsto_invalido' }, 400)
  const horario = previsto === null ? null : new Date(previsto).toISOString()
  const db = c.env.SHARE_DB
  const solicitacaoId = c.req.param('id')
  const id = await idAgendamentoPlanejado(solicitacaoId, chave)
  const result = await db.prepare(`INSERT INTO solicitacoes_reserva_voo
    (id, solicitacao_origem_id, cliente_id, socio_id, cliente_emprestimo_id, socio_emprestimo_id, aeronave_id,
     voo_emprestado, origem, destino, data_agendada, horario_previsto_agendamento, dias_duracao,
     numero_passageiros, status, piloto_id, copiloto_id, numero_voo, aprovado_por, aprovado_em)
    SELECT ?1, id, cliente_id, socio_id, cliente_emprestimo_id, socio_emprestimo_id, aeronave_id,
      voo_emprestado, ?2, ?3, ?4, ?5, 1, ?6, 'aprovada', piloto_id, copiloto_id, numero_voo, ?7, CURRENT_TIMESTAMP
    FROM solicitacoes_reserva_voo
    WHERE id = ?8 AND excluida_em IS NULL AND solicitacao_origem_id IS NULL AND trim(numero_voo) <> ''
      AND lower(trim(status)) IN ('aprovada', 'acionado', 'decolado', 'em_voo', 'em_rota', 'em_solo', 'pousado')
    ON CONFLICT(id) DO NOTHING`)
    .bind(id, origem, destino, data, horario, passageiros, await getAuthenticatedUserId(c), solicitacaoId).run()
  const perna = await buscarPernaPlanejada(db, id, solicitacaoId)
  if (!perna) return c.json({ error: 'operacao_indisponivel' }, 409)
  if (perna.data_prevista !== data || perna.origem !== origem || perna.destino !== destino || perna.numero_passageiros !== passageiros || perna.horario_previsto !== horario) return c.json({ error: 'planejamento_reenvio_divergente' }, 409)
  return c.json(perna, result.meta.changes ? 201 : 200)
})

pernasPlanejadasRoutes.delete(root + '/:planejadaId', async c => {
  const db = c.env.SHARE_DB
  const perna = await buscarPernaPlanejada(db, c.req.param('planejadaId') || '', c.req.param('id') || '')
  if (!perna) return c.notFound()
  if (perna.status === 'INICIADA') return c.json({ error: 'perna_planejada_ja_iniciada' }, 409)
  const result = await db.prepare("UPDATE solicitacoes_reserva_voo SET status = 'cancelada', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1 AND solicitacao_origem_id = ?2 AND lower(status) IN ('aprovada', 'cancelada') AND excluida_em IS NULL")
    .bind(perna.id, perna.solicitacao_id).run()
  if (!result.meta.changes) return c.json({ error: 'perna_planejada_ja_iniciada' }, 409)
  return c.json({ success: true })
})
