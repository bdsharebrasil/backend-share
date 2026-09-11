-- Backfill dos recibos de saída já enviados.
-- O relacionamento por numero_recibo atualiza SHARE e CLIENTE quando ambos
-- compartilham o mesmo recibo, sem filtrar por tipo_caixa.
-- O índice torna emails_enviados.id uma chave candidata válida para as FKs
-- existentes em lancamentos e movimentos_holding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_enviados_id_unique
  ON emails_enviados(id);

WITH alvos AS (
  SELECT
    e.id AS email_id,
    e.criado_em AS email_criado_em,
    substr(je.value, instr(je.value, ':') + 1) AS recibo_saida_id
  FROM emails_enviados e, json_each(e.anexos) je
  WHERE e.status = 'enviado'
    AND je.value LIKE 'recibo_saida:%'
)
UPDATE lancamentos
SET
  email_enviado_em = COALESCE(email_enviado_em, alvos.email_criado_em),
  email_enviado_id = COALESCE(email_enviado_id, alvos.email_id)
FROM alvos
JOIN recibos_saida rs ON rs.id = alvos.recibo_saida_id
WHERE lancamentos.numero_recibo = rs.numero_recibo
  AND lancamentos.origem_tipo = 'RECIBO_SAIDA';
