import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { statusLancamentoFinanceiro, STATUS_LANCAMENTO } from '../src/financeiro/statuses.ts'

test('status de lançamento é derivado como EM_ATRASO somente quando está aberto e vencido', () => {
  const hoje = new Date('2026-10-06T12:00:00.000Z')

  assert.equal(statusLancamentoFinanceiro('EM_ABERTO', '2026-10-05', hoje), 'EM_ATRASO')
  assert.equal(statusLancamentoFinanceiro('EM_ABERTO', '2026-10-06', hoje), 'EM_ABERTO')
  assert.equal(statusLancamentoFinanceiro('PAGO', '2026-10-05', hoje), 'PAGO')
  assert.equal(statusLancamentoFinanceiro('CANCELADO', '2026-10-05', hoje), 'CANCELADO')
})

test('o contrato de lançamento contém somente estados persistidos pelo código', () => {
  assert.deepEqual(STATUS_LANCAMENTO, ['EM_ABERTO', 'PAGO', 'RECEBIDO', 'CANCELADO'])
  assert.doesNotMatch(STATUS_LANCAMENTO.join(','), /EM_ATRASO/)
})

test('o PATCH valida o contrato canônico de lançamento', async () => {
  const source = await readFile(new URL('../src/financeiroRoutes.ts', import.meta.url), 'utf8')

  assert.match(source, /STATUS_LANCAMENTO\.includes\(String\(body\.status\)\.toUpperCase\(\)[^\)]*\)/)
  assert.doesNotMatch(source, /PENDENTE.*EM_ATRASO|EM_ATRASO.*PENDENTE/)
})

test('a migração converte estados legados para EM_ABERTO sem alterar estados fechados', async () => {
  const migration = await readFile(new URL('../migrations/20261006_lancamentos_status_derived.sql', import.meta.url), 'utf8')

  assert.match(migration, /UPDATE lancamentos\s+SET status = 'EM_ABERTO'\s+WHERE status = 'EM_ATRASO'/)
  assert.doesNotMatch(migration, /UPDATE lancamentos SET status = 'EM_ATRASO'/)
})
test('o schema canônico separa fluxo, natureza e ciclo de vida', async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
  const inicio = schema.indexOf('CREATE TABLE lancamentos (')
  const fim = schema.indexOf('CREATE TABLE lancamentos_diario_bordo', inicio)
  const tabela = schema.slice(inicio, fim)
  assert.match(tabela, /fluxo TEXT NOT NULL[\s\S]*CHECK \(fluxo IN \([\s\S]*''ENTRADA''[\s\S]*''SAIDA''[\s\S]*\)/)
  assert.match(tabela, /status[\s\S]*CHECK \(status IN \([\s\S]*''EM_ABERTO''[\s\S]*''PAGO''[\s\S]*''RECEBIDO''[\s\S]*''CANCELADO''[\s\S]*\)/)
  assert.doesNotMatch(tabela, /fluxo IN \([\s\S]*''RECEITA''|status[\s\S]*''AGUARDANDO_REEMBOLSO''/)
})
test('a migração adiciona natureza e fecha os contratos no banco ativo', async () => {
  const migration = await readFile(new URL('../migrations/20261006_lancamentos_fluxo_canonico.sql', import.meta.url), 'utf8')
  assert.match(migration, /ADD COLUMN natureza TEXT NOT NULL DEFAULT 'DESPESA'/)
  assert.match(migration, /trg_lancamentos_fluxo_canonico_insert/)
  assert.match(migration, /trg_lancamentos_status_canonico_insert/)
})
