-- Schema versionado para checklists associados a planos de voo.
-- Aplicar antes do deploy que usa as rotas /api/interno/planos-voo/:id/checklist.
CREATE TABLE IF NOT EXISTS checklists_planos_voo (
  id TEXT PRIMARY KEY NOT NULL,
  plano_voo_id TEXT NOT NULL UNIQUE,
  itens_json TEXT NOT NULL DEFAULT '{}',
  observacoes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho',
  executado_por TEXT NULL,
  executado_por_nome TEXT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  concluido_em TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_checklists_planos_voo_plano
  ON checklists_planos_voo (plano_voo_id);
