-- Evolução aditiva: mantém leads_quiz e eventos_quiz anteriores sem alteração.
-- Participações sem contato são anônimas; contato autorizado pode ser parcial.
-- Novas tabelas isoladas: não altera nenhum cadastro financeiro ou operacional.
CREATE TABLE IF NOT EXISTS quiz_participacoes (
  id TEXT PRIMARY KEY NOT NULL,
  protocolo TEXT NOT NULL UNIQUE,
  chave_reenvio TEXT NOT NULL UNIQUE,
  resumo_envio TEXT NOT NULL,
  nome TEXT CHECK(nome IS NULL OR length(nome) BETWEEN 2 AND 100),
  telefone TEXT,
  cidade TEXT,
  rotas TEXT,
  momento TEXT NOT NULL CHECK(momento IN ('EXPLORANDO','ATE_3_MESES','ATE_6_MESES','ESTE_ANO')),
  respostas_json TEXT NOT NULL CHECK(json_valid(respostas_json)),
  resultado_json TEXT NOT NULL CHECK(json_valid(resultado_json)),
  aeronave_sugerida TEXT CHECK(aeronave_sugerida IN ('cirrus','matrix','seneca','meridian','cheyenne','citation','hawker400a')),
  aeronave_alternativa TEXT CHECK(aeronave_alternativa IN ('cirrus','matrix','seneca','meridian','cheyenne','citation','hawker400a')),
  versao_quiz TEXT NOT NULL,
  origem_json TEXT NOT NULL CHECK(json_valid(origem_json)),
  duracao_segundos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'NOVO' CHECK(status IN ('NOVO','EM_CONTATO','QUALIFICADO','CONVERTIDO','SEM_INTERESSE')),
  consentimento INTEGER NOT NULL CHECK(consentimento IN (0,1)),
  versao_consentimento TEXT NOT NULL,
  consentimento_em TEXT,
  token_evento_hash TEXT NOT NULL,
  whatsapp_clicado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quiz_participacoes_criado ON quiz_participacoes(criado_em);
CREATE INDEX IF NOT EXISTS idx_quiz_participacoes_status ON quiz_participacoes(status,criado_em);
CREATE INDEX IF NOT EXISTS idx_quiz_participacoes_aeronave ON quiz_participacoes(aeronave_sugerida,criado_em);
CREATE INDEX IF NOT EXISTS idx_quiz_participacoes_telefone ON quiz_participacoes(telefone);

CREATE TABLE IF NOT EXISTS quiz_eventos (
  id TEXT PRIMARY KEY NOT NULL,
  lead_id TEXT NOT NULL REFERENCES quiz_participacoes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK(tipo IN ('PERFIL_SALVO','WHATSAPP_CLICADO')),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(lead_id,tipo)
);
CREATE INDEX IF NOT EXISTS idx_quiz_eventos_lead ON quiz_eventos(lead_id);

-- Contador temporário com hash do endereço; nenhum IP bruto é persistido.
CREATE TABLE IF NOT EXISTS limites_quiz (
  chave TEXT PRIMARY KEY NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1,
  expira_em INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_limites_quiz_expira ON limites_quiz(expira_em);
