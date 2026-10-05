import test from 'node:test'
import assert from 'node:assert/strict'
import { selecionarColunaOpcional } from '../src/financeiro/schemaSql.ts'

const schema = new Map([
  ['rateio_hold', new Set(['numero_doc', 'documento_numero', 'documento_url'])],
])

test('projeta somente colunas documentais presentes no D1 e preserva alias estável', () => {
  assert.equal(
    selecionarColunaOpcional(schema, 'rateio_hold', 'rh', ['numero_nf'], 'rateio_numero_nf'),
    'NULL AS rateio_numero_nf',
  )
  assert.equal(
    selecionarColunaOpcional(schema, 'rateio_hold', 'rh', ['numero_nf', 'numero_doc', 'documento_numero'], 'rateio_numero_doc'),
    'COALESCE(rh.numero_doc, rh.documento_numero) AS rateio_numero_doc',
  )
  assert.equal(
    selecionarColunaOpcional(schema, 'rateio_hold', 'rh', ['url_doc', 'documento_url'], 'rateio_url_doc'),
    'rh.documento_url AS rateio_url_doc',
  )
})

test('não aceita identificador SQL fora do conjunto de nomes simples', () => {
  assert.throws(
    () => selecionarColunaOpcional(schema, 'rateio_hold; DROP TABLE rateio_hold', 'rh', ['numero_doc'], 'doc'),
    /identificador_sql_invalido/,
  )
})
