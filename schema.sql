-- Schema inicial do D1 compartilhado pelo portal e pelo financeiro.
-- Pode ser aplicado mais de uma vez com: wrangler d1 execute SHARE_DB --remote --file=schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  nome_completo TEXT,
  nome_exibicao TEXT,
  cpf TEXT,
  pix TEXT,
  telefone TEXT,
  departamento TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  email_envio TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aeronave (
  id TEXT PRIMARY KEY NOT NULL,
  matricula_registro TEXT,
  fabricante TEXT,
  modelo TEXT,
  numero_serie TEXT,
  tipo_aeronave TEXT,
  status TEXT DEFAULT 'ativa',
  ano TEXT,
  base TEXT,
  consumo_combustivel REAL,
  preco_hora REAL,
  url_imagem TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cliente (
  id TEXT PRIMARY KEY NOT NULL,
  razao_social TEXT,
  cnpj TEXT,
  proprietario TEXT,
  codigo_cliente TEXT,
  status TEXT DEFAULT 'ativo',
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY NOT NULL,
  nome TEXT NOT NULL,
  conta_bancaria TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hold_socios (
  id TEXT PRIMARY KEY NOT NULL,
  cotista_id TEXT,
  nome TEXT NOT NULL,
  cpf TEXT NOT NULL,
  email_principal TEXT,
  emails TEXT NOT NULL DEFAULT '[]',
  endereco TEXT,
  cidade TEXT,
  uf TEXT,
  contato_financeiro TEXT,
  telefone_financeiro TEXT,
  telefone TEXT,
  observacoes TEXT,
  holding_id TEXT NOT NULL REFERENCES holdings(id),
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cotista_aeronave (
  id TEXT PRIMARY KEY NOT NULL,
  cliente_id TEXT,
  socio_id TEXT,
  aeronave_id TEXT,
  codigo_cliente TEXT,
  percentual_sociedade REAL DEFAULT 0,
  modelo_aeronave TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "lancamentos" (
  id TEXT PRIMARY KEY NOT NULL,
  aeronave_id TEXT,
 cotista_aeronave_id TEXT,
  holding_id TEXT,
  hold_socios_id TEXT,
  data_lancamento TEXT,
  data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  descricao TEXT NOT NULL,
 fornecedores_favoritos_id TEXT,
  fornecedor_nome TEXT,
  categoria_id TEXT,
  categoria_nome TEXT,
  grupo_categoria TEXT,
  fluxo TEXT NOT NULL CHECK (fluxo IN ('ENTRADA','SAIDA')),
  natureza TEXT,
  tipo_caixa TEXT NOT NULL DEFAULT 'SHARE',
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  valor_total REAL,
  valor REAL,
  status TEXT NOT NULL DEFAULT 'EM_ABERTO',
  prazo TEXT,
  documento TEXT,
  conta_bancaria_id TEXT,
  pago_por_cotista_aeronave_id TEXT,
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

CREATE TABLE IF NOT EXISTS rateios_cotistas (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_id TEXT NOT NULL,
  cotista TEXT NOT NULL,
  percentual REAL NOT NULL,
  valor_centavos INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rateio_despesas (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_id TEXT,
  lancamentos_id TEXT,
  categoria_nome TEXT,
  categoria_custo_id TEXT,
  cotista_id TEXT,
  cotista_nome TEXT,
  aeronave_id TEXT,
  fornecedor_id TEXT,
  tipo_rateio TEXT,
  data_vencimento TEXT,
  data_emissao_nf TEXT,
  numero_voo TEXT,
  subcategoria_1 TEXT,
  subcategoria_2 TEXT,
  subcategoria_3 TEXT,
  subcategoria_4 TEXT,
  descricao_despesa TEXT,
  pago_por TEXT,
  pago_diretamente INTEGER DEFAULT 0,
  percentual_sociedade REAL,
  percentual_uso REAL,
  valor_total REAL,
  valor_rateado REAL,
  status TEXT,
  observacoes TEXT,
  conferido_por TEXT,
  numero_recibo TEXT,
  recibo_url TEXT,
  anexos_json TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS movimentos_holding (
  id TEXT PRIMARY KEY NOT NULL,
  holding_id TEXT,
  aeronave_id TEXT,
  cotista_id TEXT,
  data TEXT,
  descricao TEXT,
  fornecedor TEXT,
  categoria TEXT,
  grupo_categoria TEXT,
  tipo TEXT,
  prazo TEXT,
  fluxo TEXT,
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  pago_por TEXT,
  pago_diretamente INTEGER DEFAULT 0,
  status TEXT,
  criado_por TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rateio_hold (
  id TEXT PRIMARY KEY NOT NULL,
  movimentos_holding_id TEXT,
  categoria_nome TEXT,
  categoria_custo_id TEXT,
  fornecedor_id TEXT,
  cotista_id TEXT,
  cotista_nome TEXT,
  aeronave_id TEXT,
  tipo_rateio TEXT,
  data_vencimento TEXT,
  data_emissao_nf TEXT,
  numero_voo TEXT,
  subcategoria_1 TEXT,
  subcategoria_2 TEXT,
  subcategoria_3 TEXT,
  subcategoria_4 TEXT,
  descricao_despesa TEXT,
  pago_por TEXT,
  pago_diretamente INTEGER DEFAULT 0,
  percentual_sociedade REAL,
  percentual_uso REAL,
  valor_total REAL,
  valor_rateado REAL,
  status TEXT,
  observacoes TEXT,
  conferido_por TEXT,
  numero_recibo TEXT,
  recibo_url TEXT,
  anexos_json TEXT DEFAULT '[]'
);

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

CREATE TABLE IF NOT EXISTS contas_apagar (
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
  status TEXT NOT NULL DEFAULT 'EM_ABERTO',
  comprovante_pagamento_url TEXT,
  banco_pagamento TEXT,
  criado_por TEXT,
  origem_tipo TEXT,
  origem_id TEXT,
  idempotency_key TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contas_areceber (
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
  status TEXT NOT NULL DEFAULT 'EM_ABERTO',
  banco_recebimento TEXT,
  comprovante_recebimento_url TEXT,
  criado_por TEXT,
  origem_tipo TEXT,
  origem_id TEXT,
  idempotency_key TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reembolsos (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_origem_id TEXT NOT NULL,
  conta_receber_id TEXT,
  colaborador_id TEXT,
  cotista_id TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  recebido_em TEXT,
  idempotency_key TEXT UNIQUE,
  criado_por TEXT,
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

CREATE TABLE IF NOT EXISTS envio_despesas (
  id TEXT PRIMARY KEY NOT NULL,
  tipo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  valor REAL NOT NULL DEFAULT 0,
  data_despesa TEXT,
  vencimento TEXT,
  fornecedor TEXT,
  fornecedor_id TEXT,
  cotista_id TEXT,
  cotista_ids TEXT DEFAULT '[]',
  aeronave_id TEXT,
  numero_voo TEXT,
  centro_custo TEXT,
  categoria_id TEXT,
  categoria_nome TEXT,
  observacoes TEXT,
  periodicidade TEXT,
  anexos_json TEXT DEFAULT '[]',
  rateio_linhas_json TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'aguardando_programacao',
  email_solicitado INTEGER NOT NULL DEFAULT 0,
  email_enviado INTEGER NOT NULL DEFAULT 0,
  email_enviado_em TEXT,
  email_id TEXT,
  grupo_categoria TEXT,
  tipo_caixa TEXT,
  tipo_despesa TEXT,
  tipo_rateio TEXT,
  subcategoria_1 TEXT,
  subcategoria_2 TEXT,
  subcategoria_3 TEXT,
  subcategoria_4 TEXT,
  pago_diretamente INTEGER DEFAULT 0,
  pago_por TEXT,
  lancamento_id TEXT,
  rateio_id TEXT,
  movimentos_holding_id TEXT,
  criado_por TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categoria_movimentacao_cliente (
  id TEXT PRIMARY KEY NOT NULL,
  nome TEXT NOT NULL,
  subcategoria_1 TEXT,
  subcategoria_2 TEXT,
  subcategoria_3 TEXT,
  subcategoria_4 TEXT
);

CREATE INDEX IF NOT EXISTS lancamentos_data_idx ON lancamentos(data_lancamento);
CREATE INDEX IF NOT EXISTS lancamentos_data_emissao_idx ON lancamentos(data_emissao);
CREATE INDEX IF NOT EXISTS lancamentos_idempotency_idx ON lancamentos(idempotency_key);
CREATE INDEX IF NOT EXISTS lancamentos_caixa_idx ON lancamentos(tipo_caixa, status);
CREATE INDEX IF NOT EXISTS rateios_cotistas_lancamento_idx ON rateios_cotistas(lancamento_id);
CREATE INDEX IF NOT EXISTS rateio_despesas_lancamento_idx ON rateio_despesas(lancamentos_id, lancamento_id);
CREATE INDEX IF NOT EXISTS movimentos_holding_holding_idx ON movimentos_holding(holding_id, data);
CREATE INDEX IF NOT EXISTS contas_apagar_status_idx ON contas_apagar(status, data_vencimento);
CREATE INDEX IF NOT EXISTS contas_areceber_status_idx ON contas_areceber(status, data_vencimento);
CREATE INDEX IF NOT EXISTS contas_areceber_idempotency_idx ON contas_areceber(idempotency_key);
CREATE INDEX IF NOT EXISTS auditoria_financeira_entidade_idx ON auditoria_financeira(entidade, entidade_id, criado_em);
CREATE INDEX IF NOT EXISTS financeiro_fila_status_idx ON financeiro_fila(status, criado_em);
CREATE UNIQUE INDEX IF NOT EXISTS envio_despesas_lancamento_idx ON envio_despesas(lancamento_id) WHERE lancamento_id IS NOT NULL;