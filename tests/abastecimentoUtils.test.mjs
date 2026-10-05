import test from 'node:test'
import assert from 'node:assert/strict'
import { METADADOS_CATEGORIA_ABASTECIMENTO, normalizarVooEmprestado, resolverTitularAbastecimento } from '../src/abastecimentoUtils.ts'

test('usa categoria COMBUSTÍVEIS e grupo CAIXA CLIENTE nos lançamentos de abastecimento', () => {
  assert.deepEqual(METADADOS_CATEGORIA_ABASTECIMENTO.lancamentos, {
    categoriaNome: 'COMBUSTÍVEIS',
    grupoCategoria: 'CAIXA CLIENTE',
  })
  assert.deepEqual(METADADOS_CATEGORIA_ABASTECIMENTO.holding, {
    categoriaNome: 'COMBUSTÍVEIS',
    grupoCategoria: 'COMBUSTÍVEIS',
  })
})

test('normaliza representações booleanas sem tratar a string "false" como empréstimo', () => {
  for (const valor of [true, 1, '1', 'true', 'sim', 'yes']) {
    assert.equal(normalizarVooEmprestado(valor), true, `${String(valor)} deve representar voo emprestado`)
  }
  for (const valor of [false, 0, '0', 'false', 'não', null, undefined]) {
    assert.equal(normalizarVooEmprestado(valor), false, `${String(valor)} deve representar voo não emprestado`)
  }
})

test('false informado na edição substitui o estado emprestado do diário', () => {
  assert.equal(normalizarVooEmprestado(false, true), false)
  assert.equal(normalizarVooEmprestado('false', 1), false)
  assert.equal(normalizarVooEmprestado(undefined, '1'), true)
})

test('ao desmarcar empréstimo, substitui cliente e sócio pelo titular proprietário sem manter o tomador', () => {
  const diario = {
    cliente_id: 'cliente-proprietario',
    socio_id: null,
    cliente_tomador_emprestimo_id: null,
    socio_tomador_emprestimo_id: 'socio-tomador',
  }
  assert.deepEqual(
    resolverTitularAbastecimento(false, diario, { cliente_id: null, socio_id: 'socio-tomador' }),
    { cliente_id: 'cliente-proprietario', socio_id: null },
  )
})

test('ao desmarcar empréstimo, também substitui tomador cliente pelo sócio proprietário', () => {
  const diario = {
    cliente_id: null,
    socio_id: 'socio-proprietario',
    cliente_tomador_emprestimo_id: 'cliente-tomador',
    socio_tomador_emprestimo_id: null,
  }
  assert.deepEqual(
    resolverTitularAbastecimento(false, diario, { cliente_id: 'cliente-tomador', socio_id: null }),
    { cliente_id: null, socio_id: 'socio-proprietario' },
  )
})

test('mantém o tomador do tipo correto quando o voo continua emprestado', () => {
  const diario = {
    cliente_id: 'cliente-proprietario',
    socio_id: null,
    cliente_tomador_emprestimo_id: null,
    socio_tomador_emprestimo_id: 'socio-tomador',
  }
  assert.deepEqual(
    resolverTitularAbastecimento(true, diario, { cliente_id: null, socio_id: 'socio-tomador' }),
    { cliente_id: null, socio_id: 'socio-tomador' },
  )
})

test('preserva o titular informado quando o diário não define proprietário ou tomador', () => {
  const titularInformado = { cliente_id: 'cliente-manual', socio_id: null }
  assert.deepEqual(resolverTitularAbastecimento(false, { cliente_id: null, socio_id: null }, titularInformado), titularInformado)
  assert.deepEqual(resolverTitularAbastecimento(true, null, titularInformado), titularInformado)
})
