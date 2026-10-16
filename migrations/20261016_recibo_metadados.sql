-- Metadados de categoria selecionados na emissão do recibo.
-- Eles são reutilizados ao materializar o rateio posteriormente.
ALTER TABLE recibos ADD COLUMN subcategoria_1 TEXT;
ALTER TABLE recibos ADD COLUMN subcategoria_2 TEXT;
ALTER TABLE recibos ADD COLUMN subcategoria_3 TEXT;
ALTER TABLE recibos ADD COLUMN subcategoria_4 TEXT;
