-- O status EM_ATRASO é uma vista derivada do lançamento aberto e vencido.
-- A migração remove o estado persistido para que o schema nunca aceite novas
-- escritas com esse valor.
UPDATE lancamentos
SET status = 'EM_ABERTO'
WHERE status = 'EM_ATRASO';

CREATE INDEX IF NOT EXISTS idx_lancamentos_status_vencimento
ON lancamentos (status, data_vencimento);
