-- Guarda classificação estruturada sem duplicar os dados do contato.
CREATE TABLE IF NOT EXISTS agenda_contatos_fornecedores (
    contato_id TEXT PRIMARY KEY NOT NULL,
    categoria TEXT NOT NULL CHECK (categoria IN ('FORNECEDOR', 'HANGAR', 'OUTRO')),
    categoria_personalizada TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contato_id) REFERENCES agenda_contatos(id) ON DELETE CASCADE,
    CHECK ((categoria = 'OUTRO' AND NULLIF(TRIM(categoria_personalizada), '') IS NOT NULL)
        OR (categoria <> 'OUTRO' AND categoria_personalizada IS NULL))
);
