import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const route = await readFile(new URL('../src/routes/diarioBordoRoutes.ts', import.meta.url), 'utf8')

test('opções do Diário de Bordo disponibilizam fornecedores de combustível para busca por nome', () => {
  assert.match(route, /SELECT id, nome_fornecedor FROM fornecedores_combustivel ORDER BY nome_fornecedor/)
  assert.match(route, /fornecedores_combustivel: fornecedoresCombustivel\.results/)
})

test('novo abastecimento do Diário persiste tipo, valores e fornecedor e retorna seu id para anexos', () => {
  assert.match(route, /valor_unitario, valor_total, fornecedor_id, status/)
  assert.match(route, /diarioText\(abastecimento\.tipo_combustivel\)/)
  assert.match(route, /diarioText\(abastecimento\.fornecedor_id\)/)
  assert.match(route, /abastecimento_id: abastecimentoIdResposta/)
  assert.match(route, /fornecedor_id=\?, status/)
})

test('referência de fornecedor é validada antes da gravação no diário', () => {
  assert.match(route, /tabela: 'fornecedores_combustivel', valor: abastecimento\?\.fornecedor_id/)
})
