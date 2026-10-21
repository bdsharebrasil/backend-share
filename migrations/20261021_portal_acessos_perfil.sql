ALTER TABLE user_cliente ADD COLUMN principal_id TEXT;
ALTER TABLE user_cliente ADD COLUMN permissoes TEXT;

CREATE INDEX IF NOT EXISTS idx_user_cliente_principal_id
  ON user_cliente (principal_id);
