import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDocumentFields } from '../src/financeiro/FinanceiroKernel.ts'

test('mapeia cada tipo de anexo para número e URL do lançamento', () => {
  const fields = buildDocumentFields([
    { tipo: 'nf', numero: 'NF-10', url: 'nf-url', cotista_id: 'cotista-1' },
    { tipo: 'recibo', numero: 'REC-20', url: 'recibo-url', cotista_id: 'cotista-1' },
    { tipo: 'boleto', numero: 'BOL-30', url: 'boleto-url', cotista_id: 'cotista-1' },
    { tipo: 'comanda', numero: 'COM-40', url: 'comanda-url', cotista_id: 'cotista-1' },
    { tipo: 'demonstrativo', numero: 'DEM-50', url: 'demo-url', cotista_id: 'cotista-1' },
  ], 'cotista-1')

  assert.deepEqual({
    numero_nf: fields.numero_nf,
    numero_recibo: fields.numero_recibo,
    numero_boleto: fields.numero_boleto,
    numero_doc: fields.numero_doc,
    numero_demonstrativo: fields.numero_demonstrativo,
    url_nf: fields.url_nf,
    url_recibo: fields.url_recibo,
    url_boleto: fields.url_boleto,
    url_doc: fields.url_doc,
    url_demonstrativo: fields.url_demonstrativo,
  }, {
    numero_nf: 'NF-10',
    numero_recibo: 'REC-20',
    numero_boleto: 'BOL-30',
    numero_doc: 'COM-40',
    numero_demonstrativo: 'DEM-50',
    url_nf: 'nf-url',
    url_recibo: 'recibo-url',
    url_boleto: 'boleto-url',
    url_doc: 'comanda-url',
    url_demonstrativo: 'demo-url',
  })
})

test('filtra anexo atribuído a outro cotista e mantém anexos gerais', () => {
  const fields = buildDocumentFields([
    { tipo: 'nf', numero: 'NF-OUTRA', url: 'outro-url', cotista_id: 'cotista-2' },
    { tipo: 'boleto', numero: 'BOL-GERAL', url: 'geral-url' },
  ], 'cotista-1')

  assert.equal(fields.numero_nf, null)
  assert.equal(fields.numero_boleto, 'BOL-GERAL')
  assert.equal(fields.url_boleto, 'geral-url')
})
