-- Corrige jornadas gravadas com a regra antiga, que somava cada perna separadamente.
-- Regra atual: apresentação até o corte/pouso da última perna + pós-corte.
UPDATE jornadas_voo
SET minutos_jornada = (
  SELECT ROUND(
    (
      julianday(COALESCE(
        (SELECT p.horario_corte
           FROM pernas_jornada_voo p
          WHERE p.jornada_id = jornadas_voo.id
          ORDER BY p.numero DESC
          LIMIT 1),
        (SELECT p.horario_pouso
           FROM pernas_jornada_voo p
          WHERE p.jornada_id = jornadas_voo.id
          ORDER BY p.numero DESC
          LIMIT 1)
      )) - julianday(COALESCE(
        jornadas_voo.horario_apresentacao,
        (SELECT p.horario_ac
           FROM pernas_jornada_voo p
          WHERE p.jornada_id = jornadas_voo.id
          ORDER BY p.numero
          LIMIT 1)
      ))
    ) * 1440
  ) + COALESCE(jornadas_voo.minutos_pos_corte, 45)
)
WHERE EXISTS (
  SELECT 1
    FROM pernas_jornada_voo p
   WHERE p.jornada_id = jornadas_voo.id
);
