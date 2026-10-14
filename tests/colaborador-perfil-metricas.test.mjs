import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const workerSource = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')
const start = workerSource.indexOf('async function carregarMetricasColaborador(')
const end = workerSource.indexOf("app.get('/api/colaborador/perfil'", start)
const source = workerSource.slice(start, end)
const profileRouteStart = workerSource.indexOf("app.get('/api/colaborador/perfil'")
const profileRouteEnd = workerSource.indexOf('\nfunction despesasRelatorioViagem', profileRouteStart)
const profileRoute = workerSource.slice(profileRouteStart, profileRouteEnd)
const profilePatchStart = workerSource.indexOf("app.patch('/api/colaborador/perfil'")
const profilePatchEnd = workerSource.indexOf("\napp.get('/api/colaborador/foto'", profilePatchStart)
const profilePatch = workerSource.slice(profilePatchStart, profilePatchEnd)

test('métricas do perfil são calculadas pelo D1 e associadas ao tripulante autenticado', () => {
  assert.notEqual(start, -1, 'helper de métricas deve estar no Worker')
  assert.match(source, /FROM lancamentos_diario_bordo/)
  assert.match(source, /pic_canac/)
  assert.match(source, /sic_canac/)
  assert.match(source, /SUM\(COALESCE\(NULLIF\(tempo_total, 0\), tempo_voo, 0\)\)/)
  assert.match(source, /FROM solicitacoes_reserva_voo/)
  assert.match(source, /status[\s\S]*= 'aprovada'/)
  assert.match(source, /piloto_id = \?1 OR copiloto_id = \?1/)
  assert.match(profileRoute, /metricas,/)
  assert.match(profilePatch, /metricas: await carregarMetricasColaborador/)
})

test('CTM conta reports abertos por UUID, com fallback nominal compatível com o endpoint legado', () => {
  assert.match(source, /FROM pragma_table_info\('relatorios_manutencao'\)/)
  assert.match(source, /\['criado_por', 'created_by', 'reported_by', 'reportado_por', 'user_id', 'usuario_id'\]/)
  assert.match(source, /\['mecanico_responsavel', 'responsavel_tecnico'\]/)
  assert.match(source, /idAuthorColumns\.length > 0/)
  assert.match(source, /const authorColumns = idIsAvailable \? idAuthorColumns : nameAuthorColumns/)
  assert.match(source, /\? `\$\{column\} = \?1`[\s\S]*: `lower\(trim\(COALESCE\(\$\{column\}, ''\)\)\) = lower\(trim\(\?1\)\)`/)
  assert.match(source, /FROM relatorios_manutencao/)
  assert.match(source, /IN \('open', 'aberto'\)/)
})
