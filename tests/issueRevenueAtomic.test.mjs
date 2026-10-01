import test from 'node:test'
import assert from 'node:assert/strict'
import { issueRevenue } from '../src/financeiro/FinanceiroKernel.ts'

const schemaColumns = [
  'id', 'descricao', 'fluxo', 'valor_centavos', 'valor_total', 'valor', 'status',
  'tipo_caixa', 'natureza', 'aeronave_id', 'cotista_aeronave_id', 'cotista_id',
  'cliente_id', 'socio_id', 'holding_id', 'categoria_id', 'categoria_cliente_id',
  'categoria_nome', 'grupo_categoria', 'data_emissao', 'data_vencimento',
  'origem_tipo', 'origem_id', 'idempotency_key', 'criado_por', 'atualizado_em',
  'categoria_despesa_subcategoria', 'pago_por', 'pago_diretamente',
  'percentual_sociedade', 'percentual_uso', 'valor_rateado_centavos',
  'valor_pago_real_centavos', 'tipo_rateio', 'periodicidade', 'numero_recibo',
  'url_recibo', 'valor_rateado', 'valor_total_centavos', 'fornecedor_nome',
  'fornecedores_favoritos_id', 'colaborador_id', 'subcategoria_1', 'subcategoria_2',
  'subcategoria_3', 'subcategoria_4', 'fornecedor_id', 'observacoes',
  'valor_anterior_centavos', 'valor_novo_centavos', 'entidade', 'entidade_id',
  'operacao', 'usuario_id', 'motivo', 'lancamento_id', 'conta_receber_id',
  'movimento_id', 'movimento_holding_id', 'recibo_id', 'pagador_cotista_id',
  'pagador_holding_id', 'data_pagamento', 'conta_bancaria_id', 'comprovante_url',
  'forma_pagamento', 'numero_nf', 'url_nf', 'numero_boleto', 'url_boleto',
  'numero_doc', 'url_doc', 'numero_demonstrativo', 'url_demonstrativo', 'email_enviado_em',
]

class FakeStatement {
  constructor(db, sql) {
    this.db = db
    this.sql = sql
    this.values = []
  }

  bind(...values) {
    this.values = values
    return this
  }

  async all() {
    const schema = this.sql.match(/pragma_table_info\('([^']+)'\)/)
    if (schema) return { results: schemaColumns.map((name) => ({ name })) }
    return { results: [] }
  }

  async first() {
    if (this.sql.includes('FROM cotista_aeronave ca')) {
      return {
        cotista_aeronave_id: 'cotista-1',
        aeronave_id: 'aircraft-1',
        cliente_id: 'client-1',
        socio_id: null,
        percentual_sociedade: 100,
        holding_id: null,
        nome: 'Cliente de teste',
      }
    }
    return null
  }
}

function fakeDb() {
  return {
    batches: [],
    prepare(sql) {
      return new FakeStatement(this, sql)
    },
    async batch(statements) {
      this.batches.push(statements)
      return statements.map(() => ({ success: true }))
    },
  }
}

test('inclui nota fiscal e vínculo da conta na mesma transação D1 da receita Share', async () => {
  const db = fakeDb()
  const result = await issueRevenue(db, {
    idempotency_key: 'nf_saida:request-1',
    valor_centavos: 719000,
    descricao: 'NFSE 122 - serviço',
    data: '2026-10-01',
    data_vencimento: '2026-10-05',
    aeronave_id: 'aircraft-1',
    cotista_aeronave_id: 'cotista-1',
    categoria_id: 'category-share',
    categoria_nome: 'ADM E PILOTAGEM - N.F',
    categoria_cliente_id: 'category-client',
    categoria_cliente_nome: 'ADM E TRIP SHARE BRASIL',
    categoria_despesa_subcategoria: 'ADM E PILOTAGEM',
    origem_tipo: 'NF_SAIDA',
    origem_id: 'invoice-1',
    periodicidade: 'MENSAL',
  }, null, { internal: true }, ({ lancamentoId, contaReceberId }) => [
    db.prepare('INSERT INTO notas_fiscais_saida (id, lancamentos_id) VALUES (?, ?)')
      .bind('invoice-1', lancamentoId),
    db.prepare('UPDATE contas_areceber SET nf_saida_id = ? WHERE id = ?')
      .bind('invoice-1', contaReceberId),
  ])

  assert.equal(db.batches.length, 1)
  const committedSql = db.batches[0].map((statement) => statement.sql)
  assert.ok(committedSql.some((sql) => sql.startsWith('INSERT INTO lancamentos ')))
  assert.ok(committedSql.some((sql) => sql.startsWith('INSERT INTO contas_areceber ')))
  assert.ok(committedSql.some((sql) => sql.startsWith('INSERT INTO rateio_despesas ')))
  assert.ok(committedSql.some((sql) => sql.startsWith('INSERT INTO notas_fiscais_saida ')))
  assert.ok(committedSql.some((sql) => sql.startsWith('UPDATE contas_areceber ')))
  assert.equal(result.idempotent, false)
})
