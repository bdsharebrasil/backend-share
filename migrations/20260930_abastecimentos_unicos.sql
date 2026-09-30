-- Índices de consulta e triggers idempotentes.
-- Triggers, em vez de índices UNIQUE, preservam bases que já possuem histórico duplicado.
CREATE INDEX IF NOT EXISTS idx_abastecimentos_aeronave_numero_voo
  ON abastecimentos (aeronave_id, numero_voo);
CREATE INDEX IF NOT EXISTS idx_abastecimentos_lancamento_diario
  ON abastecimentos (lancamento_diario_id);

CREATE TRIGGER IF NOT EXISTS trg_abastecimentos_numero_voo_unico_insert
BEFORE INSERT ON abastecimentos
WHEN NEW.numero_voo IS NOT NULL AND trim(NEW.numero_voo) <> ''
  AND EXISTS (SELECT 1 FROM abastecimentos WHERE aeronave_id = NEW.aeronave_id AND lower(trim(numero_voo)) = lower(trim(NEW.numero_voo)))
BEGIN
  SELECT RAISE(ABORT, 'abastecimento_duplicado');
END;

CREATE TRIGGER IF NOT EXISTS trg_abastecimentos_numero_voo_unico_update
BEFORE UPDATE OF aeronave_id, numero_voo ON abastecimentos
WHEN NEW.numero_voo IS NOT NULL AND trim(NEW.numero_voo) <> ''
  AND EXISTS (SELECT 1 FROM abastecimentos WHERE id <> NEW.id AND aeronave_id = NEW.aeronave_id AND lower(trim(numero_voo)) = lower(trim(NEW.numero_voo)))
BEGIN
  SELECT RAISE(ABORT, 'abastecimento_duplicado');
END;

CREATE TRIGGER IF NOT EXISTS trg_abastecimentos_diario_unico_insert
BEFORE INSERT ON abastecimentos
WHEN NEW.lancamento_diario_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM abastecimentos WHERE lancamento_diario_id = NEW.lancamento_diario_id)
BEGIN
  SELECT RAISE(ABORT, 'abastecimento_duplicado');
END;

CREATE TRIGGER IF NOT EXISTS trg_abastecimentos_diario_unico_update
BEFORE UPDATE OF lancamento_diario_id ON abastecimentos
WHEN NEW.lancamento_diario_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM abastecimentos WHERE id <> NEW.id AND lancamento_diario_id = NEW.lancamento_diario_id)
BEGIN
  SELECT RAISE(ABORT, 'abastecimento_duplicado');
END;
