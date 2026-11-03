-- Metadados do fornecedor/recebedor escolhidos na emissão do recibo.
-- Permite reaproveitar a seleção no lançamento e no rateio sem depender de texto livre.
ALTER TABLE recibos ADD COLUMN recebedor_cpf TEXT;
ALTER TABLE recibos ADD COLUMN recebedor_endereco TEXT;
ALTER TABLE recibos ADD COLUMN recebedor_cidade TEXT;
ALTER TABLE recibos ADD COLUMN recebedor_uf TEXT;
ALTER TABLE recibos ADD COLUMN fornecedor_id TEXT;
ALTER TABLE recibos ADD COLUMN fornecedor_nome TEXT;
