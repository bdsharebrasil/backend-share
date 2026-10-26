ALTER TABLE recibos RENAME COLUMN numero_voo TO numero_voo_id;
ALTER TABLE recibos ADD COLUMN numero_voo TEXT;
UPDATE recibos
   SET numero_voo = (
     SELECT s.numero_voo
       FROM solicitacoes_reserva_voo s
      WHERE s.id = recibos.numero_voo_id
   )
 WHERE numero_voo_id IS NOT NULL;
ALTER TABLE recibos DROP COLUMN numero_voo_id;