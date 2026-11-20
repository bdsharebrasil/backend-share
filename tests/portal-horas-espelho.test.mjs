import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { temposVooPortal, percentualVooCotistaPortal, voosDoCotistaPortal } from '../src/financeiro/portalHoras.ts'
import { resumoCustosPortal, grupoCustoPortal } from '../src/financeiro/portalCustos.ts'

const ativos = [
  { id: 'cota-a', cliente_id: 'cliente-a', socio_id: null, percentual_sociedade: 60, status: 'ativo' },
  { id: 'cota-b', cliente_id: 'cliente-b', socio_id: null, percentual_sociedade: 40, status: 'ativa' },
  { id: 'cota-inativa', cliente_id: null, socio_id: 'socio-c', percentual_sociedade: 30, status: 'inativo' },
]
const base = { data_registro: '2026-10-04', mes: '2026-10', tempo_ac: '23:20', tempo_cor: '00:50',
  tempo_dep: '23:30', tempo_pou: '00:30', tempo_total: 99, tempo_voo: 88 }

test('AC–COR é custo operacional e DEP–POU é voo, inclusive cruzando meia-noite', () => {
  const t = temposVooPortal(base)
  assert.equal(t.minutosOperacionais, 90)
  assert.equal(t.minutosVoo, 60)
  assert.deepEqual(temposVooPortal({ tempo_total: .4, tempo_voo: .25 }),
    { minutosOperacionais: 24, minutosVoo: 15 })
  assert.equal(temposVooPortal({ tempo_dep: '11:00', tempo_pou: '12:00' }).minutosOperacionais, null)
})

test('TR e VT são compartilhados em partes iguais entre cotistas ativos, sem contar inativos', () => {
  for (const natureza of ['TR - TRASLADO', 'VT - VOO TESTE']) {
    const voo = { ...base, natureza_voo: natureza, voo_emprestado: 0 }
    assert.equal(percentualVooCotistaPortal(voo, ativos[0], ativos), 50)
    assert.equal(percentualVooCotistaPortal(voo, ativos[1], ativos), 50)
    assert.equal(percentualVooCotistaPortal(voo, ativos[2], ativos), 0)
  }
})

test('empréstimo sempre pertence ao tomador, nunca ao cedente', () => {
  const voo = { ...base, cliente_id: 'cliente-b', voo_emprestado: 1, cliente_tomador_emprestimo_id: 'cliente-a' }
  assert.equal(percentualVooCotistaPortal(voo, ativos[0], ativos), 100)
  assert.equal(percentualVooCotistaPortal(voo, ativos[1], ativos), 0)
  assert.equal(percentualVooCotistaPortal({ ...voo, cliente_tomador_emprestimo_id: null }, ativos[1], ativos), 0)
})

test('voo particular sem titular não é automaticamente atribuído à única cota', () => {
  const semTitular = { ...base, voo_emprestado: 0, cliente_id: null, socio_id: null }
  assert.equal(voosDoCotistaPortal([semTitular], ativos[0], [ativos[0]]).length, 0)
})

test('divisão de custos utiliza o tempo operacional atribuído a cada cotista', () => {
  const voos = [
    { ...base, id: 'particular', cliente_id: 'cliente-a', voo_emprestado: 0 },
    { ...base, id: 'tr', natureza_voo: 'TR - TRASLADO', voo_emprestado: 0 },
  ]
  const daAeronave = resumoCustosPortal(
    [{ mes: '2026-10', categoria_nome: 'COMBUSTÍVEIS', valor_rateado_centavos: 120000 }],
    voos, ['2026-10'])
  const daCota = resumoCustosPortal(
    [{ mes: '2026-10', categoria_nome: 'COMBUSTÍVEIS', valor_rateado_centavos: 60000 }],
    voosDoCotistaPortal(voos, ativos[0], ativos), ['2026-10'])
  assert.equal(daAeronave.minutos_operacionais, 180)
  assert.equal(daCota.minutos_operacionais, 135)
  assert.equal(daAeronave.minutos_voo, 120)
  assert.equal(daCota.minutos_voo, 90)
  assert.equal(daAeronave.custo_hora_centavos, 40000)
  assert.equal(daCota.custo_hora_centavos, Math.round(60000 * 60 / 135))
})

test('classificação reconhece mesmas categorias do Financeiro e ignora tipo de rateio', () => {
  for (const categoria of ['MANUTENÇÃO AERONAVE', 'COMBUSTÍVEIS', 'DESPESAS DE VIAGEM',
    'TAXAS AEROPORTUÁRIAS E NAVEGAÇÃO AÉREA']) {
    assert.equal(grupoCustoPortal({ categoria_nome: categoria, tipo_rateio: 'FIXO' }), 'variaveis')
    assert.equal(grupoCustoPortal({ categoria_nome: categoria, tipo_rateio: 'EXTRA' }), 'variaveis')
  }
  assert.equal(grupoCustoPortal({ categoria_nome: 'ADM E TRIP SHARE BRASIL' }), 'fixos')
})

test('todos os cálculos de competência de custos usam data de emissão', async () => {
  const source = await readFile(new URL('../src/financeiro/portalCustos.ts', import.meta.url), 'utf8')
  const mensal = await readFile(new URL('../src/financeiro/balancoMensalRoutes.ts', import.meta.url), 'utf8')
  const portal = await readFile(new URL('../src/routes/portalClienteExtrasRoutes.ts', import.meta.url), 'utf8')
  const migration = await readFile(new URL('../migrations/20261120_balanco_competencia_emissao.sql', import.meta.url), 'utf8')
  assert.match(source, /substr\(r\.data_emissao, 1, 7\)/)
  assert.match(mensal, /competencia: competencia\(r\.emissao\)/)
  assert.match(portal, /const mesExpr = "substr\(r\.data_emissao, 1, 7\)"/)
  assert.doesNotMatch(migration, /data_competencia_demonstrativo/)
})
