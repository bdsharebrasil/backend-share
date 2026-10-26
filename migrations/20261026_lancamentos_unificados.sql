-- Projeção canônica de leitura/escrita para lançamentos de caixa SHARE e CLIENTE.
-- movimentos_holding permanece em sua própria tabela e fluxo de baixa.
-- Tabelas legadas continuam como fonte de verdade operacional; os triggers mantêm
-- o espelho no mesmo commit D1 para não quebrar Kernel, rateios ou recibos.
CREATE TABLE IF NOT EXISTS lancamentos_unificados (
  id TEXT PRIMARY KEY NOT NULL,
  fluxo TEXT NOT NULL CHECK (fluxo IN ('ENTRADA', 'SAIDA')),
  natureza TEXT NOT NULL DEFAULT 'LANCAMENTO',
  caixa TEXT NOT NULL CHECK (caixa IN ('SHARE', 'CLIENTE')),
  descricao TEXT NOT NULL DEFAULT '',
  categoria_id TEXT,
  categoria TEXT,
  favorecido_id TEXT,
  favorecido TEXT,
  conta_bancaria_id TEXT,
  data_lancamento TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'PAGO', 'CANCELADO')),
  status_origem TEXT,
  valor_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  reembolsavel INTEGER NOT NULL DEFAULT 0 CHECK (reembolsavel IN (0, 1)),
  cotista_id TEXT,
  numero_documento TEXT,
  nf_url TEXT,
  boleto_url TEXT,
  comprovante_url TEXT,
  anexos_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(anexos_json)),
  observacoes TEXT,
  origem_tipo TEXT NOT NULL,
  origem_id TEXT NOT NULL,
  origem_negocio_tipo TEXT,
  lancamento_id TEXT,
  conta_a_pagar_id TEXT,
  conta_a_receber_id TEXT,
  envio_pagamento_id TEXT,
  solicitacao_compra_id TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (origem_tipo, origem_id)
);
CREATE INDEX IF NOT EXISTS idx_lancamentos_unificados_fluxo_status_data
  ON lancamentos_unificados (fluxo, status, data_vencimento, data_lancamento);
CREATE INDEX IF NOT EXISTS idx_lancamentos_unificados_caixa_data
  ON lancamentos_unificados (caixa, data_lancamento DESC);
CREATE INDEX IF NOT EXISTS idx_lancamentos_unificados_cotista
  ON lancamentos_unificados (cotista_id, status);
CREATE INDEX IF NOT EXISTS idx_lancamentos_unificados_lancamento
  ON lancamentos_unificados (lancamento_id);

-- Backfill de lançamentos financeiros que não pertencem ao livro exclusivo de holding.
INSERT OR IGNORE INTO lancamentos_unificados (
  id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
  conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
  valor_centavos, reembolsavel, cotista_id, numero_documento, nf_url, boleto_url, comprovante_url,
  anexos_json, observacoes, origem_tipo, origem_id, origem_negocio_tipo, lancamento_id,
  criado_em, atualizado_em
)
SELECT l.id,
  CASE WHEN UPPER(l.fluxo) IN ('ENTRADA', 'RECEITA') THEN 'ENTRADA' ELSE 'SAIDA' END,
  COALESCE(NULLIF(l.grupo_categoria, ''), NULLIF(l.origem_tipo, ''), 'LANCAMENTO'),
  CASE WHEN UPPER(l.tipo_caixa) = 'CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
  COALESCE(l.descricao, ''), COALESCE(l.categoria_share_id, l.categoria_cliente_id),
  COALESCE(l.categoria_nome, l.grupo_categoria), l.fornecedores_favoritos_id,
  COALESCE(NULLIF(l.fornecedor_nome, ''), NULLIF(l.pago_por, '')),
  l.conta_bancaria_id, COALESCE(l.data_emissao, l.criado_em), l.data_vencimento, l.data_pagamento,
  CASE WHEN UPPER(COALESCE(l.status, '')) IN ('PAGO', 'RECEBIDO', 'REEMBOLSADO') THEN 'PAGO'
       WHEN UPPER(COALESCE(l.status, '')) = 'CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
  l.status, l.valor_centavos, COALESCE(l.reembolsavel, 0), COALESCE(l.cotista_aeronave_id, l.pago_por_cotista_id),
  COALESCE(l.numero_doc, l.numero_nf, l.numero_recibo, l.numero_boleto, l.numero_demonstrativo),
  COALESCE(l.url_nf, l.url_recibo), l.url_boleto, l.comprovante_url, CASE WHEN json_valid(COALESCE(l.anexos_json, '')) THEN l.anexos_json ELSE '[]' END,
  l.observacoes, 'lancamentos', l.id, l.origem_tipo, l.id, l.criado_em, l.atualizado_em
FROM lancamentos l
WHERE UPPER(COALESCE(l.tipo_caixa, '')) IN ('SHARE', 'CLIENTE')
  AND UPPER(COALESCE(l.fluxo, '')) IN ('ENTRADA', 'RECEITA', 'SAIDA', 'DESPESA', 'ESTORNO', 'REEMBOLSO');

-- Contas ligadas a lançamento enriquecem a linha canônica; contas sem lançamento
-- recebem identificador próprio. Baixas de movimento holding e folha não entram.
INSERT INTO lancamentos_unificados (
  id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
  conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
  valor_centavos, cotista_id, numero_documento, nf_url, boleto_url, comprovante_url, observacoes,
  origem_tipo, origem_id, lancamento_id, conta_a_pagar_id, criado_em, atualizado_em
)
SELECT COALESCE(l.id, 'conta_pagar:' || cp.id), 'SAIDA', COALESCE(l.grupo_categoria, cp.origem_tipo, 'CONTA A PAGAR'),
  CASE WHEN UPPER(COALESCE(l.tipo_caixa, '')) = 'CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
  COALESCE(cp.descricao, l.descricao, ''), COALESCE(cp.categoria_id, l.categoria_share_id, l.categoria_cliente_id),
  COALESCE(cp.categoria_nome, l.categoria_nome), cp.fornecedor_id,
  COALESCE(l.fornecedor_nome, (SELECT COALESCE(ff.apelido, ff.nome_completo) FROM fornecedores_favoritos ff WHERE ff.id = cp.fornecedor_id), l.pago_por),
  cp.banco_pagamento, COALESCE(cp.data_lancamento, l.data_emissao, cp.criado_em), cp.data_vencimento,
  cp.data_pagamento, CASE WHEN UPPER(cp.status) = 'PAGO' THEN 'PAGO' WHEN UPPER(cp.status) = 'CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
  cp.status, cp.valor_centavos, COALESCE(l.cotista_aeronave_id, cp.cotista_id),
  COALESCE(l.numero_doc, l.numero_nf, l.numero_recibo, l.numero_boleto), l.url_nf, cp.boleto_url,
  cp.comprovante_pagamento_url, l.observacoes, CASE WHEN l.id IS NULL THEN 'contas_apagar' ELSE 'lancamentos' END,
  CASE WHEN l.id IS NULL THEN cp.id ELSE l.id END, l.id, cp.id, cp.criado_em, cp.atualizado_em
FROM contas_apagar cp
LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id AND UPPER(COALESCE(l.tipo_caixa, '')) IN ('SHARE', 'CLIENTE')
WHERE cp.movimentos_id IS NULL AND cp.colaborador_id IS NULL AND cp.valor_centavos > 0
  AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=cp.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
ON CONFLICT(id) DO UPDATE SET
  data_vencimento = excluded.data_vencimento, data_pagamento = excluded.data_pagamento,
  status = excluded.status, status_origem = excluded.status_origem,
  valor_centavos = excluded.valor_centavos, conta_bancaria_id = excluded.conta_bancaria_id,
  conta_a_pagar_id = excluded.conta_a_pagar_id, boleto_url = excluded.boleto_url,
  comprovante_url = excluded.comprovante_url, atualizado_em = excluded.atualizado_em;

INSERT INTO lancamentos_unificados (
  id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
  conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
  valor_centavos, cotista_id, numero_documento, nf_url, comprovante_url, observacoes,
  origem_tipo, origem_id, lancamento_id, conta_a_receber_id, criado_em, atualizado_em
)
SELECT COALESCE(l.id, 'conta_receber:' || cr.id), 'ENTRADA', COALESCE(l.origem_tipo, cr.origem_tipo, 'CONTA A RECEBER'),
  CASE WHEN UPPER(COALESCE(l.tipo_caixa, '')) = 'CLIENTE' OR cr.cotista_id IS NOT NULL THEN 'CLIENTE' ELSE 'SHARE' END,
  COALESCE(cr.descricao, l.descricao, ''), COALESCE(cr.categoria_id, l.categoria_share_id, l.categoria_cliente_id),
  COALESCE(cr.categoria_nome, l.categoria_nome), l.fornecedores_favoritos_id,
  COALESCE(l.fornecedor_nome, l.pago_por), COALESCE(cr.banco_recebimento, l.conta_bancaria_id),
  COALESCE(l.data_emissao, cr.criado_em), cr.data_vencimento, COALESCE(cr.data_recebimento, cr.data_pagamento, l.data_pagamento),
  CASE WHEN UPPER(cr.status) IN ('PAGO', 'RECEBIDO') THEN 'PAGO' WHEN UPPER(cr.status) = 'CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
  cr.status, cr.valor_centavos, COALESCE(cr.cotista_id, l.cotista_aeronave_id),
  COALESCE(l.numero_doc, l.numero_nf, l.numero_recibo), l.url_nf,
  COALESCE(cr.comprovante_recebimento_url, l.comprovante_url), cr.descricao,
  CASE WHEN l.id IS NULL THEN 'contas_areceber' ELSE 'lancamentos' END,
  CASE WHEN l.id IS NULL THEN cr.id ELSE l.id END, l.id, cr.id, cr.criado_em, cr.atualizado_em
FROM contas_areceber cr
LEFT JOIN lancamentos l ON l.id = cr.lancamentos_id AND UPPER(COALESCE(l.tipo_caixa, '')) IN ('SHARE', 'CLIENTE')
WHERE cr.movimentos_id IS NULL AND cr.valor_centavos > 0
  AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=cr.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
ON CONFLICT(id) DO UPDATE SET
  data_vencimento = excluded.data_vencimento, data_pagamento = excluded.data_pagamento,
  status = excluded.status, status_origem = excluded.status_origem,
  valor_centavos = excluded.valor_centavos, conta_bancaria_id = excluded.conta_bancaria_id,
  conta_a_receber_id = excluded.conta_a_receber_id,
  comprovante_url = excluded.comprovante_url, atualizado_em = excluded.atualizado_em;

-- Solicitações financeiras que ainda não foram convertidas em lançamento/conta.
INSERT OR IGNORE INTO lancamentos_unificados (
  id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
  data_lancamento, data_vencimento, status, status_origem, valor_centavos, reembolsavel,
  cotista_id, anexos_json, observacoes, origem_tipo, origem_id, envio_pagamento_id,
  solicitacao_compra_id, criado_em, atualizado_em
)
SELECT 'envio_pagamento:' || e.id, 'SAIDA', COALESCE(e.tipo_despesa, e.tipo, 'SOLICITACAO_PAGAMENTO'),
  CASE WHEN UPPER(COALESCE(e.tipo_caixa, '')) = 'CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
  COALESCE(e.descricao, ''), COALESCE(e.categoria_cliente_id, e.categoria_id), e.categoria_nome,
  e.fornecedor_id, e.fornecedor, e.data_despesa, e.vencimento,
  CASE WHEN UPPER(e.status) IN ('PAGO', 'CONCLUIDO', 'CONCLUIDA') THEN 'PAGO' WHEN UPPER(e.status) IN ('CANCELADO', 'CANCELADA', 'REJEITADO', 'REJEITADA') THEN 'CANCELADO' ELSE 'PENDENTE' END,
  e.status, ROUND(COALESCE(e.valor_total_despesa, e.valor, 0) * 100), 0, e.cotista_id,
  CASE WHEN json_valid(COALESCE(e.anexos_json, '')) THEN e.anexos_json ELSE '[]' END, e.observacoes, 'envio_despesas', e.id, e.id, e.solicitacao_compra_id,
  e.criado_em, e.atualizado_em
FROM envio_despesas e
WHERE e.lancamento_id IS NULL AND e.movimentacao_id IS NULL AND e.movimentos_holding_id IS NULL
  AND UPPER(COALESCE(e.tipo_caixa, '')) <> 'HOLDING'
  AND UPPER(COALESCE(e.status, '')) NOT IN ('CONVERTIDO', 'CONCLUIDO', 'CONCLUIDA', 'CANCELADO', 'CANCELADA', 'REJEITADO', 'REJEITADA');

-- Solicitação de compra não convertida: valor estimado vem dos itens, não de uma
-- conta a pagar fictícia. Quando converte, a linha de solicitação é removida e
-- a conta/lancamento real passa a ser a linha canônica.
INSERT OR IGNORE INTO lancamentos_unificados (
  id, fluxo, natureza, caixa, descricao, data_lancamento, data_vencimento, status,
  status_origem, valor_centavos, solicitacao_compra_id, origem_tipo, origem_id,
  favorecido, observacoes, criado_em, atualizado_em
)
SELECT 'solicitacao_compra:' || sc.id, 'SAIDA', 'SOLICITACAO_COMPRA', 'SHARE', sc.descricao,
  COALESCE(sc.data_solicitacao, sc.data_criacao), sc.data_necessaria, 'PENDENTE', sc.status,
  COALESCE((SELECT ROUND(SUM(i.quantidade * i.valor_unitario * 100)) FROM itens_solicitacao_compra i WHERE i.solicitacao_compra_id = sc.id), 0),
  sc.id, 'solicitacoes_compra', sc.id, COALESCE(sc.solicitante_nome, sc.user_id), sc.observacoes,
  COALESCE(sc.data_criacao, CURRENT_TIMESTAMP), COALESCE(sc.data_atualizacao, CURRENT_TIMESTAMP)
FROM solicitacoes_compra sc
WHERE UPPER(COALESCE(sc.status, '')) NOT IN ('CONCLUIDA', 'CONCLUIDO', 'CANCELADA', 'CANCELADO', 'REJEITADA', 'REJEITADO')
  AND NOT EXISTS (SELECT 1 FROM envio_despesas e WHERE e.solicitacao_compra_id = sc.id AND (e.lancamento_id IS NOT NULL OR e.movimentos_holding_id IS NOT NULL OR UPPER(COALESCE(e.status, '')) IN ('CONVERTIDO', 'CONCLUIDO', 'CONCLUIDA')));

-- Inserções e alterações no fluxo antigo permanecem visíveis no registro canônico.
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_lancamentos_insert AFTER INSERT ON lancamentos
WHEN UPPER(COALESCE(NEW.tipo_caixa, '')) IN ('SHARE', 'CLIENTE')
 AND UPPER(COALESCE(NEW.fluxo, '')) IN ('ENTRADA', 'RECEITA', 'SAIDA', 'DESPESA', 'ESTORNO', 'REEMBOLSO')
BEGIN
  INSERT INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
    conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
    valor_centavos, reembolsavel, cotista_id, numero_documento, nf_url, boleto_url, comprovante_url,
    anexos_json, observacoes, origem_tipo, origem_id, origem_negocio_tipo, lancamento_id, criado_em, atualizado_em
  ) VALUES (
    NEW.id, CASE WHEN UPPER(NEW.fluxo) IN ('ENTRADA', 'RECEITA') THEN 'ENTRADA' ELSE 'SAIDA' END,
    COALESCE(NULLIF(NEW.grupo_categoria, ''), NULLIF(NEW.origem_tipo, ''), 'LANCAMENTO'),
    CASE WHEN UPPER(NEW.tipo_caixa) = 'CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao, ''), COALESCE(NEW.categoria_share_id, NEW.categoria_cliente_id),
    COALESCE(NEW.categoria_nome, NEW.grupo_categoria), NEW.fornecedores_favoritos_id,
    COALESCE(NULLIF(NEW.fornecedor_nome, ''), NULLIF(NEW.pago_por, '')), NEW.conta_bancaria_id,
    COALESCE(NEW.data_emissao, NEW.criado_em), NEW.data_vencimento, NEW.data_pagamento,
    CASE WHEN UPPER(COALESCE(NEW.status, '')) IN ('PAGO', 'RECEBIDO', 'REEMBOLSADO') THEN 'PAGO' WHEN UPPER(COALESCE(NEW.status, '')) = 'CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
    NEW.status, NEW.valor_centavos, COALESCE(NEW.reembolsavel, 0), COALESCE(NEW.cotista_aeronave_id, NEW.pago_por_cotista_id),
    COALESCE(NEW.numero_doc, NEW.numero_nf, NEW.numero_recibo, NEW.numero_boleto, NEW.numero_demonstrativo),
    COALESCE(NEW.url_nf, NEW.url_recibo), NEW.url_boleto, NEW.comprovante_url,
    CASE WHEN json_valid(COALESCE(NEW.anexos_json, '')) THEN NEW.anexos_json ELSE '[]' END, NEW.observacoes, 'lancamentos', NEW.id, NEW.origem_tipo, NEW.id,
    COALESCE(NEW.criado_em, CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em, CURRENT_TIMESTAMP)
  ) ON CONFLICT(id) DO UPDATE SET
    fluxo=excluded.fluxo, natureza=excluded.natureza, caixa=excluded.caixa, descricao=excluded.descricao,
    categoria_id=excluded.categoria_id, categoria=excluded.categoria, favorecido_id=excluded.favorecido_id,
    favorecido=excluded.favorecido, conta_bancaria_id=COALESCE(excluded.conta_bancaria_id,lancamentos_unificados.conta_bancaria_id),
    data_lancamento=excluded.data_lancamento, data_vencimento=COALESCE(lancamentos_unificados.data_vencimento,excluded.data_vencimento),
    data_pagamento=COALESCE(excluded.data_pagamento,lancamentos_unificados.data_pagamento), status=excluded.status,
    status_origem=excluded.status_origem, valor_centavos=excluded.valor_centavos, reembolsavel=excluded.reembolsavel,
    cotista_id=excluded.cotista_id, numero_documento=excluded.numero_documento, nf_url=excluded.nf_url,
    boleto_url=excluded.boleto_url, comprovante_url=COALESCE(excluded.comprovante_url,lancamentos_unificados.comprovante_url),
    anexos_json=excluded.anexos_json, observacoes=excluded.observacoes, atualizado_em=excluded.atualizado_em;
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_lancamentos_update AFTER UPDATE ON lancamentos
WHEN UPPER(COALESCE(NEW.tipo_caixa, '')) IN ('SHARE', 'CLIENTE')
 AND UPPER(COALESCE(NEW.fluxo, '')) IN ('ENTRADA', 'RECEITA', 'SAIDA', 'DESPESA', 'ESTORNO', 'REEMBOLSO')
BEGIN
  INSERT INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
    conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
    valor_centavos, reembolsavel, cotista_id, numero_documento, nf_url, boleto_url, comprovante_url,
    anexos_json, observacoes, origem_tipo, origem_id, origem_negocio_tipo, lancamento_id, criado_em, atualizado_em
  ) VALUES (
    NEW.id, CASE WHEN UPPER(NEW.fluxo) IN ('ENTRADA', 'RECEITA') THEN 'ENTRADA' ELSE 'SAIDA' END,
    COALESCE(NULLIF(NEW.grupo_categoria, ''), NULLIF(NEW.origem_tipo, ''), 'LANCAMENTO'),
    CASE WHEN UPPER(NEW.tipo_caixa) = 'CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao, ''), COALESCE(NEW.categoria_share_id, NEW.categoria_cliente_id),
    COALESCE(NEW.categoria_nome, NEW.grupo_categoria), NEW.fornecedores_favoritos_id,
    COALESCE(NULLIF(NEW.fornecedor_nome, ''), NULLIF(NEW.pago_por, '')), NEW.conta_bancaria_id,
    COALESCE(NEW.data_emissao, NEW.criado_em), NEW.data_vencimento, NEW.data_pagamento,
    CASE WHEN UPPER(COALESCE(NEW.status, '')) IN ('PAGO', 'RECEBIDO', 'REEMBOLSADO') THEN 'PAGO' WHEN UPPER(COALESCE(NEW.status, '')) = 'CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
    NEW.status, NEW.valor_centavos, COALESCE(NEW.reembolsavel, 0), COALESCE(NEW.cotista_aeronave_id, NEW.pago_por_cotista_id),
    COALESCE(NEW.numero_doc, NEW.numero_nf, NEW.numero_recibo, NEW.numero_boleto, NEW.numero_demonstrativo),
    COALESCE(NEW.url_nf, NEW.url_recibo), NEW.url_boleto, NEW.comprovante_url,
    CASE WHEN json_valid(COALESCE(NEW.anexos_json, '')) THEN NEW.anexos_json ELSE '[]' END, NEW.observacoes, 'lancamentos', NEW.id, NEW.origem_tipo, NEW.id,
    COALESCE(NEW.criado_em, CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em, CURRENT_TIMESTAMP)
  ) ON CONFLICT(id) DO UPDATE SET
    fluxo=excluded.fluxo, natureza=excluded.natureza, caixa=excluded.caixa, descricao=excluded.descricao,
    categoria_id=excluded.categoria_id, categoria=excluded.categoria, favorecido_id=excluded.favorecido_id,
    favorecido=excluded.favorecido, conta_bancaria_id=COALESCE(excluded.conta_bancaria_id,lancamentos_unificados.conta_bancaria_id),
    data_lancamento=excluded.data_lancamento, data_vencimento=COALESCE(lancamentos_unificados.data_vencimento,excluded.data_vencimento),
    data_pagamento=COALESCE(excluded.data_pagamento,lancamentos_unificados.data_pagamento), status=excluded.status,
    status_origem=excluded.status_origem, valor_centavos=excluded.valor_centavos, reembolsavel=excluded.reembolsavel,
    cotista_id=excluded.cotista_id, numero_documento=excluded.numero_documento, nf_url=excluded.nf_url,
    boleto_url=excluded.boleto_url, comprovante_url=COALESCE(excluded.comprovante_url,lancamentos_unificados.comprovante_url),
    anexos_json=excluded.anexos_json, observacoes=excluded.observacoes, atualizado_em=excluded.atualizado_em;
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_contas_apagar_insert AFTER INSERT ON contas_apagar
WHEN NEW.movimentos_id IS NULL AND NEW.colaborador_id IS NULL AND NEW.valor_centavos > 0
 AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
BEGIN
  INSERT INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
    conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
    valor_centavos, cotista_id, numero_documento, nf_url, boleto_url, comprovante_url, observacoes,
    origem_tipo, origem_id, lancamento_id, conta_a_pagar_id, criado_em, atualizado_em
  ) SELECT COALESCE(l.id,'conta_pagar:'||NEW.id), 'SAIDA', COALESCE(l.grupo_categoria,NEW.origem_tipo,'CONTA A PAGAR'),
    CASE WHEN UPPER(COALESCE(l.tipo_caixa,''))='CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao,l.descricao,''), COALESCE(NEW.categoria_id,l.categoria_share_id,l.categoria_cliente_id),
    COALESCE(NEW.categoria_nome,l.categoria_nome), NEW.fornecedor_id,
    COALESCE(l.fornecedor_nome,(SELECT COALESCE(ff.apelido,ff.nome_completo) FROM fornecedores_favoritos ff WHERE ff.id=NEW.fornecedor_id),l.pago_por),
    NEW.banco_pagamento, COALESCE(NEW.data_lancamento,l.data_emissao,NEW.criado_em), NEW.data_vencimento, NEW.data_pagamento,
    CASE WHEN UPPER(NEW.status)='PAGO' THEN 'PAGO' WHEN UPPER(NEW.status)='CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
    NEW.status, NEW.valor_centavos, COALESCE(l.cotista_aeronave_id,NEW.cotista_id),
    COALESCE(l.numero_doc,l.numero_nf,l.numero_recibo,l.numero_boleto), l.url_nf, NEW.boleto_url,
    COALESCE(NEW.comprovante_pagamento_url,l.comprovante_url), l.observacoes,
    CASE WHEN l.id IS NULL THEN 'contas_apagar' ELSE 'lancamentos' END, CASE WHEN l.id IS NULL THEN NEW.id ELSE l.id END,
    l.id, NEW.id, COALESCE(NEW.criado_em,CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em,CURRENT_TIMESTAMP)
    FROM (SELECT 1) dummy LEFT JOIN lancamentos l ON l.id=NEW.lancamentos_id AND UPPER(COALESCE(l.tipo_caixa,'')) IN ('SHARE','CLIENTE')
    WHERE NEW.movimentos_id IS NULL AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
  ON CONFLICT(id) DO UPDATE SET data_vencimento=excluded.data_vencimento, data_pagamento=excluded.data_pagamento,
    status=excluded.status, status_origem=excluded.status_origem, valor_centavos=excluded.valor_centavos,
    conta_bancaria_id=COALESCE(excluded.conta_bancaria_id,lancamentos_unificados.conta_bancaria_id),
    conta_a_pagar_id=excluded.conta_a_pagar_id, boleto_url=excluded.boleto_url,
    comprovante_url=COALESCE(excluded.comprovante_url,lancamentos_unificados.comprovante_url), atualizado_em=excluded.atualizado_em;
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_contas_apagar_update AFTER UPDATE ON contas_apagar
WHEN NEW.movimentos_id IS NULL AND NEW.colaborador_id IS NULL AND NEW.valor_centavos > 0
 AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
BEGIN
  INSERT INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
    conta_bancaria_id, data_lancamento, data_vencimento, data_pagamento, status, status_origem,
    valor_centavos, cotista_id, numero_documento, nf_url, boleto_url, comprovante_url, observacoes,
    origem_tipo, origem_id, lancamento_id, conta_a_pagar_id, criado_em, atualizado_em
  ) SELECT COALESCE(l.id,'conta_pagar:'||NEW.id), 'SAIDA', COALESCE(l.grupo_categoria,NEW.origem_tipo,'CONTA A PAGAR'),
    CASE WHEN UPPER(COALESCE(l.tipo_caixa,''))='CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao,l.descricao,''), COALESCE(NEW.categoria_id,l.categoria_share_id,l.categoria_cliente_id),
    COALESCE(NEW.categoria_nome,l.categoria_nome), NEW.fornecedor_id,
    COALESCE(l.fornecedor_nome,(SELECT COALESCE(ff.apelido,ff.nome_completo) FROM fornecedores_favoritos ff WHERE ff.id=NEW.fornecedor_id),l.pago_por),
    NEW.banco_pagamento, COALESCE(NEW.data_lancamento,l.data_emissao,NEW.criado_em), NEW.data_vencimento, NEW.data_pagamento,
    CASE WHEN UPPER(NEW.status)='PAGO' THEN 'PAGO' WHEN UPPER(NEW.status)='CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
    NEW.status, NEW.valor_centavos, COALESCE(l.cotista_aeronave_id,NEW.cotista_id),
    COALESCE(l.numero_doc,l.numero_nf,l.numero_recibo,l.numero_boleto), l.url_nf, NEW.boleto_url,
    COALESCE(NEW.comprovante_pagamento_url,l.comprovante_url), l.observacoes,
    CASE WHEN l.id IS NULL THEN 'contas_apagar' ELSE 'lancamentos' END, CASE WHEN l.id IS NULL THEN NEW.id ELSE l.id END,
    l.id, NEW.id, COALESCE(NEW.criado_em,CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em,CURRENT_TIMESTAMP)
    FROM (SELECT 1) dummy LEFT JOIN lancamentos l ON l.id=NEW.lancamentos_id AND UPPER(COALESCE(l.tipo_caixa,'')) IN ('SHARE','CLIENTE')
    WHERE NEW.movimentos_id IS NULL AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
  ON CONFLICT(id) DO UPDATE SET data_vencimento=excluded.data_vencimento, data_pagamento=excluded.data_pagamento,
    status=excluded.status, status_origem=excluded.status_origem, valor_centavos=excluded.valor_centavos,
    conta_bancaria_id=COALESCE(excluded.conta_bancaria_id,lancamentos_unificados.conta_bancaria_id),
    conta_a_pagar_id=excluded.conta_a_pagar_id, boleto_url=excluded.boleto_url,
    comprovante_url=COALESCE(excluded.comprovante_url,lancamentos_unificados.comprovante_url), atualizado_em=excluded.atualizado_em;
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_contas_areceber_insert AFTER INSERT ON contas_areceber
WHEN NEW.movimentos_id IS NULL AND NEW.valor_centavos > 0
 AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
BEGIN
  INSERT INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, conta_bancaria_id, data_lancamento,
    data_vencimento, data_pagamento, status, status_origem, valor_centavos, cotista_id, numero_documento,
    nf_url, comprovante_url, origem_tipo, origem_id, lancamento_id, conta_a_receber_id, criado_em, atualizado_em
  ) SELECT COALESCE(l.id,'conta_receber:'||NEW.id), 'ENTRADA', COALESCE(l.origem_tipo,NEW.origem_tipo,'CONTA A RECEBER'),
    CASE WHEN UPPER(COALESCE(l.tipo_caixa,''))='CLIENTE' OR NEW.cotista_id IS NOT NULL THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao,l.descricao,''), COALESCE(NEW.categoria_id,l.categoria_share_id,l.categoria_cliente_id),
    COALESCE(NEW.categoria_nome,l.categoria_nome), COALESCE(NEW.banco_recebimento,l.conta_bancaria_id),
    COALESCE(l.data_emissao,NEW.criado_em), NEW.data_vencimento, COALESCE(NEW.data_recebimento,NEW.data_pagamento,l.data_pagamento),
    CASE WHEN UPPER(NEW.status) IN ('PAGO','RECEBIDO') THEN 'PAGO' WHEN UPPER(NEW.status)='CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
    NEW.status, NEW.valor_centavos, COALESCE(NEW.cotista_id,l.cotista_aeronave_id),
    COALESCE(l.numero_doc,l.numero_nf,l.numero_recibo), COALESCE(l.url_nf,l.url_recibo),
    COALESCE(NEW.comprovante_recebimento_url,l.comprovante_url),
    CASE WHEN l.id IS NULL THEN 'contas_areceber' ELSE 'lancamentos' END, CASE WHEN l.id IS NULL THEN NEW.id ELSE l.id END,
    l.id, NEW.id, COALESCE(NEW.criado_em,CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em,CURRENT_TIMESTAMP)
    FROM (SELECT 1) dummy LEFT JOIN lancamentos l ON l.id=NEW.lancamentos_id AND UPPER(COALESCE(l.tipo_caixa,'')) IN ('SHARE','CLIENTE')
    WHERE NEW.movimentos_id IS NULL AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
  ON CONFLICT(id) DO UPDATE SET data_vencimento=excluded.data_vencimento,data_pagamento=excluded.data_pagamento,
    status=excluded.status,status_origem=excluded.status_origem,valor_centavos=excluded.valor_centavos,
    conta_bancaria_id=COALESCE(excluded.conta_bancaria_id,lancamentos_unificados.conta_bancaria_id),
    conta_a_receber_id=excluded.conta_a_receber_id,comprovante_url=COALESCE(excluded.comprovante_url,lancamentos_unificados.comprovante_url),
    atualizado_em=excluded.atualizado_em;
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_contas_areceber_update AFTER UPDATE ON contas_areceber
WHEN NEW.movimentos_id IS NULL AND NEW.valor_centavos > 0
 AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
BEGIN
  INSERT INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, conta_bancaria_id, data_lancamento,
    data_vencimento, data_pagamento, status, status_origem, valor_centavos, cotista_id, numero_documento,
    nf_url, comprovante_url, origem_tipo, origem_id, lancamento_id, conta_a_receber_id, criado_em, atualizado_em
  ) SELECT COALESCE(l.id,'conta_receber:'||NEW.id), 'ENTRADA', COALESCE(l.origem_tipo,NEW.origem_tipo,'CONTA A RECEBER'),
    CASE WHEN UPPER(COALESCE(l.tipo_caixa,''))='CLIENTE' OR NEW.cotista_id IS NOT NULL THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao,l.descricao,''), COALESCE(NEW.categoria_id,l.categoria_share_id,l.categoria_cliente_id),
    COALESCE(NEW.categoria_nome,l.categoria_nome), COALESCE(NEW.banco_recebimento,l.conta_bancaria_id),
    COALESCE(l.data_emissao,NEW.criado_em), NEW.data_vencimento, COALESCE(NEW.data_recebimento,NEW.data_pagamento,l.data_pagamento),
    CASE WHEN UPPER(NEW.status) IN ('PAGO','RECEBIDO') THEN 'PAGO' WHEN UPPER(NEW.status)='CANCELADO' THEN 'CANCELADO' ELSE 'PENDENTE' END,
    NEW.status, NEW.valor_centavos, COALESCE(NEW.cotista_id,l.cotista_aeronave_id),
    COALESCE(l.numero_doc,l.numero_nf,l.numero_recibo), COALESCE(l.url_nf,l.url_recibo),
    COALESCE(NEW.comprovante_recebimento_url,l.comprovante_url),
    CASE WHEN l.id IS NULL THEN 'contas_areceber' ELSE 'lancamentos' END, CASE WHEN l.id IS NULL THEN NEW.id ELSE l.id END,
    l.id, NEW.id, COALESCE(NEW.criado_em,CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em,CURRENT_TIMESTAMP)
    FROM (SELECT 1) dummy LEFT JOIN lancamentos l ON l.id=NEW.lancamentos_id AND UPPER(COALESCE(l.tipo_caixa,'')) IN ('SHARE','CLIENTE')
    WHERE NEW.movimentos_id IS NULL AND NOT EXISTS (SELECT 1 FROM lancamentos lh WHERE lh.id=NEW.lancamentos_id AND UPPER(COALESCE(lh.tipo_caixa,''))='HOLDING')
  ON CONFLICT(id) DO UPDATE SET data_vencimento=excluded.data_vencimento,data_pagamento=excluded.data_pagamento,
    status=excluded.status,status_origem=excluded.status_origem,valor_centavos=excluded.valor_centavos,
    conta_bancaria_id=COALESCE(excluded.conta_bancaria_id,lancamentos_unificados.conta_bancaria_id),
    conta_a_receber_id=excluded.conta_a_receber_id,comprovante_url=COALESCE(excluded.comprovante_url,lancamentos_unificados.comprovante_url),
    atualizado_em=excluded.atualizado_em;
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_envio_insert AFTER INSERT ON envio_despesas
WHEN NEW.lancamento_id IS NULL AND NEW.movimentacao_id IS NULL AND NEW.movimentos_holding_id IS NULL
 AND UPPER(COALESCE(NEW.tipo_caixa,'')) <> 'HOLDING'
 AND UPPER(COALESCE(NEW.status,'')) NOT IN ('CONVERTIDO','CONCLUIDO','CONCLUIDA','CANCELADO','CANCELADA','REJEITADO','REJEITADA')
BEGIN
  INSERT OR IGNORE INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
    data_lancamento, data_vencimento, status, status_origem, valor_centavos, cotista_id, anexos_json,
    observacoes, origem_tipo, origem_id, envio_pagamento_id, solicitacao_compra_id, criado_em, atualizado_em
  ) VALUES (
    'envio_pagamento:'||NEW.id, 'SAIDA', COALESCE(NEW.tipo_despesa,NEW.tipo,'SOLICITACAO_PAGAMENTO'),
    CASE WHEN UPPER(COALESCE(NEW.tipo_caixa,''))='CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao,''), COALESCE(NEW.categoria_cliente_id,NEW.categoria_id), NEW.categoria_nome,
    NEW.fornecedor_id, NEW.fornecedor, NEW.data_despesa, NEW.vencimento,
    CASE WHEN UPPER(COALESCE(NEW.status,'')) IN ('PAGO','RECEBIDO') THEN 'PAGO' WHEN UPPER(COALESCE(NEW.status,'')) IN ('CANCELADO','CANCELADA','REJEITADO','REJEITADA') THEN 'CANCELADO' ELSE 'PENDENTE' END, NEW.status,
    ROUND(COALESCE(NEW.valor_total_despesa,NEW.valor,0)*100), NEW.cotista_id, CASE WHEN json_valid(COALESCE(NEW.anexos_json,'')) THEN NEW.anexos_json ELSE '[]' END,
    NEW.observacoes, 'envio_despesas', NEW.id, NEW.id, NEW.solicitacao_compra_id,
    COALESCE(NEW.criado_em,CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em,CURRENT_TIMESTAMP)
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_envio_update AFTER UPDATE ON envio_despesas
BEGIN
  DELETE FROM lancamentos_unificados WHERE envio_pagamento_id=OLD.id;
  INSERT OR IGNORE INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, categoria_id, categoria, favorecido_id, favorecido,
    data_lancamento, data_vencimento, status, status_origem, valor_centavos, cotista_id, anexos_json,
    observacoes, origem_tipo, origem_id, envio_pagamento_id, solicitacao_compra_id, criado_em, atualizado_em
  ) SELECT 'envio_pagamento:'||NEW.id, 'SAIDA', COALESCE(NEW.tipo_despesa,NEW.tipo,'SOLICITACAO_PAGAMENTO'),
    CASE WHEN UPPER(COALESCE(NEW.tipo_caixa,''))='CLIENTE' THEN 'CLIENTE' ELSE 'SHARE' END,
    COALESCE(NEW.descricao,''), COALESCE(NEW.categoria_cliente_id,NEW.categoria_id), NEW.categoria_nome,
    NEW.fornecedor_id, NEW.fornecedor, NEW.data_despesa, NEW.vencimento,
    CASE WHEN UPPER(COALESCE(NEW.status,'')) IN ('PAGO','RECEBIDO') THEN 'PAGO' WHEN UPPER(COALESCE(NEW.status,'')) IN ('CANCELADO','CANCELADA','REJEITADO','REJEITADA') THEN 'CANCELADO' ELSE 'PENDENTE' END, NEW.status,
    ROUND(COALESCE(NEW.valor_total_despesa,NEW.valor,0)*100), NEW.cotista_id, CASE WHEN json_valid(COALESCE(NEW.anexos_json,'')) THEN NEW.anexos_json ELSE '[]' END,
    NEW.observacoes, 'envio_despesas', NEW.id, NEW.id, NEW.solicitacao_compra_id,
    COALESCE(NEW.criado_em,CURRENT_TIMESTAMP), COALESCE(NEW.atualizado_em,CURRENT_TIMESTAMP)
    WHERE NEW.lancamento_id IS NULL AND NEW.movimentacao_id IS NULL AND NEW.movimentos_holding_id IS NULL
      AND UPPER(COALESCE(NEW.tipo_caixa,'')) <> 'HOLDING'
      AND UPPER(COALESCE(NEW.status,'')) NOT IN ('CONVERTIDO','CONCLUIDO','CONCLUIDA','CANCELADO','CANCELADA','REJEITADO','REJEITADA');
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_envio_delete AFTER DELETE ON envio_despesas
BEGIN DELETE FROM lancamentos_unificados WHERE envio_pagamento_id=OLD.id; END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_compra_insert AFTER INSERT ON solicitacoes_compra
WHEN UPPER(COALESCE(NEW.status,'')) NOT IN ('CONCLUIDA','CONCLUIDO','CANCELADA','CANCELADO','REJEITADA','REJEITADO')
 AND NOT EXISTS (SELECT 1 FROM envio_despesas e WHERE e.solicitacao_compra_id=NEW.id AND (e.lancamento_id IS NOT NULL OR e.movimentos_holding_id IS NOT NULL OR UPPER(COALESCE(e.status,'')) IN ('CONVERTIDO','CONCLUIDO','CONCLUIDA')))
BEGIN
  INSERT OR IGNORE INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, data_lancamento, data_vencimento, status, status_origem,
    valor_centavos, solicitacao_compra_id, origem_tipo, origem_id, favorecido, observacoes, criado_em, atualizado_em
  ) VALUES (
    'solicitacao_compra:'||NEW.id, 'SAIDA', 'SOLICITACAO_COMPRA', 'SHARE', NEW.descricao,
    COALESCE(NEW.data_solicitacao,NEW.data_criacao), NEW.data_necessaria, 'PENDENTE', NEW.status,
    COALESCE((SELECT ROUND(SUM(i.quantidade*i.valor_unitario*100)) FROM itens_solicitacao_compra i WHERE i.solicitacao_compra_id=NEW.id),0),
    NEW.id, 'solicitacoes_compra', NEW.id, COALESCE(NEW.solicitante_nome,NEW.user_id), NEW.observacoes,
    COALESCE(NEW.data_criacao,CURRENT_TIMESTAMP), COALESCE(NEW.data_atualizacao,CURRENT_TIMESTAMP)
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_compra_update AFTER UPDATE ON solicitacoes_compra
BEGIN
  DELETE FROM lancamentos_unificados WHERE solicitacao_compra_id=OLD.id AND origem_tipo='solicitacoes_compra';
  INSERT OR IGNORE INTO lancamentos_unificados (
    id, fluxo, natureza, caixa, descricao, data_lancamento, data_vencimento, status, status_origem,
    valor_centavos, solicitacao_compra_id, origem_tipo, origem_id, favorecido, observacoes, criado_em, atualizado_em
  ) SELECT 'solicitacao_compra:'||NEW.id, 'SAIDA', 'SOLICITACAO_COMPRA', 'SHARE', NEW.descricao,
    COALESCE(NEW.data_solicitacao,NEW.data_criacao), NEW.data_necessaria, 'PENDENTE', NEW.status,
    COALESCE((SELECT ROUND(SUM(i.quantidade*i.valor_unitario*100)) FROM itens_solicitacao_compra i WHERE i.solicitacao_compra_id=NEW.id),0),
    NEW.id, 'solicitacoes_compra', NEW.id, COALESCE(NEW.solicitante_nome,NEW.user_id), NEW.observacoes,
    COALESCE(NEW.data_criacao,CURRENT_TIMESTAMP), COALESCE(NEW.data_atualizacao,CURRENT_TIMESTAMP)
    WHERE UPPER(COALESCE(NEW.status,'')) NOT IN ('CONCLUIDA','CONCLUIDO','CANCELADA','CANCELADO','REJEITADA','REJEITADO')
      AND NOT EXISTS (SELECT 1 FROM envio_despesas e WHERE e.solicitacao_compra_id=NEW.id AND (e.lancamento_id IS NOT NULL OR e.movimentos_holding_id IS NOT NULL OR UPPER(COALESCE(e.status,'')) IN ('CONVERTIDO','CONCLUIDO','CONCLUIDA')));
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_compra_delete AFTER DELETE ON solicitacoes_compra
BEGIN DELETE FROM lancamentos_unificados WHERE solicitacao_compra_id=OLD.id AND origem_tipo='solicitacoes_compra'; END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_itens_compra_insert AFTER INSERT ON itens_solicitacao_compra
BEGIN
  UPDATE lancamentos_unificados
     SET valor_centavos=COALESCE((SELECT ROUND(SUM(i.quantidade*i.valor_unitario)*100) FROM itens_solicitacao_compra i WHERE i.solicitacao_compra_id=NEW.solicitacao_compra_id),0),
         atualizado_em=CURRENT_TIMESTAMP
   WHERE solicitacao_compra_id=NEW.solicitacao_compra_id AND origem_tipo='solicitacoes_compra';
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_itens_compra_update AFTER UPDATE ON itens_solicitacao_compra
BEGIN
  UPDATE lancamentos_unificados
     SET valor_centavos=COALESCE((SELECT ROUND(SUM(i.quantidade*i.valor_unitario)*100) FROM itens_solicitacao_compra i WHERE i.solicitacao_compra_id=NEW.solicitacao_compra_id),0),
         atualizado_em=CURRENT_TIMESTAMP
   WHERE solicitacao_compra_id=NEW.solicitacao_compra_id AND origem_tipo='solicitacoes_compra';
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_itens_compra_delete AFTER DELETE ON itens_solicitacao_compra
BEGIN
  UPDATE lancamentos_unificados
     SET valor_centavos=COALESCE((SELECT ROUND(SUM(i.quantidade*i.valor_unitario)*100) FROM itens_solicitacao_compra i WHERE i.solicitacao_compra_id=OLD.solicitacao_compra_id),0),
         atualizado_em=CURRENT_TIMESTAMP
   WHERE solicitacao_compra_id=OLD.solicitacao_compra_id AND origem_tipo='solicitacoes_compra';
END;

CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_lancamentos_delete AFTER DELETE ON lancamentos
BEGIN
  DELETE FROM lancamentos_unificados WHERE origem_tipo='lancamentos' AND origem_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_contas_apagar_delete AFTER DELETE ON contas_apagar
BEGIN
  UPDATE lancamentos_unificados SET conta_a_pagar_id=NULL, atualizado_em=CURRENT_TIMESTAMP
   WHERE lancamento_id=OLD.lancamentos_id AND conta_a_pagar_id=OLD.id;
  DELETE FROM lancamentos_unificados WHERE id='conta_pagar:'||OLD.id AND origem_tipo='contas_apagar';
END;
CREATE TRIGGER IF NOT EXISTS trg_lanc_unificado_contas_areceber_delete AFTER DELETE ON contas_areceber
BEGIN
  UPDATE lancamentos_unificados SET conta_a_receber_id=NULL, atualizado_em=CURRENT_TIMESTAMP
   WHERE lancamento_id=OLD.lancamentos_id AND conta_a_receber_id=OLD.id;
  DELETE FROM lancamentos_unificados WHERE id='conta_receber:'||OLD.id AND origem_tipo='contas_areceber';
END;
