import { Hono, type Context } from 'hono'
import { requireFlightOperationAccess, requireShareInternal, extractSupabaseUserId } from '../lib/auth'
import { buscarPernaPlanejada, vincularPernaPlanejada } from '../lib/pernasPlanejadas'
import { validateWorkerSchema } from '../lib/schema'
import { uuid } from '../lib/strings'
import { sincronizarDiarioDaPerna, type ResultadoDiarioAutomatico } from '../lib/diarioAutomatico'
import { getAuthenticatedUserId } from '../lib/auth'
import { calcularMinutosJornada, LIMITES_SISTEMA_JORNADA, referenciaJornada, somarAcumuladosRegistrados } from '../lib/calculoJornada'
import { instanteUtc, limiteDiarioConfigurado } from '../lib/jornadaTempo'
import type { Env } from '../types/env'

type Bindings = Env & { JORNADA_LIMITE_DIARIO_MINUTOS?: string }
type Variables = Record<string, never>
export const jornadasRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
/** Falha de sincronização não apaga horários já registrados; a API informa a
 * pendência e oferece sincronização retroativa no Diário do colaborador. */
async function sincronizarRascunhoSemPerderHorarios(
  db: D1Database, pernaId: string, userId: string | null,
): Promise<ResultadoDiarioAutomatico> {
  try { return await sincronizarDiarioDaPerna(db, pernaId, userId) }
  catch (e) {
    console.error('[jornada:diario-automatico]', e)
    return { status: 'dados_incompletos', detalhe: 'Horários registrados; o rascunho do Diário requer revisão. Abra o Diário e tente sincronizar.' }
  }
}


async function garantirTabelaJornadas(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  await validateWorkerSchema(c, [
    { table: 'jornadas_voo', columns: ['id', 'solicitacao_id', 'aeronave_id', 'data', 'horario_acionamento', 'horario_apresentacao', 'horario_decolagem', 'tripulante_id', 'funcao_tripulante', 'jornada_principal_id', 'status'] },
    { table: 'pernas_jornada_voo', columns: ['id', 'jornada_id', 'numero', 'origem', 'destino', 'horario_programado', 'horario_ac', 'horario_dep', 'horario_pouso', 'horario_corte', 'horario_ac_user_id', 'horario_dep_user_id', 'horario_pouso_user_id', 'horario_corte_user_id', 'passageiros', 'status'] },
  ])
}

function normalizarPernaJornada(perna: any) {
  return {
    ...perna,
    numero_passageiros: perna.numero_passageiros ?? (perna.passageiros == null ? 0 : Number(perna.passageiros)),
  }
}

function normalizarJornadaRegistro(jornada: any) {
  return {
    ...jornada,
    horario_dep: jornada.horario_dep ?? jornada.tempo_dep ?? null,
    horario_pouso: jornada.horario_pouso ?? jornada.horario_corte_inicio ?? null,
    horario_corte: jornada.horario_corte ?? jornada.horario_corte_final ?? null,
    pernas: Array.isArray(jornada.pernas) ? jornada.pernas.map(normalizarPernaJornada) : jornada.pernas,
  }
}
// Padrões operacionais herdados; não representam enquadramento legal universal.
const LIMITES_JORNADA = LIMITES_SISTEMA_JORNADA
const STATUS_JORNADA = ['em_solo', 'em_rota', 'pousado', 'encerrada'] as const

function normalizarNumeroPassageiros(valor: unknown): number | null {
  if (valor === undefined || valor === null || valor === '') return 0
  const numero = Number(valor)
  return Number.isInteger(numero) && numero >= 0 ? numero : null
}

function normalizarHorarioJornada(data: string, valor: unknown, referencia?: string | null): string | null {
  const texto = String(valor ?? '').trim()
  if (!texto) return null
  let instante: Date | null = null
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const tempo = instanteUtc(texto)
    instante = tempo !== null ? new Date(tempo) : null
  } else if (/^\d{2}:\d{2}(?::\d{2})?$/.test(texto)) {
    const tempo = instanteUtc(`${data}T${texto.length === 5 ? `${texto}:00` : texto}Z`)
    instante = tempo !== null ? new Date(tempo) : null
  }
  if (!instante) return null
  const base = referencia ? new Date(referencia).getTime() : NaN
  if (Number.isFinite(base) && instante.getTime() < base && !/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    while (instante.getTime() < base) instante = new Date(instante.getTime() + 86_400_000)
  }
  if (Number.isFinite(base) && instante.getTime() < base) return null
  return instante.toISOString()
}

export function derivarHorarioApresentacao(acionamento: string): string | null {
  const instante = new Date(acionamento).getTime()
  return Number.isFinite(instante) ? new Date(instante - 30 * 60_000).toISOString() : null
}

function nivelAlertaJornada(minutos: number, limite: number): 'normal' | 'atencao' | 'critico' | 'excedido' {
  const pct = limite > 0 ? minutos / limite : 0
  return pct > 1 ? 'excedido' : pct >= 0.9 ? 'critico' : pct >= 0.75 ? 'atencao' : 'normal'
}

function minutosDaJornada(jornada: any, fimPrevisto?: string | null): number {
  return calcularMinutosJornada(jornada, fimPrevisto) ?? 0
}

async function sincronizarResumoJornada(db: D1Database, jornadaId: string) {
  const alvo = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(jornadaId).first<any>()
  if (!alvo) return []
  const raizId = alvo.jornada_principal_id || alvo.id
  const pernas = await db.prepare('SELECT * FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero').bind(raizId).all<any>()
  const registros = pernas.results || []
  const ultimaPerna = registros[registros.length - 1]
  const irmas = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1 OR jornada_principal_id = ?1').bind(raizId).all<any>()
  const atualizacoes = (irmas.results || []).map((item: any) => {
    const fase = ultimaPerna?.horario_pouso || ['em_solo', 'pousado'].includes(ultimaPerna?.status) ? 'em_solo'
      : ultimaPerna?.horario_dep || ultimaPerna?.status === 'em_voo' ? 'em_rota'
        : ultimaPerna?.horario_ac || item.horario_acionamento ? 'em_solo' : null
    const minutos = calcularMinutosJornada({ ...item, pernas: registros }, ultimaPerna?.horario_corte || undefined)
    return db.prepare(`UPDATE jornadas_voo SET horario_pouso = ?1, horario_corte = ?2, horario_decolagem = ?3,
        minutos_jornada = ?4, status = CASE WHEN status = 'encerrada' OR ?5 IS NULL THEN status ELSE ?5 END,
        atualizado_em = CURRENT_TIMESTAMP WHERE id = ?6`)
      .bind(ultimaPerna?.horario_pouso || null, ultimaPerna?.horario_corte || null,
        registros[0]?.horario_dep || null, minutos, fase, item.id)
  })
  if (atualizacoes.length) await db.batch(atualizacoes)
  return registros
}

async function acumuladoTripulante(db: D1Database, tripulanteId: string | null, data: string, referencia: string, ignorarId = '') {
  if (!tripulanteId) return { semana: 0, mes: 0, registros_incompletos: 1 }
  const registros = await db.prepare(`SELECT id, tripulante_id, jornada_principal_id, data, horario_apresentacao,
      horario_corte, minutos_pos_corte, minutos_jornada, status FROM jornadas_voo
    WHERE tripulante_id = ?1 AND status = 'encerrada'`).bind(tripulanteId).all<any>()
  return somarAcumuladosRegistrados(registros.results || [], data, referencia, ignorarId)
}

async function avaliarLimitesJornada(c: Context<{ Bindings: Bindings; Variables: Variables }>, jornada: any, fimPrevisto?: string | null) {
  const db = c.env.SHARE_DB
  const raizId = jornada.jornada_principal_id || jornada.id
  const minutos = minutosDaJornada(jornada, fimPrevisto)
  const referencia = referenciaJornada(jornada, fimPrevisto)
  const acumulado = await acumuladoTripulante(db, jornada.tripulante_id, jornada.data, referencia, jornada.id)
  const limiteDia = limiteDiarioConfigurado(jornada.limite_jornada_minutos, c.env.JORNADA_LIMITE_DIARIO_MINUTOS)
  const limiteSemana = Number(jornada.limite_semanal_minutos || LIMITES_JORNADA.semana)
  const limiteMes = Number(jornada.limite_mensal_minutos || LIMITES_JORNADA.mes)
  const semana = acumulado.semana + minutos
  const mes = acumulado.mes + minutos
  const pernasAbertas = await db.prepare("SELECT COUNT(*) AS total FROM pernas_jornada_voo WHERE jornada_id = ?1 AND status = 'em_voo'").bind(raizId).first<any>()
  const niveis = [nivelAlertaJornada(minutos, limiteDia), nivelAlertaJornada(semana, limiteSemana), nivelAlertaJornada(mes, limiteMes)]
  const ordem = ['normal', 'atencao', 'critico', 'excedido']
  return {
    jornada_id: jornada.id, tripulante_id: jornada.tripulante_id, data: jornada.data, minutos_jornada: minutos,
    limite_jornada_minutos: limiteDia, restante_minutos: limiteDia - minutos,
    nivel_alerta: niveis.reduce((maior, item) => (ordem.indexOf(item) > ordem.indexOf(maior) ? item : maior), 'normal'),
    semana: { minutos: semana, limite: limiteSemana, restante: limiteSemana - semana, nivel: niveis[1] },
    mes: { minutos: mes, limite: limiteMes, restante: limiteMes - mes, nivel: niveis[2] },
    pernas_abertas: Number(pernasAbertas?.total || 0),
    referencia_em: referencia,
    criterio_semanal: 'data da jornada e seis dias anteriores, em UTC',
    dados_incompletos: calcularMinutosJornada(jornada, fimPrevisto) === null || acumulado.registros_incompletos > 0
      || (jornada.status === 'encerrada' && !jornada.horario_corte && !jornada.pernas?.[jornada.pernas.length - 1]?.horario_corte),
    validacao_legal_completa: false,
  }
}

export function statusPerna(p: { horario_ac?: string | null; horario_corte?: string | null; horario_pouso?: string | null; horario_dep?: string | null }) {
  if (p.horario_corte) return 'cortado'
  if (p.horario_pouso) return 'em_solo'
  if (p.horario_dep) return 'em_voo'
  if (p.horario_ac) return 'acionado'
  return 'programada'
}

export function determinarStatusAgendamentoVoo(statusAtual: string, faseAtual?: string | null) {
  const status = String(statusAtual || '').trim().toLowerCase()
  if (['encerrada', 'concluida', 'cancelada', 'reprovada', 'pendente'].includes(status)) return status
  const fase = String(faseAtual || '').trim().toLowerCase()
  if (fase === 'em_solo' || fase === 'pousado') return 'em_solo'
  if (fase === 'decolado' || ['em_voo', 'em_rota', 'em voo'].includes(fase)) return 'decolado'
  if (fase === 'acionado') return 'acionado'
  if (['em_voo', 'em_rota', 'em voo'].includes(status)) return 'decolado'
  return status
}

export function checklistPreVooConcluido(status: unknown) {
  return String(status || '').trim().toLowerCase() === 'concluido'
}

export function agendamentoPermiteIniciarJornada(status: unknown) {
  const normalizado = String(status || '').trim().toLowerCase().replace(/\s+/g, '_')
  return ['aprovada', 'acionado', 'decolado', 'em_rota', 'em_voo', 'em_solo'].includes(normalizado)
}
export function agendamentoPermiteCompletarHorarios(status: unknown, fasePerna?: unknown) {
  const normalizado = String(status || '').trim().toLowerCase().replace(/\s+/g, '_')
  if (['encerrada', 'concluida', 'cancelada', 'reprovada', 'pendente'].includes(normalizado)) return false
  const fase = String(fasePerna || '').trim().toLowerCase().replace(/\s+/g, '_')
  if (normalizado === 'aprovada' && fase === 'programada') return true
  if (['acionado', 'decolado', 'em_rota', 'em_voo', 'em_solo', 'pousado'].includes(normalizado)) return true
  return ['acionado', 'em_voo', 'em_solo', 'pousado'].includes(fase)
}

async function sincronizarStatusAgendamentoVoo(db: D1Database, solicitacaoId: string) {
  const [agendamento, ultimaFase] = await Promise.all([
    db.prepare('SELECT status FROM solicitacoes_reserva_voo WHERE id = ?1').bind(solicitacaoId).first<{ status: string }>(),
    db.prepare(`SELECT CASE
        WHEN (CASE WHEN p.id IS NOT NULL THEN p.horario_pouso ELSE j.horario_pouso END) IS NOT NULL
          OR (p.id IS NOT NULL AND p.status IN ('em_solo', 'pousado'))
          OR (p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) = 'pousado') THEN 'em_solo'
        WHEN (p.id IS NOT NULL AND p.horario_dep IS NOT NULL)
          OR (p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) IN ('decolado', 'em_rota', 'em_voo', 'em voo')) THEN 'decolado'
        WHEN (p.id IS NOT NULL AND (p.horario_ac IS NOT NULL OR p.status = 'acionado'))
          OR (p.id IS NULL AND (j.horario_acionamento IS NOT NULL OR lower(trim(COALESCE(j.status, ''))) = 'acionado')) THEN 'acionado'
        WHEN p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) = 'em_solo' THEN 'em_solo'
      END AS fase
      FROM jornadas_voo j
      LEFT JOIN pernas_jornada_voo p ON p.jornada_id = COALESCE(j.jornada_principal_id, j.id)
      WHERE j.solicitacao_id = ?1
      ORDER BY j.numero_jornada DESC, COALESCE(p.numero, 0) DESC, j.criado_em DESC, j.id DESC
      LIMIT 1`).bind(solicitacaoId).first<{ fase: string | null }>(),
  ])
  if (!agendamento) return
  const status = determinarStatusAgendamentoVoo(agendamento.status, ultimaFase?.fase)
  await db.prepare('UPDATE solicitacoes_reserva_voo SET status = ?1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2')
    .bind(status, solicitacaoId).run()
  return status
}

export function agruparJornadasVoo(registros: any[]) {
  const grupos = new Map<string, { raizId: string; registros: any[]; representante: any }>()
  for (const registro of registros) {
    const raizId = String(registro.jornada_principal_id || registro.id)
    const grupo = grupos.get(raizId) || { raizId, registros: [], representante: null }
    grupo.registros.push(registro)
    grupos.set(raizId, grupo)
  }
  return [...grupos.values()].map((grupo) => {
    grupo.representante = grupo.registros.find((item) => String(item.id) === grupo.raizId)
      || grupo.registros.find((item) => item.funcao_tripulante === 'PIC')
      || grupo.registros[0]
    return grupo
  }).sort((a, b) => Number(b.representante.numero_jornada || 0) - Number(a.representante.numero_jornada || 0)
    || String(b.representante.data || '').localeCompare(String(a.representante.data || ''))
    || a.raizId.localeCompare(b.raizId))
}

// Consulta exclusiva para planejamento: não cria pernas nem recalcula/atualiza jornadas.
jornadasRoutes.get('/api/interno/agendamento/:id/pernas-plano', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  try {
    await validateWorkerSchema(c, [
      { table: 'jornadas_voo', columns: ['id', 'solicitacao_id', 'numero_jornada', 'data'] },
      { table: 'pernas_jornada_voo', columns: ['id', 'jornada_id', 'numero', 'origem', 'destino', 'passageiros', 'horario_programado', 'horario_ac', 'horario_dep', 'horario_pouso', 'horario_corte', 'horario_ac_user_id', 'horario_dep_user_id', 'horario_pouso_user_id', 'horario_corte_user_id', 'status'] },
    ])
    const resultado = await c.env.SHARE_DB.prepare(`SELECT p.id, p.jornada_id, j.numero_jornada, j.data,
        p.numero, p.origem, p.destino, p.passageiros AS numero_passageiros, p.horario_programado,
        p.horario_ac, p.horario_dep, p.horario_pouso, p.horario_corte,
        p.horario_ac_user_id, p.horario_dep_user_id, p.horario_pouso_user_id, p.horario_corte_user_id, p.status
      FROM pernas_jornada_voo p
      JOIN jornadas_voo j ON j.id = p.jornada_id
      WHERE j.solicitacao_id = ?1
      ORDER BY date(j.data), j.numero_jornada, p.numero, p.id`)
      .bind(c.req.param('id')).all()
    return c.json({ pernas: resultado.results || [] })
  } catch (error) {
    console.error('[pernas-plano] falha na consulta', error)
    return c.json({ error: 'pernas_voo_indisponiveis', detail: 'Não foi possível consultar os trechos deste voo. Tente novamente.' }, 503)
  }
})

jornadasRoutes.get('/api/interno/agendamento/:id/jornada', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  try {
    await garantirTabelaJornadas(c)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'O schema de jornadas não está disponível no banco operacional.'
    console.error('[jornada] schema incompatível', error)
    return c.json({ error: 'jornada_schema_incompativel', detail }, 503)
  }
  const idSolicitacao = c.req.param('id')
  const jornadas = await c.env.SHARE_DB.prepare('SELECT * FROM jornadas_voo WHERE solicitacao_id = ?1 ORDER BY numero_jornada DESC, date(data) DESC, id').bind(idSolicitacao).all<any>()
  const registrosBase = (jornadas.results || []).map(normalizarJornadaRegistro)
  const registros = await Promise.all(registrosBase.map(async (registro: any) => {
    if (!registro.tripulante_id) return registro
    const tripulante = await c.env.SHARE_DB.prepare(`SELECT COALESCE(t.nome_completo, f.nome_completo) AS tripulante_nome
      FROM (SELECT ?1 AS id) x
      LEFT JOIN tripulacao t ON t.id = x.id
      LEFT JOIN tripulacao_freelancer f ON f.id = x.id`).bind(registro.tripulante_id).first<{ tripulante_nome: string | null }>()
    return { ...registro, tripulante_nome: tripulante?.tripulante_nome || null }
  }))
  const grupos = agruparJornadasVoo(registros)
  const grupoAtual = grupos.find((grupo) => grupo.registros.some((j: any) => j.status !== 'encerrada')) || grupos[0]
  const principal = grupoAtual?.registros.find((j: any) => j.status !== 'encerrada' && j.id === grupoAtual.raizId)
    || grupoAtual?.registros.find((j: any) => j.status !== 'encerrada')
    || grupoAtual?.representante
  if (!principal) return c.json(null)
  const raiz = grupoAtual.raizId
  const pernas = await c.env.SHARE_DB.prepare('SELECT * FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero').bind(raiz).all<any>()
  let pernasNormalizadas = (pernas.results || []).map(normalizarPernaJornada)
  if (!pernasNormalizadas.length && principal.status !== 'encerrada' && (principal.horario_acionamento || principal.horario_decolagem || principal.horario_dep || principal.horario_pouso || principal.horario_corte)) {
    const voo = await c.env.SHARE_DB.prepare('SELECT origem, destino FROM solicitacoes_reserva_voo WHERE id = ?1').bind(idSolicitacao).first<{ origem: string | null; destino: string | null }>()
    const origem = String(voo?.origem || '').trim().toUpperCase()
    const destino = String(voo?.destino || '').trim().toUpperCase()
    if (origem && destino) {
      const horarioDep = principal.horario_decolagem || principal.horario_dep || null
      const status = statusPerna({ horario_dep: horarioDep, horario_pouso: principal.horario_pouso, horario_corte: principal.horario_corte })
      const pernaId = uuid()
      await c.env.SHARE_DB.prepare(`INSERT INTO pernas_jornada_voo (id, jornada_id, numero, origem, destino, passageiros, horario_ac, horario_dep, horario_pouso, horario_corte, status)
        VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?)`).bind(pernaId, raiz, origem, destino, principal.horario_acionamento || null, horarioDep, principal.horario_pouso || null, principal.horario_corte || null, status === 'programada' && principal.status === 'em_rota' ? 'em_voo' : status).run()
      pernasNormalizadas = [(await c.env.SHARE_DB.prepare('SELECT * FROM pernas_jornada_voo WHERE id = ?1').bind(pernaId).first<any>())].filter(Boolean).map(normalizarPernaJornada)
    }
  }
  const doVoo = grupoAtual.registros
  const historico = await Promise.all(grupos.map(async (grupo) => ({
    ...grupo.representante,
    pernas: (await c.env.SHARE_DB.prepare('SELECT * FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero').bind(grupo.raizId).all<any>()).results.map(normalizarPernaJornada),
  })))
  return c.json({
    ...principal,
    pernas: pernasNormalizadas,
    limites: await avaliarLimitesJornada(c, { ...principal, pernas: pernasNormalizadas }),
    tripulantes: await Promise.all(doVoo.map(async (j: any) => ({ ...j, pernas: pernasNormalizadas, limites: await avaliarLimitesJornada(c, { ...j, pernas: pernasNormalizadas }) }))),
    historico,
  })
})

jornadasRoutes.get('/api/interno/jornadas/:id/limites', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const jornada = await c.env.SHARE_DB.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(c.req.param('id')).first<any>()
  if (!jornada) return c.notFound()
  const pernas = await c.env.SHARE_DB.prepare('SELECT horario_ac, horario_corte FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero').bind(jornada.jornada_principal_id || jornada.id).all<any>()
  const corteFinal = normalizarHorarioJornada(String(jornada.data || ''), c.req.query('corte_final'), jornada.horario_apresentacao)
  if (c.req.query('corte_final') && !corteFinal) return c.json({ error: 'corte_final_invalido' }, 400)
  return c.json(await avaliarLimitesJornada(c, { ...jornada, pernas: pernas.results || [] }, corteFinal))
})

jornadasRoutes.post('/api/interno/agendamento/:id/jornada', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaJornadas(c)
  const db = c.env.SHARE_DB
  const idSolicitacao = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (body.aguardar_horarios === true) return c.json({ error: 'planejamento_nao_cria_jornada', detail: 'Agende a próxima perna da solicitação. A jornada só começa ao registrar o acionamento.' }, 400)
  const planejada = body.perna_planejada_id ? await buscarPernaPlanejada(db, String(body.perna_planejada_id), idSolicitacao) : null
  if (body.perna_planejada_id && (!planejada || planejada.status !== 'PLANEJADA')) return c.json({ error: 'perna_planejada_indisponivel' }, 409)
  if (planejada) Object.assign(body, { origem: planejada.origem, destino: planejada.destino, numero_passageiros: planejada.numero_passageiros })
  const voo = await db.prepare('SELECT aeronave_id, piloto_id, copiloto_id, data_agendada, numero_voo, status FROM solicitacoes_reserva_voo WHERE id = ?1').bind(idSolicitacao).first<any>()
  if (!voo) return c.notFound()
  const statusVoo = String(voo.status || '').trim().toLowerCase()
  if (statusVoo === 'encerrada' || statusVoo === 'concluida') return c.json({ error: 'agendamento_encerrado', detail: 'Operações encerradas são somente leitura e não podem receber nova jornada.' }, 409)
  if (!agendamentoPermiteIniciarJornada(statusVoo)) return c.json({ error: 'agendamento_nao_aprovado', detail: 'A jornada só pode ser iniciada para um agendamento aprovado, em voo ou em solo.' }, 409)
  const checklist = await db.prepare('SELECT status FROM checklists_pre_voo WHERE solicitacao_id = ?1 ORDER BY criado_em DESC LIMIT 1').bind(idSolicitacao).first<{ status: string | null }>()
  if (!checklistPreVooConcluido(checklist?.status)) return c.json({ error: 'checklist_pre_voo_obrigatorio', detail: 'Conclua o checklist pré-voo antes de iniciar a jornada.' }, 409)
  const tripulantes = (Array.isArray(body.tripulantes) && body.tripulantes.length
    ? body.tripulantes
    : [{ tripulante_id: voo.piloto_id, funcao: 'PIC' }, { tripulante_id: voo.copiloto_id, funcao: 'SIC' }]
  ).filter((item: any) => item?.tripulante_id)
    .map((item: any) => ({ tripulante_id: String(item.tripulante_id), funcao: item.funcao === 'SIC' ? 'SIC' : 'PIC' }))
  if (!tripulantes.length) return c.json({ error: 'tripulante_obrigatorio' }, 400)
  if (!tripulantes.some((item: any) => item.funcao === 'PIC')) tripulantes[0].funcao = 'PIC'
  for (const item of tripulantes) {
    // Verifica jornada aberta em QUALQUER voo (não só nesta solicitação): um tripulante não pode
    // estar em duas jornadas simultâneas, senão os limites de 9h/44h/176h ficam furados enquanto
    // a jornada duplicada nunca é encerrada (e por isso nunca soma nos acumulados).
    const aberta = await db.prepare(`SELECT j.id, j.solicitacao_id, s.numero_voo,
        COALESCE(t.nome_completo, f.nome_completo) AS tripulante_nome
      FROM jornadas_voo j
      LEFT JOIN solicitacoes_reserva_voo s ON s.id = j.solicitacao_id
      LEFT JOIN tripulacao t ON t.id = j.tripulante_id
      LEFT JOIN tripulacao_freelancer f ON f.id = j.tripulante_id
      WHERE j.tripulante_id = ?1 AND j.status <> 'encerrada' LIMIT 1`)
      .bind(item.tripulante_id).first<{ id: string; solicitacao_id: string; numero_voo: string | null; tripulante_nome: string | null }>()
    if (aberta) {
      return c.json({
        error: aberta.solicitacao_id === idSolicitacao ? 'jornada_ja_iniciada' : 'tripulante_em_jornada_outro_voo',
        tripulante_id: item.tripulante_id, jornada_id: aberta.id, solicitacao_id: aberta.solicitacao_id,
        numero_voo: aberta.numero_voo || voo.numero_voo || null, tripulante_nome: aberta.tripulante_nome || null,
        detail: aberta.solicitacao_id === idSolicitacao ? undefined : 'Este tripulante já tem uma jornada em aberto em outro voo. Encerre-a antes de iniciar uma nova.',
      }, 409)
    }
  }
  const posCorte = body.minutos_pos_corte === undefined ? LIMITES_JORNADA.posCorte : Number(body.minutos_pos_corte)
  if (![30, 45].includes(posCorte)) return c.json({ error: 'pos_corte_invalido', detail: 'Selecione 30 minutos para voo doméstico ou 45 para internacional.' }, 400)
  const data = String(body.data || voo.data_agendada || '')
  const origem = String(body.origem || body.aerodromo_partida || '').trim().toUpperCase()
  const destino = String(body.destino || body.aerodromo_chegada || '').trim().toUpperCase()
  const numeroPassageiros = normalizarNumeroPassageiros(body.numero_passageiros)
  if (numeroPassageiros === null) return c.json({ error: 'numero_passageiros_invalido' }, 400)
  const horarioProgramado = planejada?.horario_previsto || null
  const apresentacaoInformada = normalizarHorarioJornada(data, body.horario_apresentacao || body.tripulacao_checkin_hora)
  const acionamentoInformado = normalizarHorarioJornada(data, body.horario_acionamento || body.tempo_ac, apresentacaoInformada)
  const apresentacao = apresentacaoInformada || (acionamentoInformado ? derivarHorarioApresentacao(acionamentoInformado) : null)
  const acionamento = acionamentoInformado || (apresentacaoInformada ? new Date(new Date(apresentacaoInformada).getTime() + 30 * 60_000).toISOString() : null)
  const userId = extractSupabaseUserId(c)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !origem || !destino || (!apresentacao || !acionamento)) return c.json({ error: 'data_rota_e_acionamento_obrigatorios', detail: 'Informe a data, partida, chegada e acionamento. Para planejar sem horários reais, agende uma próxima perna.' }, 400)
  if (new Date(acionamento).getTime() - new Date(apresentacao).getTime() !== 30 * 60_000) {
    return c.json({ error: 'apresentacao_deve_ser_30_minutos_antes_do_acionamento' }, 400)
  }
  const corteInicio = normalizarHorarioJornada(data, body.horario_pouso, apresentacao)
  const horarioDep = normalizarHorarioJornada(data, body.horario_dep || body.tempo_dep, acionamento || apresentacao)
  const numero = await db.prepare('SELECT COALESCE(MAX(numero_jornada), 0) + 1 AS proximo FROM jornadas_voo WHERE solicitacao_id = ?1').bind(idSolicitacao).first<{ proximo: number }>()
  const numeroJornada = Number(numero?.proximo || 1)
  const idsCriadas: string[] = []
  const comandos: D1PreparedStatement[] = []
  let principalId: string | null = null
  let primeiraPernaId: string | null = null
  for (const item of tripulantes.sort((a: any) => (a.funcao === 'PIC' ? -1 : 1))) {
    const jornadaId = uuid()
    comandos.push(db.prepare(`INSERT INTO jornadas_voo
        (id, solicitacao_id, aeronave_id, tripulante_id, funcao_tripulante, jornada_principal_id, numero_jornada, data,
         horario_apresentacao, horario_acionamento, horario_decolagem, horario_pouso, minutos_pos_corte, status, observacoes, criado_por)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       ${planejada ? "WHERE EXISTS (SELECT 1 FROM pernas_planejadas_voo WHERE id = ? AND status = 'PLANEJADA')" : ''}`)
      .bind(jornadaId, idSolicitacao, voo.aeronave_id, item.tripulante_id, item.funcao, principalId, numeroJornada, data,
         apresentacao, acionamento, horarioDep, corteInicio, posCorte, corteInicio ? 'em_solo' : horarioDep ? 'em_rota' : 'em_solo',
        body.observacoes || null, extractSupabaseUserId(c), ...(planejada ? [planejada.id] : [])))
    if (!principalId) {
      principalId = jornadaId
      primeiraPernaId = planejada?.id || uuid()
      comandos.push(db.prepare(`INSERT INTO pernas_jornada_voo
        (id, jornada_id, numero, origem, destino, passageiros, horario_programado, horario_ac, horario_dep, horario_ac_user_id, horario_dep_user_id, status)
        SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM jornadas_voo WHERE id = ?)`)
        .bind(primeiraPernaId, jornadaId, origem, destino, numeroPassageiros, horarioProgramado, acionamento, horarioDep,
          acionamento ? userId : null, horarioDep ? userId : null,
          statusPerna({ horario_ac: acionamento, horario_dep: horarioDep }), jornadaId))
    }
    idsCriadas.push(jornadaId)
  }
  if (planejada && primeiraPernaId) comandos.push(vincularPernaPlanejada(db, planejada.id, idSolicitacao, primeiraPernaId))
  const resultados = await db.batch(comandos)
  if (!resultados[0]?.meta?.changes) return c.json({ error: 'perna_planejada_ja_iniciada' }, 409)
  const criadas = await Promise.all(idsCriadas.map(id => db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(id).first<any>()))
  await db.prepare(`UPDATE solicitacoes_reserva_voo
      SET horario_previsto_agendamento = ?1,
          status = CASE
            WHEN ?3 IS NOT NULL AND lower(trim(status)) IN ('aprovada', 'acionado', 'decolado', 'em_rota', 'em rota', 'em_voo', 'em voo', 'em_solo', 'pousado') THEN 'em_solo'
            WHEN ?2 IS NOT NULL AND lower(trim(status)) IN ('aprovada', 'acionado', 'decolado', 'em_rota', 'em rota', 'em_voo', 'em voo', 'em_solo', 'pousado') THEN 'decolado'
            WHEN ?1 IS NOT NULL AND lower(trim(status)) IN ('aprovada', 'acionado', 'decolado', 'em_rota', 'em rota', 'em_voo', 'em voo', 'em_solo', 'pousado') THEN 'acionado'
            ELSE status
          END,
          atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?4`).bind(acionamento, horarioDep, corteInicio, idSolicitacao).run()
  const pernas = await db.prepare('SELECT * FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero').bind(principalId).all<any>()
  const principal = criadas[0]
  const diarioBordo = primeiraPernaId && acionamento
    ? await sincronizarRascunhoSemPerderHorarios(db, primeiraPernaId, await getAuthenticatedUserId(c))
    : { status: 'aguardando_ac' as const }
  return c.json({
    ...principal,
    horario_programado: horarioProgramado,
    diario_bordo: diarioBordo,
    pernas: (pernas.results || []).map(normalizarPernaJornada),
    limites: await avaliarLimitesJornada(c, { ...principal, pernas: (pernas.results || []).map(normalizarPernaJornada) }),
    tripulantes: await Promise.all(criadas.map(async (item) => ({ ...item, pernas: (pernas.results || []).map(normalizarPernaJornada), limites: await avaliarLimitesJornada(c, { ...item, pernas: (pernas.results || []).map(normalizarPernaJornada) }) }))),
  }, 201)
})

jornadasRoutes.patch('/api/interno/jornadas/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const db = c.env.SHARE_DB
  const atual = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(c.req.param('id')).first<any>()
  if (!atual) return c.notFound()
  if (!(await requireFlightOperationAccess(c, atual.solicitacao_id))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const data = String(body.data || atual.data)
  const apresentacao = body.horario_apresentacao !== undefined ? normalizarHorarioJornada(data, body.horario_apresentacao) : atual.horario_apresentacao
  const acionamento = body.horario_acionamento !== undefined ? normalizarHorarioJornada(data, body.horario_acionamento, apresentacao) : atual.horario_acionamento
  const ultimaPerna = await db.prepare('SELECT horario_pouso, horario_corte FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero DESC LIMIT 1').bind(atual.jornada_principal_id || atual.id).first<any>()
  const corteInicio = normalizarHorarioJornada(data, body.horario_pouso ?? ultimaPerna?.horario_pouso ?? atual.horario_pouso, acionamento || apresentacao)
  const corteFinal = normalizarHorarioJornada(data, body.horario_corte ?? ultimaPerna?.horario_corte ?? atual.horario_corte, corteInicio || acionamento || apresentacao)
  if (!apresentacao || !acionamento || new Date(acionamento).getTime() - new Date(apresentacao).getTime() !== 30 * 60_000) {
    return c.json({ error: 'apresentacao_deve_ser_30_minutos_antes_do_acionamento' }, 400)
  }
  const status = body.status ?? atual.status
  if (!STATUS_JORNADA.includes(status)) return c.json({ error: 'status_invalido' }, 400)
  let minutos: number | null = atual.minutos_jornada
  let nivel = atual.nivel_alerta
  if (status === 'encerrada') {
    if (!corteFinal) return c.json({ error: 'corte_final_obrigatorio' }, 400)
    const raizId = atual.jornada_principal_id || atual.id
    const abertas = await db.prepare("SELECT COUNT(*) AS total FROM pernas_jornada_voo WHERE jornada_id = ?1 AND status = 'em_voo'").bind(raizId).first<any>()
    if (Number(abertas?.total || 0)) return c.json({ error: 'perna_em_voo', detail: 'Registre o pouso de todas as pernas antes de encerrar a jornada.' }, 409)
    const irmas = await db.prepare(`SELECT * FROM jornadas_voo
      WHERE (id = ?1 OR jornada_principal_id = ?1 OR jornada_principal_id = ?2)
        AND status <> 'encerrada'`).bind(atual.id, atual.jornada_principal_id || atual.id).all<any>()
    const alvos = (irmas.results || []).length ? irmas.results : [atual]
    const avaliacoes = await Promise.all(alvos.map(async (item: any) => {
      const pernasItem = await db.prepare('SELECT horario_ac, horario_corte FROM pernas_jornada_voo WHERE jornada_id = ?1 ORDER BY numero').bind(item.jornada_principal_id || item.id).all<any>()
      return { item, limites: await avaliarLimitesJornada(c, { ...item, horario_apresentacao: apresentacao, pernas: pernasItem.results || [] }, corteFinal) }
    }))
    const excedido = avaliacoes.find(({ limites }) => limites.nivel_alerta === 'excedido')
    if (excedido && body.confirmar_excedente !== true) {
      return c.json({ error: 'limite_jornada_excedido', tripulante_id: excedido.item.tripulante_id, limites: excedido.limites,
        detail: 'A jornada ultrapassa um dos limites configurados para este tripulante. Reenvie com confirmar_excedente para registrar a exceção.' }, 409)
    }
    for (const { item, limites } of avaliacoes) {
      await db.prepare(`UPDATE jornadas_voo SET horario_apresentacao = ?1, horario_acionamento = ?2, horario_pouso = ?3,
          horario_corte = ?4, data = ?5, status = 'encerrada', observacoes = ?6, minutos_jornada = ?7, nivel_alerta = ?8
         WHERE id = ?9`)
        .bind(apresentacao, acionamento, corteInicio, corteFinal, data,
          item.id === atual.id ? (body.observacoes ?? atual.observacoes) : item.observacoes,
          limites.minutos_jornada, limites.nivel_alerta, item.id).run()
    }
    await db.prepare(`UPDATE solicitacoes_reserva_voo
      SET horario_previsto_agendamento = ?1,
          atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?2`).bind(acionamento, atual.solicitacao_id).run()
    const statusAgendamento = await sincronizarStatusAgendamentoVoo(db, atual.solicitacao_id)
    // Encerrar uma jornada não finaliza o agendamento. A solicitação permanece
    // aprovada para permitir outra jornada no mesmo número de voo.
    const atualizada = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(atual.id).first<any>()
    return c.json({ ...atualizada, status_agendamento: statusAgendamento, limites: await avaliarLimitesJornada(c, atualizada),
      tripulantes: avaliacoes.map(({ item, limites }) => ({ id: item.id, tripulante_id: item.tripulante_id, funcao: item.funcao_tripulante, limites })) })
  }
  await db.prepare(`UPDATE jornadas_voo SET horario_apresentacao = ?1, horario_acionamento = ?2, horario_pouso = ?3,
      horario_corte = ?4, data = ?5, status = ?6, observacoes = ?7, minutos_jornada = ?8, nivel_alerta = ?9
     WHERE id = ?10`)
    .bind(apresentacao, acionamento, corteInicio, corteFinal, data, status, body.observacoes !== undefined ? body.observacoes : atual.observacoes, minutos, nivel, atual.id).run()
  await db.prepare(`UPDATE solicitacoes_reserva_voo
    SET horario_previsto_agendamento = ?1,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?2`).bind(acionamento, atual.solicitacao_id).run()
  const statusAgendamento = await sincronizarStatusAgendamentoVoo(db, atual.solicitacao_id)
  const jornada = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(atual.id).first<any>()
  return c.json({ ...jornada, status_agendamento: statusAgendamento, limites: await avaliarLimitesJornada(c, jornada) })
})

jornadasRoutes.delete('/api/interno/jornadas/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const db = c.env.SHARE_DB
  const jornada = await db.prepare('SELECT id, jornada_principal_id, solicitacao_id FROM jornadas_voo WHERE id = ?1').bind(c.req.param('id')).first<any>()
  if (!jornada) return c.notFound()
  const raizId = jornada.jornada_principal_id || jornada.id
  const vinculada = await db.prepare(`SELECT id FROM pernas_jornada_voo WHERE jornada_id = ?1 AND lancamento_diario_id IS NOT NULL LIMIT 1`).bind(raizId).first<any>()
  if (vinculada) return c.json({ error: 'jornada_com_diario_vinculado', detail: 'Não é possível excluir uma jornada que possui perna lançada no Diário de Bordo.' }, 409)
  await db.batch([
    db.prepare('DELETE FROM pernas_jornada_voo WHERE jornada_id = ?1').bind(raizId),
    db.prepare('DELETE FROM jornadas_voo WHERE id = ?1 OR jornada_principal_id = ?1').bind(raizId),
  ])
  return c.json({ success: true, id: raizId, solicitacao_id: jornada.solicitacao_id })
})

jornadasRoutes.delete('/api/interno/jornadas/:jornadaId/pernas/:pernaId', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const db = c.env.SHARE_DB
  const perna = await db.prepare('SELECT id, jornada_id, lancamento_diario_id FROM pernas_jornada_voo WHERE id = ?1 AND jornada_id = ?2').bind(c.req.param('pernaId'), c.req.param('jornadaId')).first<any>()
  if (!perna) return c.notFound()
  if (perna.lancamento_diario_id) return c.json({ error: 'perna_ja_lancada_no_diario', detail: 'Não é possível excluir uma perna que possui lançamento no Diário de Bordo.' }, 409)
  await db.prepare('DELETE FROM pernas_jornada_voo WHERE id = ?1').bind(perna.id).run()
  await sincronizarResumoJornada(db, perna.jornada_id)
  return c.json({ success: true, id: perna.id, jornada_id: perna.jornada_id })
})

jornadasRoutes.post('/api/interno/agendamento/:id/finalizar', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const id = c.req.param('id')
  const agendamento = await c.env.SHARE_DB.prepare('SELECT id, status, numero_voo FROM solicitacoes_reserva_voo WHERE id = ?1').bind(id).first<any>()
  if (!agendamento) return c.notFound()
  if (['encerrada', 'concluida'].includes(String(agendamento.status || '').trim().toLowerCase())) return c.json({ error: 'agendamento_ja_encerrado', detail: 'A operação já está encerrada e não pode ser concluída novamente.' }, 409)
  const jornadas = await c.env.SHARE_DB.prepare('SELECT status FROM jornadas_voo WHERE solicitacao_id = ?1').bind(id).all<any>()
  if (!jornadas.results?.length) return c.json({ error: 'jornada_obrigatoria', detail: 'Registre pelo menos uma jornada antes de finalizar o agendamento.' }, 409)
  if (jornadas.results.some((j: any) => j.status !== 'encerrada')) return c.json({ error: 'jornadas_pendentes', detail: 'Encerre todas as jornadas antes de finalizar o agendamento.' }, 409)
  await c.env.SHARE_DB.prepare("UPDATE solicitacoes_reserva_voo SET status = 'encerrada', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?1").bind(id).run()
  return c.json({ success: true, status: 'encerrada', id, numero_voo: agendamento.numero_voo })
})

jornadasRoutes.post('/api/interno/jornadas/:id/pernas', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const db = c.env.SHARE_DB
  let jornada = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(c.req.param('id')).first<any>()
  if (!jornada) return c.notFound()
  const raiz = jornada.jornada_principal_id || jornada.id
  if (raiz !== jornada.id) {
    jornada = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(raiz).first<any>()
    if (!jornada) return c.notFound()
  }
  if (!(await requireFlightOperationAccess(c, jornada.solicitacao_id))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  if (jornada.status === 'encerrada') return c.json({ error: 'jornada_encerrada' }, 409)
  const emVoo = await db.prepare("SELECT id FROM pernas_jornada_voo WHERE jornada_id = ?1 AND status = 'em_voo' LIMIT 1").bind(jornada.id).first()
  if (emVoo) return c.json({ error: 'perna_anterior_em_voo', detail: 'Registre o pouso da perna anterior antes de abrir uma nova.' }, 409)
  const b = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const planejada = b.perna_planejada_id ? await buscarPernaPlanejada(db, String(b.perna_planejada_id), jornada.solicitacao_id) : null
  if (b.perna_planejada_id && (!planejada || planejada.status !== 'PLANEJADA')) return c.json({ error: 'perna_planejada_indisponivel' }, 409)
  if (planejada) Object.assign(b, { origem: planejada.origem, destino: planejada.destino, numero_passageiros: planejada.numero_passageiros })
  const ultima = await db.prepare('SELECT COALESCE(MAX(numero), 0) AS n, MAX(COALESCE(horario_corte, horario_pouso, horario_dep, horario_ac)) AS ultimo FROM pernas_jornada_voo WHERE jornada_id = ?1').bind(jornada.id).first<any>()
  const referencia = ultima?.ultimo || jornada.horario_apresentacao
  const origem = String(b.origem || '').trim().toUpperCase()
  const destino = String(b.destino || '').trim().toUpperCase()
  const horarioProgramado = normalizarHorarioJornada(jornada.data, b.horario_programado ?? b.horario_previsto ?? b.horario_ac ?? b.tempo_ac, referencia)
  const horarioAc = b.horario_ac !== undefined || b.tempo_ac !== undefined
    ? normalizarHorarioJornada(jornada.data, b.horario_ac ?? b.tempo_ac, referencia)
    : null
  if (planejada && !horarioAc) return c.json({ error: 'acionamento_obrigatorio', detail: 'A perna permanece planejada até registrar o acionamento.' }, 400)
  if (!origem || !destino || !horarioProgramado) return c.json({ error: 'origem_destino_e_horario_programado_obrigatorios' }, 400)
  if ((b.horario_ac !== undefined || b.tempo_ac !== undefined) && !horarioAc) return c.json({ error: 'horario_ac_invalido' }, 400)
  const horarioDep = normalizarHorarioJornada(jornada.data, b.horario_dep ?? b.tempo_dep, horarioAc || horarioProgramado)
  const horarioPouso = normalizarHorarioJornada(jornada.data, b.horario_pouso ?? b.tempo_pou, horarioDep || horarioAc || horarioProgramado)
  const horarioCorte = normalizarHorarioJornada(jornada.data, b.horario_corte ?? b.tempo_cor, horarioPouso || horarioDep || horarioAc || horarioProgramado)
  const participantes = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1 OR jornada_principal_id = ?1').bind(jornada.id).all<any>()
  const avaliacoes = await Promise.all((participantes.results?.length ? participantes.results : [jornada]).map(async (participante: any) => ({
    participante, limites: await avaliarLimitesJornada(c, participante, horarioCorte || horarioPouso || horarioDep || horarioAc || horarioProgramado),
  })))
  const excedido = avaliacoes.find((avaliacao) => avaliacao.limites.nivel_alerta === 'excedido')
  const limitesPrevistos = excedido?.limites || avaliacoes[0].limites
  if (excedido && b.confirmar_excedente !== true) {
    return c.json({
      error: 'limite_jornada_excedido',
      tripulante_id: excedido.participante.tripulante_id,
      limites: limitesPrevistos,
      detail: 'Iniciar esta perna ultrapassa um dos limites configurados para um tripulante do grupo. Reenvie com confirmar_excedente para registrar a exceção.'
    }, 409)
  }
  const pernaId = planejada?.id || uuid()
  const numero = Number(ultima?.n || 0) + 1
  const numeroPassageiros = normalizarNumeroPassageiros(b.numero_passageiros)
  if (numeroPassageiros === null) return c.json({ error: 'numero_passageiros_invalido' }, 400)
  const status = statusPerna({ horario_ac: horarioAc, horario_dep: horarioDep, horario_pouso: horarioPouso, horario_corte: horarioCorte })
  const userId = extractSupabaseUserId(c)
  const inserir = db.prepare(`INSERT INTO pernas_jornada_voo
    (id, jornada_id, numero, origem, destino, passageiros, horario_programado, horario_ac, horario_dep, horario_pouso, horario_corte,
     horario_ac_user_id, horario_dep_user_id, horario_pouso_user_id, horario_corte_user_id, status)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ${planejada ? "WHERE EXISTS (SELECT 1 FROM pernas_planejadas_voo WHERE id = ? AND status = 'PLANEJADA')" : ""}`)
    .bind(pernaId, jornada.id, numero, origem, destino, numeroPassageiros, horarioProgramado, horarioAc, horarioDep, horarioPouso, horarioCorte,
      horarioAc ? userId : null, horarioDep ? userId : null, horarioPouso ? userId : null, horarioCorte ? userId : null, status, ...(planejada ? [planejada.id] : []))
  const resultados = await db.batch(planejada ? [inserir, vincularPernaPlanejada(db, planejada.id, jornada.solicitacao_id, pernaId)] : [inserir])
  if (!resultados[0]?.meta?.changes) return c.json({ error: 'perna_planejada_ja_iniciada' }, 409)
  const pernas = await sincronizarResumoJornada(db, jornada.id)
  const statusAgendamento = await sincronizarStatusAgendamentoVoo(db, jornada.solicitacao_id)
  const diarioBordo = await sincronizarRascunhoSemPerderHorarios(db, pernaId, await getAuthenticatedUserId(c))
  if (horarioProgramado) {
    await db.prepare(`UPDATE solicitacoes_reserva_voo
      SET horario_previsto_agendamento = ?1, atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?2 AND (horario_previsto_agendamento IS NULL OR datetime(?1) > datetime(horario_previsto_agendamento))`)
      .bind(horarioProgramado, jornada.solicitacao_id).run()
  }
  return c.json({ diario_bordo: diarioBordo, id: pernaId, jornada_id: jornada.id, numero, origem, destino, numero_passageiros: numeroPassageiros, horario_programado: horarioProgramado, horario_ac: horarioAc, horario_dep: horarioDep, horario_pouso: horarioPouso, horario_corte: horarioCorte, status, status_agendamento: statusAgendamento, limites: await avaliarLimitesJornada(c, { ...jornada, pernas }) }, 201)
})

jornadasRoutes.patch('/api/interno/jornadas/:jornadaId/pernas/:pernaId', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaJornadas(c)
  const db = c.env.SHARE_DB
  const perna = await db.prepare('SELECT * FROM pernas_jornada_voo WHERE id = ?1 AND jornada_id = ?2').bind(c.req.param('pernaId'), c.req.param('jornadaId')).first<any>()
  if (!perna) return c.notFound()
  const jornadaAcesso = await db.prepare(`SELECT j.solicitacao_id, s.status AS status_agendamento
    FROM jornadas_voo j LEFT JOIN solicitacoes_reserva_voo s ON s.id = j.solicitacao_id
    WHERE j.id = ?1`).bind(perna.jornada_id).first<{ solicitacao_id: string; status_agendamento: string | null }>()
  if (!jornadaAcesso || !(await requireFlightOperationAccess(c, jornadaAcesso.solicitacao_id))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  if (!agendamentoPermiteCompletarHorarios(jornadaAcesso.status_agendamento, statusPerna(perna))) return c.json({ error: 'agendamento_fora_da_operacao', detail: 'Os horários da perna podem ser completados somente enquanto o agendamento estiver em voo ou em solo.' }, 409)
  if (perna.lancamento_diario_id) {
    const lancamento = await db.prepare('SELECT id, confirmado, assinado_pic FROM lancamentos_diario_bordo WHERE id = ?1')
      .bind(perna.lancamento_diario_id).first<{ id: string; confirmado: number; assinado_pic: string | null }>()
    if (!lancamento) return c.json({ error: 'diario_lancamento_inexistente' }, 409)
    if (Number(lancamento.confirmado) || lancamento.assinado_pic) {
      return c.json({ error: 'diario_ja_assinado', detail: 'Os horários desta perna já foram assinados pelo comandante.' }, 409)
    }
  }
  const jornada = await db.prepare('SELECT * FROM jornadas_voo WHERE id = ?1').bind(perna.jornada_id).first<any>()
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'payload_invalido' }, 400)
  const alias: Record<string, string> = { tempo_ac: 'horario_ac', tempo_dep: 'horario_dep', tempo_pou: 'horario_pouso', tempo_cor: 'horario_corte' }
  for (const [de, para] of Object.entries(alias)) if (body[de] !== undefined && body[para] === undefined) body[para] = body[de]
  const valores: Record<string, unknown> = {}
  if (body.origem !== undefined) valores.origem = String(body.origem).trim().toUpperCase()
  if (body.destino !== undefined) valores.destino = String(body.destino).trim().toUpperCase()
  if (body.numero_passageiros !== undefined) {
    const numeroPassageiros = normalizarNumeroPassageiros(body.numero_passageiros)
    if (numeroPassageiros === null) return c.json({ error: 'numero_passageiros_invalido' }, 400)
    valores.passageiros = numeroPassageiros
  }
  const encadeamento = ['horario_ac', 'horario_dep', 'horario_pouso', 'horario_corte'] as const
  let referencia: string | null = jornada?.horario_apresentacao || null
  for (const campo of encadeamento) {
    const atual = body[campo] !== undefined ? body[campo] : perna[campo]
    const iso = normalizarHorarioJornada(String(jornada?.data || ''), atual, referencia)
    if (body[campo] !== undefined) {
      if (atual && !iso) return c.json({ error: 'horario_invalido', campo }, 400)
      valores[campo] = iso
      valores[`${campo}_user_id`] = extractSupabaseUserId(c)
    }
    referencia = iso || referencia
  }
  valores.status = statusPerna({
    horario_ac: valores.horario_ac !== undefined ? valores.horario_ac as string | null : perna.horario_ac,
    horario_dep: valores.horario_dep !== undefined ? valores.horario_dep as string | null : perna.horario_dep,
    horario_pouso: valores.horario_pouso !== undefined ? valores.horario_pouso as string | null : perna.horario_pouso,
    horario_corte: valores.horario_corte !== undefined ? valores.horario_corte as string | null : perna.horario_corte,
  })
  const campos = Object.keys(valores)
  await db.prepare(`UPDATE pernas_jornada_voo SET ${campos.map((campo, i) => `${campo} = ?${i + 1}`).join(', ')} WHERE id = ?${campos.length + 1}`)
    .bind(...campos.map((campo) => valores[campo] ?? null), perna.id).run()
  if (Number(perna.numero) === 1 && valores.horario_dep !== undefined) {
    await db.prepare('UPDATE jornadas_voo SET horario_decolagem = ?1 WHERE COALESCE(jornada_principal_id, id) = ?2')
      .bind(valores.horario_dep ?? null, jornada?.jornada_principal_id || jornada?.id).run()
  }
  const pernas = await sincronizarResumoJornada(db, perna.jornada_id)
  const atualizada = await db.prepare('SELECT * FROM pernas_jornada_voo WHERE id = ?1').bind(perna.id).first<any>()
  const statusAgendamento = jornada ? await sincronizarStatusAgendamentoVoo(db, jornada.solicitacao_id) : undefined
  const diarioBordo = await sincronizarRascunhoSemPerderHorarios(db, perna.id, await getAuthenticatedUserId(c))
  return c.json({ diario_bordo: diarioBordo, ...normalizarPernaJornada(atualizada), status_agendamento: statusAgendamento, limites: jornada ? await avaliarLimitesJornada(c, { ...jornada, pernas }) : null })
})
