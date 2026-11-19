import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'

const fonte = await readFile(new URL('../src/routes/diarioBordoRoutes.ts', import.meta.url), 'utf8')
const inicio = fonte.indexOf("diarioBordoRoutes.get('/api/interno/diario-bordo/horas-voadas'")
const fim = fonte.indexOf("\ndiarioBordoRoutes.get(", inicio + 1)
const rota = fonte.slice(inicio, fim === -1 ? undefined : fim)

test('endpoint de horas exige autenticação e retorna somente aeronaves ativas', () => {
  assert.ok(inicio > -1)
  assert.match(rota, /requireShareInternal\(c\)/)
  assert.match(rota, /FROM aeronave[\s\S]*?lower\(trim\(COALESCE\(status, ''\)\)\) IN \('ativa', 'ativo', 'active'\)/)
  assert.doesNotMatch(rota, /estimativa|fallback proporcional|75 minutos/i)
})

test('novembro não inclui horas de outubro, aeronave inativa ou lançamento em diário de mês divergente', () => {
  const trecho = rota.match(/db\.prepare\(`(SELECT l\.aeronave_id,[\s\S]*?)`\)\.bind\(ano, ano - 1\)/)
  assert.ok(trecho, 'usa consulta de agregação com ano e diário do mês')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE aeronave (id TEXT PRIMARY KEY, matricula_registro TEXT, fabricante TEXT, modelo TEXT, status TEXT);
      CREATE TABLE diario_mes (id TEXT PRIMARY KEY, aeronave_id TEXT, ano INTEGER, mes INTEGER);
      CREATE TABLE lancamentos_diario_bordo (id TEXT PRIMARY KEY, aeronave_id TEXT, diario_mes_id TEXT, data_registro TEXT, tempo_voo REAL);
      INSERT INTO aeronave VALUES
        ('lrm','PR-LRM','PIPER','PA-46','ATIVA'),
        ('abc','PR-ABC','CIRRUS','SR20','ativa'),
        ('ina','PR-INA','PIPER','PA-34','INATIVA'),
        ('sem','PR-SEM','PIPER','PA-46','ATIVA');
      INSERT INTO diario_mes VALUES
        ('lrm10','lrm',2026,10), ('abc11','abc',2026,11),
        ('ina11','ina',2026,11), ('abc10','abc',2026,10);
      INSERT INTO lancamentos_diario_bordo VALUES
        ('outubro-lrm','lrm','lrm10','2026-10-15',12.42),
        ('novembro-abc','abc','abc11','2026-11-15',1.17),
        ('novembro-inativo','ina','ina11','2026-11-15',5.00),
        ('mes-divergente','abc','abc10','2026-11-16',10.00),
        ('sem-horas','abc','abc11','2026-11-17',0);
    `)
    const dados = db.prepare(trecho[1]).all(2026, 2025)
    const novembro = dados.filter(item => item.data.startsWith('2026-11'))
    assert.deepEqual(novembro.map(item => item.aeronave_id), ['abc'])
    assert.equal(novembro[0].minutos, 70)
    assert.equal(novembro[0].trechos, 1)
    assert.equal(dados.find(item => item.aeronave_id === 'lrm')?.data, '2026-10-15')
    assert.ok(!dados.some(item => item.aeronave_id === 'ina'))
    assert.ok(!dados.some(item => item.data === '2026-11-16'))
    const ativas = db.prepare("SELECT id FROM aeronave WHERE lower(trim(COALESCE(status, ''))) IN ('ativa', 'ativo', 'active')").all()
    assert.deepEqual(ativas.map(item => item.id), ['lrm', 'abc', 'sem'])
  } finally {
    db.close()
  }
})
