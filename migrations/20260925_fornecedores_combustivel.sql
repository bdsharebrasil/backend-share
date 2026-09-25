-- Fonte única dos fornecedores usados em abastecimentos.
CREATE TABLE IF NOT EXISTS fornecedores_combustivel (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  nome_cidade TEXT NOT NULL,
  codigo_icao TEXT,
  nome_fornecedor TEXT NOT NULL,
  pessoa_contato TEXT,
  telefone TEXT,
  preco_avgas REAL,
  preco_jet REAL,
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now'))
);
