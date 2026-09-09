ALTER TABLE rateio_pagamentos ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rateio_pagamentos_idempotency ON rateio_pagamentos(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rateio_pagamentos_rateio_confirmado ON rateio_pagamentos(rateio_id, status);

CREATE TRIGGER IF NOT EXISTS trg_rateio_pagamentos_ai_recalcula
AFTER INSERT ON rateio_pagamentos
BEGIN
  UPDATE rateio_despesas
     SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = NEW.rateio_id AND status = 'CONFIRMADO'),
         atualizado_em = CURRENT_TIMESTAMP
   WHERE id = NEW.rateio_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_rateio_pagamentos_au_recalcula
AFTER UPDATE OF valor_centavos, status, rateio_id ON rateio_pagamentos
BEGIN
  UPDATE rateio_despesas
     SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = NEW.rateio_id AND status = 'CONFIRMADO'),
         atualizado_em = CURRENT_TIMESTAMP
   WHERE id = NEW.rateio_id;
  UPDATE rateio_despesas
     SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = OLD.rateio_id AND status = 'CONFIRMADO'),
         atualizado_em = CURRENT_TIMESTAMP
   WHERE id = OLD.rateio_id AND OLD.rateio_id <> NEW.rateio_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_rateio_pagamentos_ad_recalcula
AFTER DELETE ON rateio_pagamentos
BEGIN
  UPDATE rateio_despesas
     SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = OLD.rateio_id AND status = 'CONFIRMADO'),
         atualizado_em = CURRENT_TIMESTAMP
   WHERE id = OLD.rateio_id;
END;
