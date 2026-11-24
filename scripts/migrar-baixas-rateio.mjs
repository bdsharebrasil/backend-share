// Preparar antes de publicar o Worker. Remover o legado apenas após a publicação.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dominios = [
  ['rateio_despesas', 'rateio_pagamentos'],
  ['rateio_hold', 'rateio_hold_pagamentos'],
]
const identificador = nome => '"' + nome.replaceAll('"', '""') + '"'
const literal = valor => "'" + valor.replaceAll("'", "''") + "'"

// A importação do arquivo D1 é atômica. Uma falha na conferência reverte o arquivo.
function exigir(condicao, erro) {
  return `SELECT CASE WHEN (${condicao}) THEN 1 ELSE json('${erro}') END;`
}

export function planejarMigracao(consultar, remover = false) {
  const comandos = []
  for (const [rateio, legado] of dominios) {
    const colunas = tabela => consultar(`PRAGMA table_info(${tabela})`).map(c => c.name)
    const destino = colunas(rateio)
    if (!destino.includes('id')) throw new Error(`Rateio ausente: ${rateio}`)
    const preparado = destino.includes('baixas_json')
    if (!preparado) {
      if (remover) throw new Error(`Prepare ${rateio} antes de remover o legado`)
      comandos.push(`ALTER TABLE ${rateio} ADD COLUMN baixas_json TEXT NOT NULL DEFAULT '[]' CHECK (json_type(baixas_json) = 'array');`)
    }
    const campos = colunas(legado)
    if (!campos.length) continue
    if (!['id', 'rateio_id', 'valor_centavos', 'status'].every(c => campos.includes(c))) throw new Error(`Schema inesperado: ${legado}`)
    const trigger = `transicao_${legado}`
    const objeto = alias => `json_object(${campos.map(c => `${literal(c)}, ${alias}.${identificador(c)}`).join(', ')})`
    const espelhado = consultar(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='${trigger}_inserir'`).length > 0
    // Cada campo existente no D1 é copiado, inclusive campos legados opcionais.
    const camposIguais = campos.map(c => `json_extract(j.value, ${literal('$.' + JSON.stringify(c))}) IS p.${identificador(c)}`).join(' AND ')
    const conciliado = `NOT EXISTS (SELECT 1 FROM ${legado} p WHERE
      (SELECT COUNT(*) FROM ${rateio} r, json_each(r.baixas_json) j
        WHERE r.id = p.rateio_id AND ${camposIguais}) <> 1)`
    if (remover) {
      if (!espelhado) throw new Error(`Cópia do legado não verificada: ${legado}`)
      comandos.push(exigir(conciliado, 'Baixa ausente ou divergente'))
      // Evita remover uma tabela referenciada por uma FK, view ou trigger externo.
      comandos.push(exigir(`NOT EXISTS (SELECT 1 FROM sqlite_master
        WHERE type IN ('table','view','trigger') AND name <> '${legado}' AND instr(lower(sql),'${legado}') > 0
        AND name NOT IN ('${trigger}_inserir','${trigger}_atualizar','${trigger}_excluir','${trigger}_rateio'))`, 'Dependencia do legado'))
      comandos.push(`DROP TRIGGER ${trigger}_rateio;`, `DROP TABLE ${legado};`)
      continue
    }
    if (espelhado) continue
    comandos.push(exigir(`NOT EXISTS (SELECT 1 FROM ${rateio} r JOIN ${legado} p ON p.rateio_id=r.id
      WHERE json_array_length(r.baixas_json) <> 0)`, 'Historico preexistente exige conciliacao'))
    comandos.push(`UPDATE ${rateio} AS r SET baixas_json =
      (SELECT json_group_array(${objeto('p')}) FROM ${legado} p WHERE p.rateio_id=r.id)
      WHERE EXISTS (SELECT 1 FROM ${legado} p WHERE p.rateio_id=r.id);`, exigir(conciliado, 'Copia incompleta'))
    // O Worker antigo ainda pode gravar entre a cópia e o deploy.
    // Triggers da versão de setembro recalculavam o total usando só a tabela antiga.
    // Durante a transição o cálculo precisa incluir também as parcelas do novo Worker.
    const recalculos = consultar(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='${legado}'
      AND name IN ('trg_rateio_pagamentos_ai_recalcula','trg_rateio_pagamentos_au_recalcula','trg_rateio_pagamentos_ad_recalcula')`)
    for (const { name } of recalculos) comandos.push(`DROP TRIGGER ${identificador(name)};`)
    const recalcular = ref => recalculos.length ? `UPDATE ${rateio} SET valor_pago_real_centavos =
      (SELECT COALESCE(SUM(json_extract(value,'$.valor_centavos')),0) FROM json_each(baixas_json)
        WHERE json_extract(value,'$.status')='CONFIRMADO'), atualizado_em=CURRENT_TIMESTAMP WHERE id=${ref}.rateio_id;` : ''
    const inserir = `UPDATE ${rateio} SET baixas_json=json_insert(baixas_json,'$[#]',${objeto('NEW')}) WHERE id=NEW.rateio_id;`
    const excluir = `UPDATE ${rateio} SET baixas_json=json_remove(baixas_json,
      (SELECT j.fullkey FROM json_each(baixas_json) j WHERE json_extract(j.value,'$.id')=OLD.id))
      WHERE id=OLD.rateio_id AND EXISTS (SELECT 1 FROM json_each(baixas_json) j WHERE json_extract(j.value,'$.id')=OLD.id);`
    comandos.push(
      `CREATE TRIGGER ${trigger}_inserir AFTER INSERT ON ${legado} BEGIN ${inserir} ${recalcular('NEW')} END;`,
      `CREATE TRIGGER ${trigger}_atualizar AFTER UPDATE ON ${legado} BEGIN ${excluir} ${inserir} ${recalcular('OLD')} ${recalcular('NEW')} END;`,
      `CREATE TRIGGER ${trigger}_excluir AFTER DELETE ON ${legado} BEGIN ${excluir} ${recalcular('OLD')} END;`,
      `CREATE TRIGGER ${trigger}_rateio BEFORE DELETE ON ${rateio} BEGIN DELETE FROM ${legado} WHERE rateio_id=OLD.id; END;`,
    )
  }
  return comandos.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [modo, alvo] = process.argv.slice(2)
  if (!['preparar', 'remover-legado'].includes(modo) || !['--local', '--remote'].includes(alvo)) {
    throw new Error('Uso: node scripts/migrar-baixas-rateio.mjs preparar|remover-legado --local|--remote')
  }
  const wrangler = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url))
  const executar = args => execFileSync(wrangler, ['d1', 'execute', 'bd_sharebrasil', alvo, ...args], { encoding: 'utf8' })
  const consultar = sql => JSON.parse(executar(['--json', '--command', sql]))[0].results
  const sql = planejarMigracao(consultar, modo === 'remover-legado')
  if (sql) {
    const dir = mkdtempSync(join(tmpdir(), 'baixas-rateio-'))
    try {
      const arquivo = join(dir, 'migracao.sql')
      writeFileSync(arquivo, sql)
      process.stdout.write(executar(['--file', arquivo, '--yes']))
    } finally { rmSync(dir, { recursive: true }) }
  }
}
