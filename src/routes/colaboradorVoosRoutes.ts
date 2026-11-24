import { hospedagensDoVoo } from '../preparacao/hospedagens'
import { Hono } from 'hono'
import { authenticatedColaborador } from '../lib/auth'
import { jornadaOperacionalDisponivel, statusAgendamentoComJornadaSql } from '../lib/flightStatus'

type Bindings = { SHARE_DB: D1Database }
type Variables = Record<string, never>

export const colaboradorVoosRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

async function tripulanteDoUsuario(c: Parameters<typeof authenticatedColaborador>[0], userId: string, canac: string | null) {
  return c.env.SHARE_DB.prepare(`
    SELECT id, nome_completo, canac
    FROM tripulacao
    WHERE user_id = ?1 OR (user_id IS NULL AND NULLIF(trim(?2), '') IS NOT NULL AND lower(trim(canac)) = lower(trim(?2)))
    ORDER BY CASE WHEN user_id = ?1 THEN 0 ELSE 1 END
    LIMIT 1
  `).bind(userId, canac).first<{ id: string; nome_completo: string; canac: string | null }>()
}

const VOOS_COLABORADOR_SQL = `
  SELECT s.id, s.numero_voo, __STATUS_OPERACIONAL__ AS status, s.aeronave_id, s.origem, s.destino,
    s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros,
    s.piloto_id, s.copiloto_id, a.matricula_registro, a.modelo
  FROM solicitacoes_reserva_voo s
  LEFT JOIN aeronave a ON a.id = s.aeronave_id
  WHERE (s.piloto_id = ?1 OR s.copiloto_id = ?1)
    AND s.solicitacao_origem_id IS NULL
    AND lower(trim(COALESCE(s.status, ''))) IN ('aprovada', 'acionado', 'decolado', 'em_voo', 'em voo', 'em_rota', 'em rota', 'em_solo', 'pousado', 'encerrada', 'concluida')
  ORDER BY date(s.data_agendada) DESC, s.horario_previsto_agendamento DESC, s.criado_em DESC
`

colaboradorVoosRoutes.get('/api/colaborador/meus-voos', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const tripulante = await tripulanteDoUsuario(c, user.id, user.canac)
  if (!tripulante) return c.json({ tripulante: null, voos: [] })
  const statusSql = statusAgendamentoComJornadaSql(await jornadaOperacionalDisponivel(c.env.SHARE_DB))
  const result = await c.env.SHARE_DB.prepare(VOOS_COLABORADOR_SQL.replace('__STATUS_OPERACIONAL__', statusSql)).bind(tripulante.id).all()
  return c.json({ tripulante, voos: result.results || [] })
})

colaboradorVoosRoutes.get('/api/colaborador/meus-voos/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const tripulante = await tripulanteDoUsuario(c, user.id, user.canac)
  if (!tripulante) return c.notFound()

  const db = c.env.SHARE_DB
  const statusSql = statusAgendamentoComJornadaSql(await jornadaOperacionalDisponivel(db))
  const voo = await db.prepare(`
    SELECT s.*, ${statusSql} AS status_operacional, date(s.data_agendada, '+' || (MAX(COALESCE(s.dias_duracao, 1), 1) - 1) || ' days') AS data_fim,
      a.matricula_registro, a.modelo, a.fabricante,
      CASE WHEN NULLIF(trim(s.socio_id), '') IS NOT NULL THEN 'Cotista' ELSE 'Cliente' END AS cliente_tipo,
      CASE WHEN NULLIF(trim(s.socio_id), '') IS NOT NULL
        THEN COALESCE(NULLIF(trim(hs.nome), ''), NULLIF(trim(c.razao_social), ''), NULLIF(trim(h.nome), ''))
        ELSE COALESCE(NULLIF(trim(c.razao_social), ''), NULLIF(trim(h.nome), ''), NULLIF(trim(hs.nome), ''))
      END AS cliente_razao_social,
      COALESCE(p.nome_completo, pf.nome_completo) AS piloto_nome,
      COALESCE(cp.nome_completo, cpf.nome_completo) AS copiloto_nome
    FROM solicitacoes_reserva_voo s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id
    LEFT JOIN cliente c ON c.id = s.cliente_id
    LEFT JOIN holdings h ON h.id = s.cliente_id
    LEFT JOIN hold_socios hs ON hs.id = s.socio_id
    LEFT JOIN tripulacao p ON p.id = s.piloto_id
    LEFT JOIN tripulacao_freelancer pf ON pf.id = s.piloto_id
    LEFT JOIN tripulacao cp ON cp.id = s.copiloto_id
    LEFT JOIN tripulacao_freelancer cpf ON cpf.id = s.copiloto_id
    WHERE s.id = ?1 AND (s.piloto_id = ?2 OR s.copiloto_id = ?2)
      AND lower(trim(COALESCE(s.status, ''))) IN ('aprovada', 'acionado', 'decolado', 'em_voo', 'em voo', 'em_rota', 'em rota', 'em_solo', 'pousado', 'encerrada', 'concluida')
    LIMIT 1
  `).bind(c.req.param('id'), tripulante.id).first<Record<string, any>>()
  if (!voo) return c.notFound()
  voo.status = voo.status_operacional || voo.status
  delete voo.status_operacional

  const [jornadas, hospedagens] = await Promise.all([
    db.prepare(`
      SELECT j.id, j.solicitacao_id, j.aeronave_id, j.tripulante_id, j.funcao_tripulante,
        j.jornada_principal_id, j.numero_jornada, j.data, j.horario_apresentacao,
        j.horario_acionamento, j.horario_decolagem, j.horario_pouso, j.horario_corte, j.minutos_pos_corte,
        j.minutos_jornada, j.nivel_alerta, j.status, j.observacoes,
        COALESCE(t.nome_completo, f.nome_completo) AS tripulante_nome
      FROM jornadas_voo j
      LEFT JOIN tripulacao t ON t.id = j.tripulante_id
      LEFT JOIN tripulacao_freelancer f ON f.id = j.tripulante_id
      WHERE j.solicitacao_id = ?1
      ORDER BY date(j.data), j.numero_jornada, j.funcao_tripulante
    `).bind(voo.id).all<Record<string, any>>(),
    hospedagensDoVoo(db,voo as {id:string;data_agendada:string;data_fim:string},user.id),
  ])

  const jornadasComPernas = await Promise.all((jornadas.results || []).map(async jornada => {
    const pernas = await db.prepare(`
      SELECT p.id, p.jornada_id, p.numero, p.origem, p.destino, p.passageiros AS numero_passageiros,
        p.horario_ac, p.horario_dep, p.horario_pouso, p.horario_corte, p.status, p.lancamento_diario_id,
        COALESCE(l.confirmado, 0) AS diario_confirmado,
        l.assinado_pic AS diario_assinado_pic, COALESCE(dm.fechado, 0) AS diario_fechado
      FROM pernas_jornada_voo p
      LEFT JOIN lancamentos_diario_bordo l ON l.id = p.lancamento_diario_id
      LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id
      WHERE p.jornada_id = ?1
      ORDER BY p.numero
    `).bind(jornada.id).all()
    return { ...jornada, pernas: pernas.results || [] }
  }))

  const { observacoes, ...vooSemObservacoes } = voo
  return c.json({
    voo: { ...vooSemObservacoes, mensagem: observacoes ?? null },
    jornadas: jornadasComPernas,
    hospedagens: hospedagens.results || [],
  })
})

