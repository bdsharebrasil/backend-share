PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

DROP TABLE lancamentos;
ALTER TABLE lancamentos_nova RENAME TO lancamentos;

CREATE INDEX idx_lancamentos_cliente_id
  ON lancamentos(cliente_id);

CREATE INDEX idx_lancamentos_email_enviado
  ON lancamentos(email_enviado_em);

CREATE INDEX idx_lancamentos_escopo_criado
  ON lancamentos(escopo_financeiro, criado_em DESC);

PRAGMA legacy_alter_table = OFF;
PRAGMA defer_foreign_keys = OFF;
