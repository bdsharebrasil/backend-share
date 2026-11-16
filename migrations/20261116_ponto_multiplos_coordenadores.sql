-- Aplicar depois de 20261116_ponto_gestao.sql, antes de publicar o backend.
-- A vigência da coordenação é a do vínculo; os vínculos antigos são preservados.
CREATE TABLE IF NOT EXISTS ponto_vinculos_gestores (
  vinculo_id TEXT NOT NULL REFERENCES ponto_vinculos(id) ON DELETE CASCADE,
  gestor_id TEXT NOT NULL REFERENCES user_profiles(id),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vinculo_id, gestor_id)
);
CREATE INDEX IF NOT EXISTS idx_ponto_vinculos_gestores_usuario ON ponto_vinculos_gestores(gestor_id,vinculo_id);
INSERT OR IGNORE INTO ponto_vinculos_gestores (vinculo_id,gestor_id)
SELECT v.id,v.gestor_id FROM ponto_vinculos v JOIN user_profiles u ON u.id=v.gestor_id
WHERE v.gestor_id IS NOT NULL;
