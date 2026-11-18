-- Migração aditiva: preserva checklists, reservas e abastecimentos existentes.
CREATE TABLE IF NOT EXISTS preparacoes_voo (
  solicitacao_id TEXT PRIMARY KEY NOT NULL REFERENCES solicitacoes_reserva_voo(id),
  versao INTEGER NOT NULL DEFAULT 1,
  comando_id TEXT NOT NULL,
  dados_json TEXT NOT NULL,
  finalizado_em TEXT,
  atualizado_por TEXT NOT NULL,
  atualizado_por_nome TEXT NOT NULL,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS preparacao_voo_versoes (
  id TEXT PRIMARY KEY NOT NULL,
  solicitacao_id TEXT NOT NULL REFERENCES solicitacoes_reserva_voo(id),
  versao INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  criado_por TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(solicitacao_id, versao)
);
CREATE TABLE IF NOT EXISTS preparacao_voo_reservas (
  id TEXT PRIMARY KEY NOT NULL,
  solicitacao_id TEXT NOT NULL,
  escala_id TEXT NOT NULL,
  servico_id TEXT NOT NULL,
  requisicao_id TEXT NOT NULL UNIQUE,
  assinatura TEXT NOT NULL,
  reserva_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  erro TEXT,
  criado_por TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enviado_em TEXT,
  UNIQUE(solicitacao_id,servico_id,assinatura)
);
CREATE INDEX IF NOT EXISTS idx_preparacao_reservas_voo ON preparacao_voo_reservas(solicitacao_id, escala_id, servico_id);
CREATE TABLE IF NOT EXISTS preparacao_voo_abastecimentos (
  id TEXT PRIMARY KEY NOT NULL,
  solicitacao_id TEXT NOT NULL,
  escala_id TEXT NOT NULL,
  abastecimento_id TEXT NOT NULL UNIQUE,
  criado_por TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(solicitacao_id, escala_id)
);
CREATE TABLE IF NOT EXISTS preparacao_voo_anexos (
  id TEXT PRIMARY KEY NOT NULL,
  solicitacao_id TEXT NOT NULL,
  servico_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  caminho TEXT NOT NULL,
  mime TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  criado_por TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_preparacao_anexos_voo ON preparacao_voo_anexos(solicitacao_id);
