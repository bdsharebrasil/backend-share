ALTER TABLE lancamentos ADD COLUMN status_anterior TEXT;
ALTER TABLE movimentos_holding ADD COLUMN status_anterior TEXT;
ALTER TABLE rateio_despesas ADD COLUMN status_anterior TEXT;
ALTER TABLE rateio_hold ADD COLUMN status_anterior TEXT;
ALTER TABLE contas_apagar ADD COLUMN status_anterior TEXT;
ALTER TABLE contas_areceber ADD COLUMN status_anterior TEXT;
ALTER TABLE reembolsos ADD COLUMN status_anterior TEXT;
