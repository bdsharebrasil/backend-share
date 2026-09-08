ALTER TABLE fornecedores_favoritos ADD COLUMN categoria_fornecedor TEXT NOT NULL DEFAULT 'nenhum';
CREATE INDEX IF NOT EXISTS idx_fornecedores_favoritos_nome ON fornecedores_favoritos(nome_completo);
CREATE INDEX IF NOT EXISTS idx_fornecedores_favoritos_categoria ON fornecedores_favoritos(categoria_fornecedor);
CREATE INDEX IF NOT EXISTS idx_contas_bancarias_ativo_tipo ON contas_bancarias(ativo,tipo_caixa);
CREATE INDEX IF NOT EXISTS idx_categoria_share_nome ON categoria_movimentacao_share(nome);
CREATE INDEX IF NOT EXISTS idx_categoria_cliente_nome ON categoria_movimentacao_cliente(nome);
