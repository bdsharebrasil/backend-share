-- Campos necessários para converter um envio preservando as FKs de categoria e favorecido.
ALTER TABLE envio_despesas ADD COLUMN categoria_cliente_id TEXT;
ALTER TABLE envio_despesas ADD COLUMN colaborador_id TEXT;
ALTER TABLE envio_despesas ADD COLUMN abastecimento_json TEXT;
ALTER TABLE envio_despesas ADD COLUMN solicitacao_compra_id TEXT;
ALTER TABLE movimentos_holding ADD COLUMN idempotency_key TEXT;
-- criado_em já existe em instalações atuais; a conversão passa a preenchê-lo explicitamente.
