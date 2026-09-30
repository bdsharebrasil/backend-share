-- lancamentos ainda possui uma FK histórica para `clientes`, enquanto a tabela
-- canônica do domínio é `cliente`. A migration 20260929_relatorios_viagem_holding
-- criou essa tabela apenas temporariamente e a removeu, bloqueando novos INSERTs.
-- Mantemos uma tabela de compatibilidade somente com os IDs para preservar a FK
-- existente sem reescrever a tabela lancamentos em produção.
CREATE TABLE IF NOT EXISTS clientes (id TEXT PRIMARY KEY);

INSERT OR IGNORE INTO clientes (id)
SELECT id FROM cliente;
