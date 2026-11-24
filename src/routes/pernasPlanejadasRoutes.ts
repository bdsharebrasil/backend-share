import { Hono } from 'hono'
import { getAuthenticatedUserId, requireFlightOperationAccess } from '../lib/auth'
import { buscarPernaPlanejada, type PernaPlanejada } from '../lib/pernasPlanejadas'
import { codigoAerodromoValido } from '../lib/aerodromo'
import { instanteUtc } from '../lib/jornadaTempo'
import { validateWorkerSchema } from '../lib/schema'
import { uuid } from '../lib/strings'
import type { Env } from '../types/env'

export const pernasPlanejadasRoutes = new Hono<{ Bindings: Env }>()
const root = '/api/interno/agendamento/:id/pernas-planejadas'

pernasPlanejadasRoutes.use(root + '*', async (c, next) => {
  if (!await requireFlightOperationAccess(c, c.req.param('id') || '')) return c.json({ error: 'flight_operation_forbidden' }, 403)
  try { await validateWorkerSchema(c, [{ table: 'pernas_planejadas_voo', columns: ['id', 'solicitacao_id', 'data_prevista', 'chave_reenvio', 'perna_jornada_id'] }]) }
  catch (error) {
    console.error('[planejamento-voo] schema indisponível', error)
    return c.json({ error: 'planejamento_indisponivel', detail: 'O planejamento de pernas está temporariamente indisponível.' }, 503)
  }
  const voo = await c.env.SHARE_DB.prepare('SELECT id, status FROM solicitacoes_reserva_voo WHERE id = ?1').bind(c.req.param('id')).first<{ id: string; status: string }>()
  if (!voo) return c.notFound()
  if (['encerrada', 'concluida', 'cancelada', 'reprovada'].includes(voo.status.toLowerCase())) return c.json({ error: 'operacao_encerrada' }, 409)
  await next()
})

pernasPlanejadasRoutes.get(root, async c => {
  const rows = await c.env.SHARE_DB.prepare("SELECT * FROM pernas_planejadas_voo WHERE solicitacao_id = ?1 AND status = 'PLANEJADA' ORDER BY data_prevista, horario_previsto, criado_em, id")
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
  const id = uuid()
  const result = await db.prepare(`INSERT INTO pernas_planejadas_voo
    (id, solicitacao_id, data_prevista, origem, destino, horario_previsto, numero_passageiros, chave_reenvio, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(solicitacao_id, chave_reenvio) DO NOTHING`)
    .bind(id, c.req.param('id'), data, origem, destino, horario, passageiros, chave, await getAuthenticatedUserId(c)).run()
  const perna = await db.prepare('SELECT * FROM pernas_planejadas_voo WHERE solicitacao_id = ?1 AND chave_reenvio = ?2')
    .bind(c.req.param('id'), chave).first<PernaPlanejada>()
  if (!perna || perna.data_prevista !== data || perna.origem !== origem || perna.destino !== destino || perna.numero_passageiros !== passageiros || perna.horario_previsto !== horario) return c.json({ error: 'planejamento_reenvio_divergente' }, 409)
  return c.json(perna, result.meta.changes ? 201 : 200)
})

pernasPlanejadasRoutes.delete(root + '/:planejadaId', async c => {
  const db = c.env.SHARE_DB
  const perna = await buscarPernaPlanejada(db, c.req.param('planejadaId') || '', c.req.param('id') || '')
  if (!perna) return c.notFound()
  if (perna.status === 'INICIADA') return c.json({ error: 'perna_planejada_ja_iniciada' }, 409)
  const result = await db.prepare("UPDATE pernas_planejadas_voo SET status = 'CANCELADA', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1 AND solicitacao_id = ?2 AND status <> 'INICIADA'")
    .bind(perna.id, perna.solicitacao_id).run()
  if (!result.meta.changes) return c.json({ error: 'perna_planejada_ja_iniciada' }, 409)
  return c.json({ success: true })
})
