-- Mantém um único lançamento por usuário e dia, independentemente de cliques
-- concorrentes. O rowid preserva o primeiro registro inserido e mantém também
-- os dias que já não possuem duplicatas.
DELETE FROM lancamento_ponto
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM lancamento_ponto
  GROUP BY user_id, data_entrada
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lancamento_ponto_user_data
  ON lancamento_ponto (user_id, data_entrada);
