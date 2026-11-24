type Rateio = 'rateio_despesas' | 'rateio_hold'
type Baixa = Record<string, unknown> & { rateio_id: unknown }

// A parcela pertence ao rateio. O detalhamento preserva datas, pagadores e
// comprovantes diferentes sem criar outra movimentação de caixa.
const campos = ['id', 'conta_receber_id', 'tipo_pagador', 'pagador_cotista_id',
  'pagador_holding_id', 'valor_centavos', 'data_pagamento', 'conta_bancaria_id',
  'comprovante_url', 'forma_pagamento', 'idempotency_key',
  'criado_por', 'criado_em']

export function parcelasDoRateio(tabela: Rateio): string {
  const colunas = campos.map(campo => `json_extract(parcela.value, '$.${campo}') AS ${campo}`)
  return `(SELECT rateio.id AS rateio_id, ${colunas.join(', ')},
      CASE WHEN json_extract(parcela.value, '$.aprovada_em') IS NOT NULL THEN 'CANCELADO'
           ELSE json_extract(parcela.value, '$.status') END AS status,
      CASE WHEN json_extract(parcela.value, '$.aprovada_em') IS NOT NULL
           THEN COALESCE(json_extract(parcela.value, '$.observacoes'), '') || ' [Solicitação aprovada; baixa conciliada pelo financeiro]'
           ELSE json_extract(parcela.value, '$.observacoes') END AS observacoes
    FROM ${tabela} rateio JOIN json_each(rateio.baixas_json) parcela)`
}

export function registrarParcela(db: D1Database, tabela: Rateio, baixa: Baixa) {
  return db.prepare(`UPDATE ${tabela}
    SET baixas_json = json_insert(baixas_json, '$[#]', json(?))
    WHERE id = ?`).bind(JSON.stringify({ criado_em: new Date().toISOString(), ...baixa }), baixa.rateio_id)
}
