ALTER TABLE user_profiles ADD COLUMN exame_admissional_realizado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN exame_admissional_data TEXT;
ALTER TABLE user_profiles ADD COLUMN exame_admissional_local TEXT;
ALTER TABLE user_profiles ADD COLUMN exame_admissional_empresa TEXT;
ALTER TABLE user_profiles ADD COLUMN exame_admissional_prazo TEXT;
ALTER TABLE user_profiles ADD COLUMN exame_admissional_documento_id TEXT;
