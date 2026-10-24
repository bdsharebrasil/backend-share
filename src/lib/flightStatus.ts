export async function jornadaOperacionalDisponivel(db: D1Database): Promise<boolean> {
  const result = await db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('jornadas_voo', 'pernas_jornada_voo')
  `).all<{ name: string }>()
  const tabelas = new Set((result.results || []).map(({ name }) => name))
  return tabelas.has('jornadas_voo') && tabelas.has('pernas_jornada_voo')
}

export function statusAgendamentoComJornadaSql(jornadaDisponivel: boolean): string {
  const statusSolicitacao = "lower(trim(COALESCE(s.status, '')))"
  if (!jornadaDisponivel) return statusSolicitacao

  const statusDaJornadaMaisRecente = `(
    SELECT CASE
      WHEN (CASE WHEN p.id IS NOT NULL THEN p.horario_pouso ELSE j.horario_pouso END) IS NOT NULL
        OR (p.id IS NOT NULL AND p.status IN ('em_solo', 'pousado'))
        OR (p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) = 'pousado') THEN 'em_solo'
      WHEN (p.id IS NOT NULL AND (p.horario_dep IS NOT NULL OR p.status = 'em_voo'))
        OR (p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) IN ('decolado', 'em_rota', 'em voo', 'em_voo')) THEN 'decolado'
      WHEN (p.id IS NOT NULL AND (p.horario_ac IS NOT NULL OR p.status = 'acionado'))
        OR (p.id IS NULL AND j.horario_acionamento IS NOT NULL)
        OR (p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) = 'acionado') THEN 'acionado'
      WHEN p.id IS NULL AND lower(trim(COALESCE(j.status, ''))) = 'em_solo' THEN 'em_solo'
    END
    FROM jornadas_voo j
    LEFT JOIN pernas_jornada_voo p
      ON p.jornada_id = COALESCE(j.jornada_principal_id, j.id)
    WHERE j.solicitacao_id = s.id
    ORDER BY j.numero_jornada DESC, COALESCE(p.numero, 0) DESC, j.criado_em DESC, j.id DESC
    LIMIT 1
  )`

  return `CASE
    WHEN ${statusSolicitacao} IN ('pendente', 'reprovada', 'cancelada', 'encerrada', 'concluida')
      THEN ${statusSolicitacao}
    WHEN ${statusDaJornadaMaisRecente} IS NOT NULL
      THEN ${statusDaJornadaMaisRecente}
    WHEN ${statusSolicitacao} IN ('em_rota', 'em rota', 'em_voo', 'em voo')
      THEN 'decolado'
    ELSE ${statusSolicitacao}
  END`
}
