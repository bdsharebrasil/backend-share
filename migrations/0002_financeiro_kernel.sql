-- Share Brasil D1: contrato financeiro canônico.
-- O banco de produção auditado possui zero registros em lancamentos,
-- contas_apagar e contas_areceber. A migration reconstrói somente essas
-- tabelas, mantendo os nomes de colunas legadas usados pelos relatórios.

PRAGMA foreign_keys=OFF;
DROP VIEW IF EXISTS vw_lancamentos_rateados;

CREATE TABLE IF NOT EXISTS colaboradores (
  id TEXT PRIMARY KEY NOT NULL,
  user_profile_id TEXT UNIQUE,
  nome TEXT NOT NULL,
  cpf TEXT,
  pix TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auditoria_financeira (
  id TEXT PRIMARY KEY NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id TEXT NOT NULL,
  operacao TEXT NOT NULL,
  valor_anterior_centavos INTEGER,
  valor_novo_centavos INTEGER,
  usuario_id TEXT,
  motivo TEXT,
  idempotency_key TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS financeiro_fila (
  id TEXT PRIMARY KEY NOT NULL,
  operacao TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  processado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reembolsos (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_origem_id TEXT NOT NULL,
  conta_receber_id TEXT,
  colaborador_id TEXT,
  cotista_id TEXT,
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  recebido_em TEXT,
  idempotency_key TEXT UNIQUE,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lancamentos_financeiro_new (
  id TEXT PRIMARY KEY NOT NULL,
  aeronave_id TEXT,
  cotista_id TEXT,
  holding_id TEXT,
  socio_id TEXT,
  data_lancamento TEXT,
  data TEXT,
  data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  descricao TEXT NOT NULL,
  fornecedor_id TEXT,
  fornecedor_nome TEXT,
  fornecedor TEXT,
  categoria_id TEXT,
  categoria_nome TEXT,
  categoria TEXT,
  grupo_categoria TEXT,
  fluxo TEXT NOT NULL CHECK (fluxo IN ('ENTRADA','SAIDA')),
  natureza TEXT,
  tipo TEXT,
  tipo_caixa TEXT NOT NULL DEFAULT 'SHARE',
  caixa TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  valor_total REAL,
  valor REAL,
  status TEXT NOT NULL DEFAULT 'EM_ABERTO',
  prazo TEXT,
  documento TEXT,
  conta_bancaria_id TEXT,
  pago_por_cotista_id TEXT,
  pago_por_socio_id TEXT,
  pago_por TEXT,
  pago_diretamente INTEGER NOT NULL DEFAULT 0 CHECK (pago_diretamente IN (0,1)),
  reembolsavel INTEGER NOT NULL DEFAULT 0 CHECK (reembolsavel IN (0,1)),
  reembolso_quitado INTEGER NOT NULL DEFAULT 0 CHECK (reembolso_quitado IN (0,1)),
  forma_pagamento TEXT,
  comprovante_url TEXT,
  observacoes TEXT,
  anexos_json TEXT NOT NULL DEFAULT '[]',
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  competencia TEXT,
  origem_tipo TEXT,
  origem_id TEXT,
  colaborador_ref_id TEXT,
  idempotency_key TEXT
);

INSERT INTO lancamentos_financeiro_new (
  id, aeronave_id, cotista_id, holding_id, socio_id, data_lancamento, data,
  data_emissao, data_vencimento, data_pagamento, descricao, fornecedor_id,
  fornecedor_nome, fornecedor, categoria_id, categoria_nome, categoria,
  grupo_categoria, fluxo, natureza, tipo, tipo_caixa, caixa, valor_centavos,
  valor_total, valor, status, conta_bancaria_id, pago_por_cotista_id,
  pago_por_socio_id, pago_diretamente, reembolsavel, reembolso_quitado, forma_pagamento,
  comprovante_url, observacoes, anexos_json, criado_por, criado_em,
  atualizado_em
)
SELECT id, aeronave_id, cotista_id, holding_id, socio_id, data_lancamento,
  data_lancamento, data_lancamento, data_vencimento, data_pagamento, descricao,
  fornecedor_id, fornecedor_nome, fornecedor_nome, categoria_id, categoria_nome,
  categoria_nome, grupo_categoria, fluxo, natureza, NULL, tipo_caixa, tipo_caixa,
  valor_centavos, valor_centavos / 100.0, valor_centavos / 100.0, status,
  conta_bancaria_id, pago_por_cotista_id, pago_por_socio_id, 0, reembolsavel,
  reembolso_quitado, forma_pagamento, comprovante_url, observacoes, '[]',
  criado_por, criado_em, atualizado_em
FROM lancamentos;

DROP TABLE lancamentos;
ALTER TABLE lancamentos_financeiro_new RENAME TO lancamentos;

CREATE TABLE contas_apagar_financeiro_new (
  id TEXT PRIMARY KEY NOT NULL,
  data_vencimento TEXT NOT NULL,
  data_pagamento TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  valor REAL,
  categoria_id TEXT,
  categoria_nome TEXT,
  descricao TEXT,
  aeronave_id TEXT,
  fornecedor_id TEXT,
  cotista_id TEXT,
  boleto_url TEXT,
  nf_url TEXT,
  lancamento_id TEXT NOT NULL UNIQUE,
  conta_bancaria_id TEXT,
  colaborador_id TEXT,
  status TEXT NOT NULL DEFAULT 'EM_ABERTO' CHECK (status IN ('EM_ABERTO','PENDENTE','PAGO','ATRASADO','CANCELADO')),
  comprovante_pagamento_url TEXT,
  banco_pagamento TEXT,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  origem_tipo TEXT,
  origem_id TEXT,
  idempotency_key TEXT
);

INSERT INTO contas_apagar_financeiro_new (
  id, data_vencimento, data_pagamento, valor_centavos, valor, categoria_id,
  categoria_nome, descricao, aeronave_id, fornecedor_id, cotista_id, boleto_url,
  nf_url, lancamento_id, conta_bancaria_id, status, comprovante_pagamento_url,
  banco_pagamento, criado_por, criado_em, atualizado_em
)
SELECT id, data_vencimento, data_pagamento, valor_centavos,
  valor_centavos / 100.0, categoria_id, categoria_nome, descricao, aeronave_id,
  fornecedor_id, cotista_id, NULL, NULL, lancamento_id,
  NULL, status, comprovante_pagamento_url, banco_pagamento,
  criado_por, criado_em, atualizado_em
FROM contas_apagar;

DROP TABLE contas_apagar;
ALTER TABLE contas_apagar_financeiro_new RENAME TO contas_apagar;

CREATE TABLE contas_areceber_financeiro_new (
  id TEXT PRIMARY KEY NOT NULL,
  data_vencimento TEXT,
  data_recebimento TEXT,
  data_pagamento TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  valor REAL,
  categoria_id TEXT,
  categoria_nome TEXT,
  descricao TEXT,
  aeronave_id TEXT,
  cotista_id TEXT,
  holding_id TEXT,
  socio_id TEXT,
  lancamento_receita_id TEXT,
  lancamento_cliente_id TEXT,
  lancamento_id TEXT,
  lancamentos_id TEXT,
  nf_saida_id TEXT,
  status TEXT NOT NULL DEFAULT 'EM_ABERTO' CHECK (status IN ('EM_ABERTO','PENDENTE','RECEBIDO','ATRASADO','CANCELADO')),
  banco_recebimento TEXT,
  comprovante_recebimento_url TEXT,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  origem_tipo TEXT,
  origem_id TEXT,
  idempotency_key TEXT
);

INSERT INTO contas_areceber_financeiro_new (
  id, data_vencimento, data_recebimento, data_pagamento, valor_centavos, valor,
  categoria_id, categoria_nome, descricao, aeronave_id, cotista_id, holding_id,
  socio_id, lancamento_receita_id, lancamento_cliente_id, lancamento_id,
  lancamentos_id, nf_saida_id, status, banco_recebimento,
  comprovante_recebimento_url, criado_por, criado_em, atualizado_em
)
SELECT id, data_vencimento, data_recebimento, NULL, valor_centavos,
  valor_centavos / 100.0, categoria_id, categoria_nome, descricao, aeronave_id,
  cotista_id, holding_id, socio_id, lancamento_receita_id,
  lancamento_cliente_id, lancamento_receita_id, lancamento_receita_id, nf_saida_id,
  status, banco_recebimento, comprovante_recebimento_url, criado_por, criado_em,
  atualizado_em
FROM contas_areceber;

DROP TABLE contas_areceber;
ALTER TABLE contas_areceber_financeiro_new RENAME TO contas_areceber;

CREATE UNIQUE INDEX idx_lancamentos_idempotency_key
  ON lancamentos(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_contas_apagar_idempotency_key
  ON contas_apagar(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_contas_areceber_idempotency_key
  ON contas_areceber(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_financeiro_fila_status ON financeiro_fila(status, criado_em);
CREATE INDEX idx_auditoria_financeira_entidade ON auditoria_financeira(entidade, entidade_id, criado_em);
CREATE INDEX idx_lancamentos_data_compat ON lancamentos(data);
CREATE INDEX idx_contas_apagar_status_vencimento ON contas_apagar(status, data_vencimento);
CREATE INDEX idx_contas_areceber_status_vencimento ON contas_areceber(status, data_vencimento);

CREATE VIEW vw_lancamentos_rateados AS
SELECT l.id AS lancamento_id, l.data, l.descricao, l.documento, l.fornecedor,
  l.categoria, l.grupo_categoria, l.tipo, l.prazo, l.fluxo, l.valor_centavos,
  l.pago_por, l.caixa, l.pago_diretamente, l.reembolsavel,
  l.reembolso_quitado, r.id AS rateio_id, r.cotista_id AS cotista,
  COALESCE(r.percentual_sociedade, r.percentual_uso) AS percentual,
  r.valor_rateado_centavos AS rateio_valor_centavos
FROM lancamentos l
LEFT JOIN rateio_despesas r ON r.lancamento_id = l.id;

PRAGMA foreign_keys=ON;
