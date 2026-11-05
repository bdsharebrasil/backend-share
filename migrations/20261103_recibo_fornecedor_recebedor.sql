-- Metadados do recebedor informados na emissão do recibo.
ALTER TABLE recibos ADD COLUMN recebedor_cpf TEXT;
ALTER TABLE recibos ADD COLUMN recebedor_endereco TEXT;
ALTER TABLE recibos ADD COLUMN recebedor_cidade TEXT;
ALTER TABLE recibos ADD COLUMN recebedor_uf TEXT;
