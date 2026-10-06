import { Hono } from 'hono'
import { shareBrasilUser } from '../lib/auth'
import { getPontoServerTimestamp } from '../lib/ponto'
import { uuid } from '../lib/strings'
import type { Env } from '../types/env'

type Bindings = Pick<Env, 'SHARE_DB' | 'SUPABASE_URL'>

export const shareBrasilPontoRoutes = new Hono<{ Bindings: Bindings }>()

function horasEntre(inicio: string | null, fim: string | null): number | null {
  if (!inicio || !fim) return null
  const [ih, im] = inicio.split(':').map(Number)
  const [fh, fm] = fim.split(':').map(Number)
  if (![ih, im, fh, fm].every(Number.isFinite)) return null
  const total = ((fh * 60 + fm) - (ih * 60 + im)) / 60
  return total >= 0 ? Math.round(total * 100) / 100 : null
}

shareBrasilPontoRoutes.post('/marcar', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<{ acao?: string }>().catch(() => ({} as { acao?: string }))
  const acao = body.acao || ''
  const columns: Record<string, { campo: string; status: string }> = {
    entrada: { campo: 'entrada_hora', status: 'working' },
    inicio_almoco: { campo: 'inicio_almoco', status: 'lunch' },
    fim_almoco: { campo: 'fim_almoco', status: 'working' },
    pausa: { campo: 'inicio_almoco', status: 'paused' },
    saida: { campo: 'saida_hora', status: 'finished' },
    encerrar: { campo: 'saida_hora', status: 'finished' },
  }
  const target = columns[acao]
  if (!target) return c.json({ error: 'acao_invalida' }, 400)

  const { data, hora } = getPontoServerTimestamp()
  const db = c.env.SHARE_DB
  const row = await db.prepare('SELECT * FROM lancamento_ponto WHERE user_id = ?1 AND data_entrada = ?2 LIMIT 1').bind(user.id, data).first<any>()
  const entrada = target.campo === 'entrada_hora' ? hora : row?.entrada_hora || null
  const saida = target.campo === 'saida_hora' ? hora : row?.saida_hora || null
  const total = horasEntre(entrada, saida)

  if (!row) {
    await db.prepare(`INSERT OR IGNORE INTO lancamento_ponto (id, user_id, data_entrada, ${target.campo}, status, horas_totais) VALUES (?, ?, ?, ?, ?, ?)`).bind(uuid(), user.id, data, hora, target.status, total).run()
  }

  const persisted = await db.prepare('SELECT * FROM lancamento_ponto WHERE user_id = ?1 AND data_entrada = ?2 LIMIT 1').bind(user.id, data).first<any>()
  if (!persisted) return c.json({ error: 'falha_ao_criar_lancamento' }, 500)

  await db.prepare(`UPDATE lancamento_ponto SET ${target.campo} = ?, status = ?, horas_totais = COALESCE(?, horas_totais), atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).bind(hora, target.status, total, persisted.id, user.id).run()
  return c.json({ success: true, id: persisted.id, data_entrada: data, campo: target.campo, hora, status: target.status, horas_totais: total })
})
