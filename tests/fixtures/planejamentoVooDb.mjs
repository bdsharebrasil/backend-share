import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { jornadasRoutes } from '../../src/routes/jornadasRoutes.ts'
import { pernasPlanejadasRoutes } from '../../src/routes/pernasPlanejadasRoutes.ts'
const jornadaId = 'defa1cf1-6043-4aa9-8245-9f6cf7def701'
const pernaId = '00b98947-8c1e-4077-b44f-d444fb39e962'
export async function planejamentoFixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, tipo_user TEXT, status TEXT, departamento TEXT, departamentos_email TEXT, canac TEXT);
    CREATE TABLE usuarios_funcoes (user_id TEXT, funcao TEXT);
    CREATE TABLE tripulacao (id TEXT, user_id TEXT, canac TEXT, nome_completo TEXT);
    CREATE TABLE tripulacao_freelancer (id TEXT, canac TEXT, nome_completo TEXT);
    CREATE TABLE aeronave (id TEXT, consumo_combustivel REAL);
    CREATE TABLE solicitacoes_reserva_voo (id TEXT PRIMARY KEY, status TEXT, piloto_id TEXT, copiloto_id TEXT, atualizado_em TEXT, aeronave_id TEXT, cliente_id TEXT, socio_id TEXT, numero_voo TEXT, origem TEXT, destino TEXT, numero_passageiros INTEGER, dias_duracao INTEGER, voo_emprestado TEXT DEFAULT 'nao', cliente_emprestimo_id TEXT, socio_emprestimo_id TEXT, aprovado_por TEXT, aprovado_em TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE jornadas_voo (id TEXT PRIMARY KEY, solicitacao_id TEXT, aeronave_id TEXT, data TEXT, horario_acionamento TEXT, horario_apresentacao TEXT NOT NULL, horario_decolagem TEXT, horario_pouso TEXT, horario_corte TEXT, tripulante_id TEXT, funcao_tripulante TEXT, jornada_principal_id TEXT, status TEXT, minutos_jornada INTEGER, minutos_pos_corte INTEGER, numero_jornada INTEGER, criado_em TEXT, atualizado_em TEXT);
    CREATE TABLE pernas_jornada_voo (id TEXT PRIMARY KEY, jornada_id TEXT, numero INTEGER, origem TEXT, destino TEXT, horario_programado TEXT, horario_ac TEXT, horario_dep TEXT, horario_pouso TEXT, horario_corte TEXT, horario_ac_user_id TEXT, horario_dep_user_id TEXT, horario_pouso_user_id TEXT, horario_corte_user_id TEXT, passageiros INTEGER, status TEXT, lancamento_diario_id TEXT);
    CREATE TABLE lancamentos_diario_bordo (id TEXT PRIMARY KEY, confirmado INTEGER, assinado_pic TEXT);
    INSERT INTO user_profiles VALUES ('gestor-teste', 'colaborador', 'ATIVO', NULL, NULL, NULL);
    INSERT INTO solicitacoes_reserva_voo (id, status, piloto_id, numero_voo) VALUES ('solicitacao-teste', 'decolado', 'outro-piloto', 'TST-001');
  `)
  sqlite.prepare('INSERT INTO usuarios_funcoes VALUES (?, ?)').run('gestor-teste', 'colaborador')
  sqlite.prepare(`INSERT INTO jornadas_voo (id, solicitacao_id, data, horario_acionamento, horario_apresentacao, status, minutos_pos_corte, numero_jornada)
    VALUES (?, 'solicitacao-teste', '2026-11-19', '2026-11-19T17:00:00.000Z', '2026-11-19T16:30:00.000Z', 'encerrada', 30, 1)`).run(jornadaId)
  sqlite.prepare(`INSERT INTO pernas_jornada_voo (id, jornada_id, numero, origem, destino, horario_ac, horario_dep, passageiros, status, lancamento_diario_id)
    VALUES (?, ?, 1, 'SBBH', 'SBGR', '2026-11-19T17:00:00.000Z', '2026-11-19T17:15:00.000Z', 3, 'em_voo', ?)`).run(pernaId, jornadaId, null)


  const wrap = (sql, params = []) => ({
    bind(...values) { return wrap(sql, values) },
    first: async () => sqlite.prepare(sql).get(...params) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...params).changes } }),
  })
  const env = {
    SUPABASE_URL: 'https://jornada-auth.example', SUPABASE_ANON_KEY: 'public-test-key',
    SHARE_DB: { prepare: wrap, batch: async statements => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    } },
  }
  sqlite.exec(`
    ALTER TABLE solicitacoes_reserva_voo ADD COLUMN excluida_em TEXT;
    ALTER TABLE solicitacoes_reserva_voo ADD COLUMN data_agendada TEXT;
    ALTER TABLE solicitacoes_reserva_voo ADD COLUMN horario_previsto_agendamento TEXT;
    ALTER TABLE jornadas_voo ADD COLUMN observacoes TEXT;
    ALTER TABLE jornadas_voo ADD COLUMN criado_por TEXT;
    CREATE TABLE checklists_pre_voo (solicitacao_id TEXT, status TEXT, criado_em TEXT);
    INSERT INTO checklists_pre_voo VALUES ('solicitacao-teste', 'concluido', CURRENT_TIMESTAMP);
    UPDATE solicitacoes_reserva_voo SET status = 'em_solo', aeronave_id = 'a1', piloto_id = 'p1', copiloto_id = 'p2', data_agendada = '2026-11-19';
    INSERT INTO tripulacao VALUES ('p1', 'piloto1', '123', 'Piloto Um');
    INSERT INTO tripulacao VALUES ('p2', 'piloto2', '456', 'Piloto Dois');
    UPDATE jornadas_voo SET tripulante_id = 'p1', funcao_tripulante = 'PIC', horario_pouso = '2026-11-19T18:37:00Z', horario_corte = '2026-11-19T18:40:00Z', minutos_jornada = 160;
    UPDATE pernas_jornada_voo SET horario_pouso = '2026-11-19T18:37:00Z', horario_corte = '2026-11-19T18:40:00Z', status = 'cortado';
    CREATE TRIGGER validar_estado_jornada BEFORE INSERT ON jornadas_voo WHEN NEW.status NOT IN ('em_solo', 'em_rota', 'pousado', 'encerrada') BEGIN SELECT RAISE(ABORT, 'status_jornada_invalido'); END;
  `)
  sqlite.exec(await readFile(new URL('../../migrations/20261124_agendamento_solicitacao_origem.sql', import.meta.url), 'utf8'))
  const app = new Hono()
  app.route('/', pernasPlanejadasRoutes)
  app.route('/', jornadasRoutes)
  app.onError((error, c) => c.json({ error: 'teste_erro_interno', detail: error.message }, 500))
  const token = `test.${Buffer.from(JSON.stringify({ sub: 'gestor-teste' })).toString('base64url')}.signature`
  const request = (method, path, body) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env)
  return { sqlite, request, db: env.SHARE_DB }
}
