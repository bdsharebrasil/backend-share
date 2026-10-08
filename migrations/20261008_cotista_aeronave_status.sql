ALTER TABLE cotista_aeronave ADD COLUMN status TEXT NOT NULL DEFAULT 'ativo';

UPDATE cotista_aeronave
SET status = 'inativo'
WHERE cliente_id IN (SELECT id FROM cliente WHERE lower(COALESCE(status, 'ativo')) = 'inativo')
   OR socio_id IN (
     SELECT ca_socio.id
     FROM hold_socios ca_socio
     JOIN holdings h ON h.id = ca_socio.holding_id
     WHERE COALESCE(h.ativo, 1) = 0
   );

CREATE INDEX idx_cotista_aeronave_status ON cotista_aeronave(aeronave_id, status);
