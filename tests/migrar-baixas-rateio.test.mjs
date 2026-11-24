import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { planejarMigracao } from '../scripts/migrar-baixas-rateio.mjs'

function banco() {
  const banco = new DatabaseSync(':memory:')
  for (const tabela of ['rateio_despesas', 'rateio_hold']) {
    banco.exec(`CREATE TABLE ${tabela}(id TEXT PRIMARY KEY, valor_pago_real_centavos INTEGER, atualizado_em TEXT);
      INSERT INTO ${tabela} VALUES ('r', 50, NULL);`)
  }
  for (const antiga of ['rateio_pagamentos', 'rateio_hold_pagamentos']) {
    banco.exec(`CREATE TABLE ${antiga}(id TEXT PRIMARY KEY, rateio_id TEXT, valor_centavos INTEGER, status TEXT, comprovante_url TEXT, recibo_id TEXT);
      INSERT INTO ${antiga} VALUES ('p','r',50,'CONFIRMADO','pix.pdf','rec'),
        ('q','r',20,'PENDENTE',NULL,NULL), ('e','r',30,'ESTORNADO',NULL,NULL);`)
  }
  const executar = remover => {
    const sql = planejarMigracao(q => banco.prepare(q).all(), remover)
    banco.exec('BEGIN')
    try { banco.exec(sql); banco.exec('COMMIT') }
    catch (e) { banco.exec('ROLLBACK'); throw e }
  }
  return { banco, executar }
}

test('migra os dois domínios, acompanha o Worker anterior e confere cada coluna antes de remover', () => {
  const { banco: db, executar } = banco()
  db.exec(`CREATE TRIGGER trg_rateio_pagamentos_ai_recalcula AFTER INSERT ON rateio_pagamentos BEGIN
    UPDATE rateio_despesas SET valor_pago_real_centavos = (SELECT SUM(valor_centavos) FROM rateio_pagamentos WHERE status='CONFIRMADO') WHERE id=NEW.rateio_id; END;`)
  executar(false)
  executar(false)
  db.exec(`UPDATE rateio_pagamentos SET status='CANCELADO' WHERE id='q';
    UPDATE rateio_despesas SET baixas_json=json_insert(baixas_json,'$[#]',json('{"id":"novo","status":"CONFIRMADO","valor_centavos":5}'));
    INSERT INTO rateio_pagamentos VALUES ('posterior','r',10,'CONFIRMADO',NULL,NULL);
    DELETE FROM rateio_hold_pagamentos WHERE id='q';`)
  assert.equal(db.prepare('SELECT valor_pago_real_centavos AS total FROM rateio_despesas').get().total, 65)
  executar(true)
  executar(true)
  const parcelas = t => JSON.parse(db.prepare(`SELECT baixas_json FROM ${t}`).get().baixas_json)
  assert.equal(parcelas('rateio_despesas').length, 5)
  assert.equal(parcelas('rateio_hold').length, 2)
  assert.equal(parcelas('rateio_despesas').find(p => p.id === 'q').status, 'CANCELADO')
  assert.equal(parcelas('rateio_hold').find(p => p.id === 'p').recibo_id, 'rec')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%pagamentos'").get().n, 0)
})

test('uma divergência na holding reverte inclusive a exclusão da tabela de clientes', () => {
  const { banco: db, executar } = banco()
  executar(false)
  db.exec("UPDATE rateio_hold SET baixas_json = json_set(baixas_json,'$[0].comprovante_url','outro.pdf')")
  assert.throws(() => executar(true))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rateio_pagamentos').get().n, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rateio_hold_pagamentos').get().n, 3)
})

test('a migração recusa órfãos e a limpeza recusa dependências externas', () => {
  const { banco: db, executar } = banco()
  db.exec("UPDATE rateio_pagamentos SET rateio_id='orfao' WHERE id='p'")
  assert.throws(() => executar(false))
  db.exec("UPDATE rateio_pagamentos SET rateio_id='r' WHERE id='p'")
  executar(false)
  db.exec('CREATE TABLE dependente(id TEXT REFERENCES rateio_pagamentos(id))')
  assert.throws(() => executar(true))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rateio_pagamentos').get().n, 3)
})

test('ambiente sem tabelas antigas recebe apenas as duas colunas de rateio', () => {
  const { banco: db, executar } = banco()
  db.exec('DROP TABLE rateio_pagamentos; DROP TABLE rateio_hold_pagamentos;')
  executar(false)
  executar(true)
  assert.equal(db.prepare('SELECT baixas_json FROM rateio_despesas').get().baixas_json, '[]')
})
