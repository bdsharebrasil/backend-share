-- Mantém um único lançamento por usuário e dia, independentemente de cliques
-- concorrentes. As duplicatas legadas são removidas preservando o primeiro
-- lançamento por ordem de criação.
DELETE FROM lancamento_ponto
WHERE id NOT IN (
  SELECT MIN(id)
  FROM lancamento_ponto
  GROUP BY user_id, data_entrada
  HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lancamento_ponto_user_data
  ON lancamento_ponto (user_id, data_entrada);
