import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { carregarBalancoOperacional } from '../src/financeiro/balancoOperacional.ts'

function d1(sqlite) {
  return { prepare(sql) {
    let params = []
    return {
      bind(...values) { params = values; return this },
      async all() { return { results: sqlite.prepare(sql).all(...params) } },
    }
  } }
}

test('SQL real inclui voo de teste sem titular e mantém holding, tripulação, período e aeronave', async () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(`CREATE TABLE lancamentos_diario_bordo (
      id TEXT, aeronave_id TEXT, data_registro TEXT, tempo_total REAL,
      holding_id TEXT, natureza_voo TEXT, pic_nome TEXT, sic_nome TEXT, distancia_nm REAL);
      INSERT INTO lancamentos_diario_bordo VALUES ('teste', 'jpk', '2026-08-28', 0.42, NULL, 'VT - Voo Teste', 'Piloto', 'Copiloto', 0);
      INSERT INTO lancamentos_diario_bordo VALUES ('holding', 'jpk', '2026-08-29', 1, 'holding-1', 'VP - Voo Particular', 'Piloto', NULL, 20);
      INSERT INTO lancamentos_diario_bordo VALUES ('outra-aeronave', 'bic', '2026-08-28', 2, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO lancamentos_diario_bordo VALUES ('fora-do-mes', 'jpk', '2026-09-01', 3, NULL, NULL, NULL, NULL, NULL);`)
    const columns = sqlite.prepare("PRAGMA table_info('lancamentos_diario_bordo')").all().map((c) => c.name)
    const result = await carregarBalancoOperacional(d1(sqlite), new Map([['lancamentos_diario_bordo', new Set(columns)]]), 'jpk', '2026-08-01', '2026-08-31')
    assert.equal(result.fontes.voos, true, 'cliente_id e socio_id ausentes não desativam todo o diário')
    assert.deepEqual(result.voos.map((v) => v.id), ['teste', 'holding'])
    assert.equal(result.voos[0].clienteId, null)
    assert.equal(result.voos[0].natureza, 'VT - Voo Teste')
    assert.equal(result.voos[0].horas, 0.42)
    assert.equal(result.voos[0].comandante, 'Piloto')
    assert.equal(result.voos[0].copiloto, 'Copiloto')
    assert.equal(result.voos[0].distanciaNm, 0)
    assert.equal(result.voos[1].holdingId, 'holding-1')
    assert.equal(result.voos[1].tempoAc, null, 'coluna opcional ausente permanece indisponível')
  } finally { sqlite.close() }
})

test('cota inativa não participa do compartilhamento; IDs de cotistas históricos são preservados', async () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(`CREATE TABLE cotista_aeronave (id TEXT, aeronave_id TEXT, cliente_id TEXT, socio_id TEXT, percentual_sociedade REAL, status TEXT);
      CREATE TABLE cliente (id TEXT, razao_social TEXT);
      CREATE TABLE hold_socios (id TEXT, nome TEXT, holding_id TEXT);
      INSERT INTO cotista_aeronave VALUES ('a', 'jpk', 'cliente-a', NULL, 100, 'ativo'), ('b', 'jpk', 'cliente-b', NULL, 50, 'inativo');
      INSERT INTO cliente VALUES ('cliente-a', 'Santa Rosa'), ('cliente-b', 'Antigo cotista');`)
    const columns = sqlite.prepare("PRAGMA table_info('cotista_aeronave')").all().map((c) => c.name)
    const result = await carregarBalancoOperacional(d1(sqlite), new Map([['cotista_aeronave', new Set(columns)]]), 'jpk')
    assert.equal(result.cotistas.find((c) => c.id === 'a').percentualSociedade, 100)
    assert.equal(result.cotistas.find((c) => c.id === 'b').percentualSociedade, null)
  } finally { sqlite.close() }
})
