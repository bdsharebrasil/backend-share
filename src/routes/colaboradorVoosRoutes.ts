import { Hono } from 'hono'
import { authenticatedColaborador } from '../lib/auth'

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
  SELECT s.id, s.numero_voo, s.status, s.aeronave_id, s.origem, s.destino,
    s.data_agendada, s.horario_previsto_agendamento, s.dias_duracao, s.numero_passageiros,
    s.piloto_id, s.copiloto_id, a.matricula_registro, a.modelo
  FROM solicitacoes_reserva_voo s
  LEFT JOIN aeronave a ON a.id = s.aeronave_id
  WHERE (s.piloto_id = ?1 OR s.copiloto_id = ?1)
    AND lower(trim(COALESCE(s.status, ''))) IN ('aprovada', 'encerrada', 'concluida')
  ORDER BY date(s.data_agendada) DESC, s.horario_previsto_agendamento DESC, s.criado_em DESC
`

colaboradorVoosRoutes.get('/api/colaborador/meus-voos', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const tripulante = await tripulanteDoUsuario(c, user.id, user.canac)
  if (!tripulante) return c.json({ tripulante: null, voos: [] })
  const result = await c.env.SHARE_DB.prepare(VOOS_COLABORADOR_SQL).bind(tripulante.id).all()
  return c.json({ tripulante, voos: result.results || [] })
})

colaboradorVoosRoutes.get('/api/colaborador/meus-voos/:id', async c => {
  const user = await authenticatedColaborador(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const tripulante = await tripulanteDoUsuario(c, user.id, user.canac)
  if (!tripulante) return c.notFound()

  const db = c.env.SHARE_DB
  const voo = await db.prepare(`
    SELECT s.*, date(s.data_agendada, '+' || (MAX(COALESCE(s.dias_duracao, 1), 1) - 1) || ' days') AS data_fim,
      a.matricula_registro, a.modelo, a.fabricante,
      c.razao_social AS cliente_razao_social, hs.nome AS socio_nome,
      COALESCE(p.nome_completo, pf.nome_completo) AS piloto_nome,
      COALESCE(cp.nome_completo, cpf.nome_completo) AS copiloto_nome
    FROM solicitacoes_reserva_voo s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id
    LEFT JOIN cliente c ON c.id = s.cliente_id
    LEFT JOIN hold_socios hs ON hs.id = s.socio_id
    LEFT JOIN tripulacao p ON p.id = s.piloto_id
    LEFT JOIN tripulacao_freelancer pf ON pf.id = s.piloto_id
    LEFT JOIN tripulacao cp ON cp.id = s.copiloto_id
    LEFT JOIN tripulacao_freelancer cpf ON cpf.id = s.copiloto_id
    WHERE s.id = ?1 AND (s.piloto_id = ?2 OR s.copiloto_id = ?2)
      AND lower(trim(COALESCE(s.status, ''))) IN ('aprovada', 'encerrada', 'concluida')
    LIMIT 1
  `).bind(c.req.param('id'), tripulante.id).first<Record<string, any>>()
  if (!voo) return c.notFound()

  const [jornadas, hospedagens, mensagens] = await Promise.all([
    db.prepare(`
      SELECT j.id, j.solicitacao_id, j.aeronave_id, j.tripulante_id, j.funcao_tripulante,
        j.jornada_principal_id, j.numero_jornada, j.data, j.horario_apresentacao,
        j.horario_acionamento, j.horario_pouso, j.horario_corte, j.minutos_pos_corte,
        j.minutos_jornada, j.nivel_alerta, j.status, j.observacoes,
        COALESCE(t.nome_completo, f.nome_completo) AS tripulante_nome
      FROM jornadas_voo j
      LEFT JOIN tripulacao t ON t.id = j.tripulante_id
      LEFT JOIN tripulacao_freelancer f ON f.id = j.tripulante_id
      WHERE j.solicitacao_id = ?1
      ORDER BY date(j.data), j.numero_jornada, j.funcao_tripulante
    `).bind(voo.id).all<Record<string, any>>(),
    db.prepare(`
      SELECT r.id, r.hotel_id, r.data_checkin, r.data_checkout, r.tipo_quarto,
        r.quantidade_hospedes, r.hospede_nome, r.observacoes,
        h.nome AS hotel_nome, h.endereco AS hotel_endereco, h.cidade AS hotel_cidade, h.uf AS hotel_uf
      FROM reservas_hoteis r
      LEFT JOIN hoteis h ON h.id = r.hotel_id
      WHERE r.criado_por = ?1
        AND date(r.data_checkin) <= date(?3)
        AND date(r.data_checkout) >= date(?2)
      ORDER BY date(r.data_checkin), r.criado_em
    `).bind(user.id, voo.data_agendada, voo.data_fim).all<Record<string, any>>().catch(() => ({ results: [] })),
    db.prepare(`
      SELECT m.id, m.assunto, m.conteudo, m.criado_em, COALESCE(mu.lida, 0) AS lida
      FROM mensagens m
      LEFT JOIN mensagens_usuario mu ON mu.mensagem_id = m.id AND mu.usuario_id = ?1 AND mu.papel = 'destinatario'
      WHERE m.destinatario_id = ?1 AND COALESCE(mu.excluida, 0) = 0
        AND (
          (NULLIF(?3, '') IS NOT NULL AND instr(lower(COALESCE(m.assunto, '') || ' ' || COALESCE(m.conteudo, '')), lower(?3)) > 0)
          OR instr(lower(COALESCE(m.assunto, '') || ' ' || COALESCE(m.conteudo, '')), lower(?2)) > 0
        )
      ORDER BY datetime(m.criado_em) DESC
      LIMIT 50
    `).bind(user.id, voo.id, String(voo.numero_voo || '')).all<Record<string, any>>().catch(() => ({ results: [] })),
  ])

  const jornadasComPernas = await Promise.all((jornadas.results || []).map(async jornada => {
    const pernas = await db.prepare(`
      SELECT id, jornada_id, numero, origem, destino, passageiros AS numero_passageiros,
        horario_ac, horario_dep, horario_pouso, horario_corte, status, lancamento_diario_id
      FROM pernas_jornada_voo
      WHERE jornada_id = ?1
      ORDER BY numero
    `).bind(jornada.id).all()
    return { ...jornada, pernas: pernas.results || [] }
  }))

  return c.json({
    voo,
    jornadas: jornadasComPernas,
    hospedagens: hospedagens.results || [],
    mensagens: mensagens.results || [],
  })
})
