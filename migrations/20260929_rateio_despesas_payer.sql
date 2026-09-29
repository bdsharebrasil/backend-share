-- Mantém a compatibilidade dos bancos já provisionados com o schema atualizado.
ALTER TABLE rateio_despesas ADD COLUMN pago_por TEXT;
