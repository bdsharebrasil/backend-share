-- Horários operacionais são Zulu (UTC). Corrige jornadas antigas em que POU/COR
-- foram gravados no dia seguinte por conversão local, produzindo durações > 9h.
-- Só ajusta registros comprovadamente incompatíveis com o limite operacional.
-- Corrige as pernas primeiro, mantendo a fonte operacional e a marcação ISO UTC.
UPDATE pernas_jornada_voo
SET horario_pouso = CASE WHEN horario_pouso IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', datetime(horario_pouso, '-1 day')) END,
    horario_corte = CASE WHEN horario_corte IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', datetime(horario_corte, '-1 day')) END
WHERE jornada_id IN (
  SELECT j.id FROM jornadas_voo j
  WHERE j.horario_apresentacao IS NOT NULL
    AND j.horario_corte IS NOT NULL
    AND date(j.horario_pouso) = date(j.data, '+1 day')
    AND date(j.horario_corte) = date(j.data, '+1 day')
    AND (julianday(j.horario_corte) - julianday(j.horario_apresentacao)) * 1440 > 540
);

-- Corrige o resumo da jornada com o mesmo critério.
UPDATE jornadas_voo
SET horario_pouso = CASE WHEN horario_pouso IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', datetime(horario_pouso, '-1 day')) END,
    horario_corte = CASE WHEN horario_corte IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ', datetime(horario_corte, '-1 day')) END
WHERE horario_apresentacao IS NOT NULL
  AND horario_corte IS NOT NULL
  AND date(horario_pouso) = date(data, '+1 day')
  AND date(horario_corte) = date(data, '+1 day')
  AND (julianday(horario_corte) - julianday(horario_apresentacao)) * 1440 > 540;

-- Recalcula: apresentação até o último COR/POU + pós-corte.
UPDATE jornadas_voo
SET minutos_jornada = (
  SELECT ROUND((julianday(COALESCE(p.horario_corte, p.horario_pouso)) -
    julianday(COALESCE(jornadas_voo.horario_apresentacao, p.horario_ac))) * 1440)
    + COALESCE(jornadas_voo.minutos_pos_corte, 45)
  FROM pernas_jornada_voo p
  WHERE p.jornada_id = jornadas_voo.id
  ORDER BY p.numero DESC LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM pernas_jornada_voo p WHERE p.jornada_id = jornadas_voo.id);
