-- Alinha jornadas_voo ao contrato operacional de pernas_jornada_voo.
-- O banco legado possuía horario_corte_inicio/horario_corte_final.
ALTER TABLE jornadas_voo RENAME COLUMN horario_corte_inicio TO horario_pouso;
ALTER TABLE jornadas_voo RENAME COLUMN horario_corte_final TO horario_corte;

-- A fonte de verdade operacional é a última perna da jornada.
-- Isso corrige registros antigos que tinham os valores de corte gravados na jornada.
UPDATE jornadas_voo
SET horario_pouso = (
  SELECT p.horario_pouso
  FROM pernas_jornada_voo p
  WHERE p.jornada_id = jornadas_voo.id
    AND p.horario_pouso IS NOT NULL
  ORDER BY p.numero DESC
  LIMIT 1
),
horario_corte = (
  SELECT p.horario_corte
  FROM pernas_jornada_voo p
  WHERE p.jornada_id = jornadas_voo.id
    AND p.horario_corte IS NOT NULL
  ORDER BY p.numero DESC
  LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM pernas_jornada_voo p WHERE p.jornada_id = jornadas_voo.id);
