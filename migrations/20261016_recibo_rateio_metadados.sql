-- Metadados necessários para recibos materializados em rateio_hold.
ALTER TABLE rateio_hold ADD COLUMN fornecedor_id TEXT;
ALTER TABLE rateio_hold ADD COLUMN numero_recibo TEXT;
ALTER TABLE rateio_hold ADD COLUMN url_recibo TEXT;
