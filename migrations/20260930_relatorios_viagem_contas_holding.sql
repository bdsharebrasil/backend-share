-- Permite que contas a pagar do caixa Holding sejam liquidadas pelo movimento
-- Holding correspondente, sem criar um lançamento Share artificial.
ALTER TABLE contas_apagar ADD COLUMN movimentos_id TEXT REFERENCES movimentos_holding(id);
