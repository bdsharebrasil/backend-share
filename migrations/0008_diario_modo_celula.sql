ALTER TABLE diario_mes ADD COLUMN modo_celula TEXT;

UPDATE diario_mes
SET modo_celula = 'tempo_total'
WHERE modo_celula IS NULL;
