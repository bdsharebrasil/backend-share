-- A periodicidade pertence aos lançamentos/rateios financeiros, nunca ao relatório.
-- Remove a coluna adicionada acidentalmente pela migration 0007 em bancos já migrados.
ALTER TABLE relatorio_despesa_viagem DROP COLUMN periodicidade_reembolso;
