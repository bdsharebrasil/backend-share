-- Lançamentos têm direção em fluxo, natureza no tipo e ciclo de vida em status.
-- A atualização é idempotente e preserva o sentido econômico dos dados legados.
ALTER TABLE lancamentos ADD COLUMN natureza TEXT NOT NULL DEFAULT 'DESPESA'
  CHECK (natureza IN ('RECEITA', 'DESPESA', 'REEMBOLSO'));
UPDATE lancamentos
SET natureza = CASE
  WHEN UPPER(COALESCE(origem_tipo, '')) LIKE '%REEMBOLSO%' OR UPPER(COALESCE(fluxo, '')) = 'REEMBOLSO' THEN 'REEMBOLSO'
  WHEN UPPER(COALESCE(fluxo, '')) IN ('RECEITA', 'ENTRADA') THEN 'RECEITA'
  ELSE 'DESPESA'
END;
UPDATE lancamentos
SET fluxo = CASE
  WHEN UPPER(COALESCE(fluxo, '')) IN ('ENTRADA', 'RECEITA') THEN 'ENTRADA'
  ELSE 'SAIDA'
END;
UPDATE lancamentos
SET status = CASE UPPER(COALESCE(status, ''))
  WHEN 'PAGO_DIRETAMENTE' THEN 'PAGO'
  WHEN 'REEMBOLSADO' THEN CASE WHEN fluxo = 'ENTRADA' THEN 'RECEBIDO' ELSE 'PAGO' END
  WHEN 'RECEBIDO' THEN 'RECEBIDO'
  WHEN 'PAGO' THEN 'PAGO'
  WHEN 'CANCELADO' THEN 'CANCELADO'
  ELSE 'EM_ABERTO'
END;

-- SQLite não altera CHECK de uma tabela já criada sem reconstruí-la. Estes
-- triggers fecham a mesma fronteira no banco ativo sem quebrar FKs existentes.
CREATE TRIGGER IF NOT EXISTS trg_lancamentos_fluxo_canonico_insert
BEFORE INSERT ON lancamentos
WHEN NEW.fluxo NOT IN ('ENTRADA', 'SAIDA')
BEGIN SELECT RAISE(ABORT, 'lancamentos.fluxo_invalido'); END;
CREATE TRIGGER IF NOT EXISTS trg_lancamentos_fluxo_canonico_update
BEFORE UPDATE OF fluxo ON lancamentos
WHEN NEW.fluxo NOT IN ('ENTRADA', 'SAIDA')
BEGIN SELECT RAISE(ABORT, 'lancamentos.fluxo_invalido'); END;
CREATE TRIGGER IF NOT EXISTS trg_lancamentos_status_canonico_insert
BEFORE INSERT ON lancamentos
WHEN NEW.status NOT IN ('EM_ABERTO', 'PAGO', 'RECEBIDO', 'CANCELADO')
BEGIN SELECT RAISE(ABORT, 'lancamentos.status_invalido'); END;
CREATE TRIGGER IF NOT EXISTS trg_lancamentos_status_canonico_update
BEFORE UPDATE OF status ON lancamentos
WHEN NEW.status NOT IN ('EM_ABERTO', 'PAGO', 'RECEBIDO', 'CANCELADO')
BEGIN SELECT RAISE(ABORT, 'lancamentos.status_invalido'); END;
