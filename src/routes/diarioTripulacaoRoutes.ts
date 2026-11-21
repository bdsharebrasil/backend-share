import { Hono } from 'hono'
import type { Env } from '../types/env'
import { authenticatedColaborador, requireFlightCrewOrOperationsWriteAccess } from '../lib/auth'
import { recalcularTotaisDiarioAutomatico, sincronizarDiarioDaPerna } from '../lib/diarioAutomatico'

type Bindings = Env
export const diarioTripulacaoRoutes = new Hono<{ Bindings: Bindings }>()

const camposTexto = [
  'natureza_voo', 'ocorrencias', 'discrepancias', 'acoes_corretivas', 'carga_kg', 'diarias',
  'tipo_manutencao_ultima', 'tipo_manutencao_proxima', 'responsavel_aprovacao_manutencao', 'detectado_por',
] as const
const camposNumero = [
  'tempo_ifr', 'horas_diurnas', 'horas_noturnas', 'pousos_total', 'passageiros', 'distancia_nm',
  'litros_combustivel_inicio_voo', 'litros_combustivel_abastecido',
] as const

async function pernaComLancamento(db: D1Database, id: string) {
  return db.prepare(`
    SELECT p.id AS perna_id, p.lancamento_diario_id, p.horario_ac, p.horario_dep,
      p.horario_pouso, p.horario_corte, j.solicitacao_id,
      s.piloto_id, tp.user_id AS pic_user_id, tp.canac AS pic_canac,
      l.confirmado, l.assinado_pic, l.natureza_voo, l.tempo_voo, l.tempo_ifr,
      l.horas_diurnas, l.horas_noturnas, l.diario_mes_id, dm.fechado
    FROM pernas_jornada_voo p
    JOIN jornadas_voo j ON j.id = p.jornada_id
    JOIN solicitacoes_reserva_voo s ON s.id = j.solicitacao_id
    LEFT JOIN tripulacao tp ON tp.id = s.piloto_id
    LEFT JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
    LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id
    WHERE p.id = ?1 LIMIT 1
  `).bind(id).first<Record<string, any>>()
}

const status = (row: Record<string, any>) => !row.lancamento_id
  ? row.horario_ac ? 'SINCRONIZACAO_PENDENTE' : 'AGUARDANDO_AC'
  : Number(row.confirmado || 0) || row.assinado_pic ? 'ASSINADO' : 'RASCUNHO'

// Só a própria tripulação e a equipe operacional acessam o conteúdo.
diarioTripulacaoRoutes.get('/api/colaborador/diario-bordo/voos/:vooId', async c => {
  const vooId = c.req.param('vooId')
  if (!(await requireFlightCrewOrOperationsWriteAccess(c, vooId))) return c.json({ error: 'diario_acesso_negado' }, 403)
  const db = c.env.SHARE_DB
  const rows = await db.prepare(`
    SELECT p.id AS perna_id, p.jornada_id, p.numero AS numero_perna,
      p.origem, p.destino, p.horario_ac, p.horario_dep, p.horario_pouso,
      p.horario_corte, p.passageiros AS passageiros_perna,
      l.id AS lancamento_id, l.numero_sequencial, l.diario_mes_id, l.numero_voo,
      l.data_registro, l.aeronave_id, l.cliente_id, l.holding_id, l.socio_id,
      l.pic_canac, l.pic_nome, l.sic_canac, l.sic_nome, l.tempo_ac, l.tempo_dep,
      l.tempo_pou, l.tempo_cor, l.tempo_voo, l.tempo_total, l.tempo_ifr,
      l.horas_diurnas, l.horas_noturnas, l.pousos_total, l.passageiros,
      l.litros_combustivel_inicio_voo, l.litros_combustivel_abastecido,
      l.distancia_nm, l.carga_kg, l.diarias, l.natureza_voo,
      l.ocorrencias, l.discrepancias, l.acoes_corretivas,
      l.tipo_manutencao_ultima, l.tipo_manutencao_proxima,
      l.responsavel_aprovacao_manutencao, l.detectado_por,
      l.confirmado, l.assinado_pic, l.assinado_pic_user_id, l.data_assinatura,
      dm.ano AS diario_ano, dm.mes AS diario_mes, dm.fechado AS diario_fechado
    FROM jornadas_voo j JOIN pernas_jornada_voo p ON p.jornada_id = j.id
    LEFT JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
    LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id
    WHERE j.solicitacao_id = ?1 AND j.jornada_principal_id IS NULL
    ORDER BY date(j.data), j.numero_jornada, p.numero
  `).bind(vooId).all<Record<string, any>>()
  return c.json({ lancamentos: (rows.results || []).map(r => ({ ...r, status_lancamento: status(r) })) })
})

// Reexecutar para pernas já existentes antes da instalação da automação.
diarioTripulacaoRoutes.post('/api/colaborador/diario-bordo/voos/:vooId/sincronizar', async c => {
  const vooId = c.req.param('vooId')
  if (!(await requireFlightCrewOrOperationsWriteAccess(c, vooId))) return c.json({ error: 'diario_acesso_negado' }, 403)
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const legs = await db.prepare(`
    SELECT p.id FROM pernas_jornada_voo p JOIN jornadas_voo j ON j.id = p.jornada_id
    WHERE j.solicitacao_id = ?1 AND j.jornada_principal_id IS NULL ORDER BY j.data, p.numero
  `).bind(vooId).all<{ id: string }>()
  const resultados = []
  for (const leg of legs.results || []) {
    try { resultados.push({ perna_id: leg.id, ...await sincronizarDiarioDaPerna(db, leg.id, user.id) }) }
    catch (error) {
      console.error('[diario-auto:retroativo]', error)
      resultados.push({ perna_id: leg.id, status: 'dados_incompletos', detalhe: 'Falha ao persistir o rascunho; verifique a competência e os dados da aeronave.' })
    }
  }
  return c.json({ resultados })
})

// Completar informações adicionais sem mudar os horários operacionais da perna.
diarioTripulacaoRoutes.patch('/api/colaborador/diario-bordo/pernas/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const info = await pernaComLancamento(db, c.req.param('id'))
  if (!info) return c.notFound()
  if (!(await requireFlightCrewOrOperationsWriteAccess(c, info.solicitacao_id))) return c.json({ error: 'diario_acesso_negado' }, 403)
  if (!info.lancamento_diario_id) return c.json({ error: 'diario_rascunho_nao_criado', detail: 'Registre AC e sincronize a perna antes de complementar.' }, 409)
  if (Number(info.fechado)) return c.json({ error: 'diario_mes_fechado' }, 409)
  if (Number(info.confirmado) || info.assinado_pic) return c.json({ error: 'diario_ja_assinado' }, 409)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'payload_invalido' }, 400)
  const atualizacoes: [string, string | number | null][] = []
  for (const campo of camposTexto) if (body[campo] !== undefined) {
    const valor = String(body[campo] ?? '').trim()
    if (valor.length > 3000 || (campo === 'natureza_voo' && valor.length > 100)) return c.json({ error: 'texto_longo', campo }, 400)
    atualizacoes.push([campo, valor || null])
  }
  for (const campo of camposNumero) if (body[campo] !== undefined) {
    const valor = Number(body[campo] ?? 0)
    if (!Number.isFinite(valor) || valor < 0 || valor > 1_000_000 ||
        (['passageiros', 'pousos_total'].includes(campo) && !Number.isInteger(valor))) {
      return c.json({ error: 'valor_numerico_invalido', campo }, 400)
    }
    atualizacoes.push([campo, Number(valor.toFixed(2))])
  }
  const vooHoras = Number(info.tempo_voo || 0)
  const noturnas = Number(body.horas_noturnas ?? info.horas_noturnas ?? 0)
  const diurnas = Number(body.horas_diurnas ?? (body.horas_noturnas !== undefined ? vooHoras - noturnas : info.horas_diurnas ?? 0))
  if (body.horas_noturnas !== undefined || body.horas_diurnas !== undefined) {
    if (noturnas < 0 || diurnas < 0 || noturnas + diurnas > vooHoras + 0.02) return c.json({ error: 'horas_diurnas_noturnas_invalidas' }, 400)
    atualizacoes.push(['horas_diurnas', Number(diurnas.toFixed(2))])
    atualizacoes.push(['horas_noturnas', Number(noturnas.toFixed(2))])
  }
  if (body.tempo_ifr !== undefined && Number(body.tempo_ifr) > vooHoras + 0.02) return c.json({ error: 'horas_ifr_superiores_ao_voo' }, 400)
  const fields = atualizacoes.filter(([key], i) => atualizacoes.findIndex(([other]) => other === key) === i)
  if (!fields.length) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const result = await db.prepare(`UPDATE lancamentos_diario_bordo SET ${fields.map(([campo]) => `${campo} = ?`).join(', ')}
    WHERE id = ? AND COALESCE(confirmado, 0) = 0 AND NULLIF(TRIM(COALESCE(assinado_pic, '')), '') IS NULL`)
    .bind(...fields.map(([, value]) => value), info.lancamento_diario_id).run()
  if (!result.meta.changes) return c.json({ error: 'diario_alterado_ou_assinado' }, 409)
  const updated = await db.prepare('SELECT * FROM lancamentos_diario_bordo WHERE id = ?1').bind(info.lancamento_diario_id).first()
  return c.json({ lancamento: updated, status_lancamento: 'RASCUNHO' })
})

// Confirmação eletrônica por PIC: nome, data e user_id auditáveis no D1.
diarioTripulacaoRoutes.post('/api/colaborador/diario-bordo/pernas/:id/assinar', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const db = c.env.SHARE_DB
  const info = await pernaComLancamento(db, c.req.param('id'))
  if (!info) return c.notFound()
  // Não basta ter permissão operacional ou ser copiloto: o usuário deve ser
  // exatamente o comandante da solicitação. Fallback CANAC só sem user_id.
  const picValido = (info.pic_user_id && info.pic_user_id === user.id)
    || (!info.pic_user_id && String(info.pic_canac || '').trim()
      && String(info.pic_canac).trim().toLowerCase() === String(user.canac || '').trim().toLowerCase())
  if (!picValido || !info.piloto_id) return c.json({ error: 'assinatura_exclusiva_comandante' }, 403)
  if (!info.lancamento_diario_id) return c.json({ error: 'diario_rascunho_nao_criado' }, 409)
  if (Number(info.fechado)) return c.json({ error: 'diario_mes_fechado' }, 409)
  if (Number(info.confirmado) || info.assinado_pic) return c.json({ error: 'diario_ja_assinado' }, 409)
  if (!info.horario_ac || !info.horario_dep || !info.horario_pouso || !info.horario_corte) {
    return c.json({ error: 'horarios_incompletos_para_assinatura' }, 409)
  }
  if (!String(info.natureza_voo || '').trim() || !String(info.pic_canac || '').trim()) {
    return c.json({ error: 'natureza_voo_e_canac_pic_obrigatorios' }, 409)
  }
  const body = await c.req.json<{ confirmar_assinatura?: boolean }>().catch(() => null)
  if (body?.confirmar_assinatura !== true) return c.json({ error: 'confirmacao_expressa_obrigatoria' }, 400)
  const momento = new Date().toISOString()
  const result = await db.prepare(`
    UPDATE lancamentos_diario_bordo
    SET assinado_pic = ?1, data_assinatura = ?2, assinado_pic_user_id = ?3,
        confirmado = 1, confirmado_em = ?2
    WHERE id = ?4 AND COALESCE(confirmado, 0) = 0
      AND NULLIF(TRIM(COALESCE(assinado_pic, '')), '') IS NULL
  `).bind(user.nome_completo || user.nome_exibicao || user.id, momento, user.id, info.lancamento_diario_id).run()
  if (!result.meta.changes) return c.json({ error: 'diario_ja_assinado' }, 409)
  return c.json({
    status_lancamento: 'ASSINADO',
    lancamento_id: info.lancamento_diario_id,
    comandante: user.nome_completo || user.nome_exibicao || user.id,
    assinado_em: momento,
  })
})
