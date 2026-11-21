-- Assinatura eletrônica atribuída ao usuário autenticado (piloto comandante).
-- O status legado permanece em confirmado=0/1, assinado_pic e data_assinatura.
-- Não altera/assina lançamentos existentes e não exige migração de dados.
ALTER TABLE lancamentos_diario_bordo ADD COLUMN assinado_pic_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_diario_assinado_pic_user_id ON lancamentos_diario_bordo(assinado_pic_user_id);
