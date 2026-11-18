import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { excluirAgendamentoDoBanco } from '../src/lib/agendamentoDelete.ts'

const migration = await readFile(new URL('../migrations/20261118_preparacao_voo.sql', import.meta.url), 'utf8')
const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')

function criarBanco() {
  const banco = new DatabaseSync(':memory:')
  banco.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE solicitacoes_reserva_voo (id TEXT PRIMARY KEY, cliente_id TEXT, socio_id TEXT, status TEXT, numero_voo TEXT);
    CREATE TABLE escala_tripulacao (id TEXT PRIMARY KEY, solicitacao_id TEXT, tripulacao_id TEXT, data_inicio TEXT, data_fim TEXT, status TEXT);
  `)
  banco.exec(migration)
  banco.prepare('INSERT INTO solicitacoes_reserva_voo (id, status) VALUES (?, ?)').run('voo1', 'aprovada')
  banco.prepare('INSERT INTO solicitacoes_reserva_voo (id, status) VALUES (?, ?)').run('voo2', 'aprovada')
  banco.prepare(`INSERT INTO preparacoes_voo (solicitacao_id, versao, comando_id, dados_json, atualizado_por, atualizado_por_nome)
    VALUES ('voo1', 1, 'cmd1', '{}', 'user1', 'Coordenação'), ('voo2', 1, 'cmd2', '{}', 'user2', 'Coordenação')`).run()
  banco.prepare(`INSERT INTO preparacao_voo_versoes (id, solicitacao_id, versao, tipo, snapshot_json, criado_por)
    VALUES ('versao1', 'voo1', 1, 'ATUALIZACAO', '{}', 'user1'), ('versao2', 'voo2', 1, 'ATUALIZACAO', '{}', 'user2')`).run()
  banco.prepare(`INSERT INTO preparacao_voo_reservas (id, solicitacao_id, escala_id, servico_id, requisicao_id, assinatura, reserva_id, payload_json, criado_por)
    VALUES ('reserva1', 'voo1', 'e1', 's1', 'req1', 'hash1', 'hotel1', '{}', 'user1'), ('reserva2', 'voo2', 'e1', 's1', 'req2', 'hash2', 'hotel2', '{}', 'user2')`).run()
  banco.prepare(`INSERT INTO preparacao_voo_abastecimentos (id, solicitacao_id, escala_id, abastecimento_id, criado_por)
    VALUES ('comb1', 'voo1', 'e1', 'abast1', 'user1'), ('comb2', 'voo2', 'e1', 'abast2', 'user2')`).run()
  banco.prepare(`INSERT INTO preparacao_voo_anexos (id, solicitacao_id, servico_id, nome, caminho, mime, tamanho, criado_por)
    VALUES ('anexo1', 'voo1', 's1', 'briefing.pdf', 'share/preparacao_voo/voo1/briefing.pdf', 'application/pdf', 100, 'user1'),
           ('anexo2', 'voo2', 's1', 'outro.pdf', 'share/preparacao_voo/voo2/outro.pdf', 'application/pdf', 100, 'user2')`).run()
  banco.prepare('INSERT INTO escala_tripulacao (id, solicitacao_id) VALUES (?, ?)').run('escala1', 'voo1')
  banco.prepare('INSERT INTO escala_tripulacao (id, solicitacao_id) VALUES (?, ?)').run('escala2', 'voo2')

  const db = {
    prepare(sql) {
      let valores = []
      const comando = {
        bind(...args) { valores = args; return comando },
        async all() { return { results: banco.prepare(sql).all(...valores) } },
        async run() {
          const resultado = banco.prepare(sql).run(...valores)
          return { meta: { changes: Number(resultado.changes) } }
        },
      }
      return comando
    },
    async batch(comandos) {
      banco.exec('BEGIN')
      try {
        const resultados = []
        for (const comando of comandos) resultados.push(await comando.run())
        banco.exec('COMMIT')
        return resultados
      } catch (erro) {
        banco.exec('ROLLBACK')
        throw erro
      }
    },
  }
  return { banco, db }
}

test('rota DELETE usa o helper de exclusão persistente do agendamento', () => {
  const inicio = workerSource.indexOf("app.delete('/api/interno/agendamento/:id'")
  const fim = workerSource.indexOf('\napp.', inicio + 1)
  const rota = workerSource.slice(inicio, fim === -1 ? undefined : fim)
  assert.notEqual(inicio, -1)
  assert.match(rota, /requireShareInternal\(c\)/)
  assert.match(rota, /excluirAgendamentoDoBanco\(db, id\)/)
})

test('exclusão remove o voo e dados de preparação vinculados respeitando as FKs', async () => {
  const { banco, db } = criarBanco()
  try {
    const resultado = await excluirAgendamentoDoBanco(db, 'voo1')
    assert.equal(resultado.excluido, true)
    assert.deepEqual(resultado.anexos, ['share/preparacao_voo/voo1/briefing.pdf'])
    assert.equal(banco.prepare('SELECT COUNT(*) AS total FROM solicitacoes_reserva_voo WHERE id = ?').get('voo1').total, 0)
    for (const tabela of ['preparacoes_voo', 'preparacao_voo_versoes', 'preparacao_voo_reservas', 'preparacao_voo_abastecimentos', 'preparacao_voo_anexos', 'escala_tripulacao']) {
      assert.equal(banco.prepare(`SELECT COUNT(*) AS total FROM ${tabela} WHERE solicitacao_id = ?`).get('voo1').total, 0, `${tabela} deve ser limpa`)
      assert.equal(banco.prepare(`SELECT COUNT(*) AS total FROM ${tabela} WHERE solicitacao_id = ?`).get('voo2').total, 1, `${tabela} de outro voo deve ser preservada`)
    }
  } finally {
    banco.close()
  }
})
