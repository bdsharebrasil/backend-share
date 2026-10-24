import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { agendamentoPermiteCompletarHorarios, agendamentoPermiteIniciarJornada, agruparJornadasVoo, checklistPreVooConcluido, determinarStatusAgendamentoVoo } from '../src/routes/jornadasRoutes.ts'

test('preserva cada jornada legada sem jornada principal como registro independente', () => {
  const registros = [
    { id: 'jornada-3', numero_jornada: 3, data: '2026-09-12', jornada_principal_id: null, funcao_tripulante: 'PIC' },
    { id: 'jornada-2', numero_jornada: 2, data: '2026-09-10', jornada_principal_id: null, funcao_tripulante: 'PIC' },
    { id: 'jornada-1', numero_jornada: 1, data: '2026-09-08', jornada_principal_id: null, funcao_tripulante: 'PIC' },
  ]

  const grupos = agruparJornadasVoo(registros)

  assert.deepEqual(grupos.map((grupo) => grupo.raizId), ['jornada-3', 'jornada-2', 'jornada-1'])
  assert.deepEqual(grupos.map((grupo) => grupo.registros.length), [1, 1, 1])
})

test('agrupa PIC e SIC vinculados à mesma jornada-raiz sem duplicar o histórico', () => {
  const registros = [
    { id: 'jornada-pic', numero_jornada: 1, data: '2026-09-08', jornada_principal_id: null, funcao_tripulante: 'PIC' },
    { id: 'jornada-sic', numero_jornada: 1, data: '2026-09-08', jornada_principal_id: 'jornada-pic', funcao_tripulante: 'SIC' },
  ]

  const grupos = agruparJornadasVoo(registros)

  assert.equal(grupos.length, 1)
  assert.equal(grupos[0].raizId, 'jornada-pic')
  assert.equal(grupos[0].representante.id, 'jornada-pic')
  assert.equal(grupos[0].registros.length, 2)
})

test('deriva status operacional do último evento registrado na jornada', () => {
  assert.equal(determinarStatusAgendamentoVoo('aprovada', 'acionado'), 'acionado')
  assert.equal(determinarStatusAgendamentoVoo('acionado', 'decolado'), 'decolado')
  assert.equal(determinarStatusAgendamentoVoo('decolado', 'em_solo'), 'em_solo')
  assert.equal(determinarStatusAgendamentoVoo('em_rota', null), 'decolado')
  assert.equal(determinarStatusAgendamentoVoo('aprovada', null), 'aprovada')
})

test('preserva estados terminais e não chama jornada sem pouso registrado de em_solo', () => {
  assert.equal(determinarStatusAgendamentoVoo('aprovada', null), 'aprovada')
  assert.equal(determinarStatusAgendamentoVoo('acionado', null), 'acionado')
  assert.equal(determinarStatusAgendamentoVoo('decolado', null), 'decolado')
  assert.equal(determinarStatusAgendamentoVoo('pendente', 'em_solo'), 'pendente')
  assert.equal(determinarStatusAgendamentoVoo('encerrada', 'em_solo'), 'encerrada')
})

test('somente checklist pré-voo concluído libera o início da jornada', () => {
  assert.equal(checklistPreVooConcluido(null), false)
  assert.equal(checklistPreVooConcluido('rascunho'), false)
  assert.equal(checklistPreVooConcluido(' CONCLUIDO '), true)
})

test('permite nova jornada em agendamentos aprovados ou com operação iniciada', () => {
  for (const status of ['aprovada', 'acionado', 'decolado', 'em_voo', 'em voo', 'em_solo', 'em_rota']) {
    assert.equal(agendamentoPermiteIniciarJornada(status), true, `status ${status}`)
  }
  for (const status of ['pendente', 'encerrada', 'cancelada', 'reprovada']) {
    assert.equal(agendamentoPermiteIniciarJornada(status), false, `status ${status}`)
  }
})

test('iniciar jornada não exige ficha de peso e balanceamento concluída', async () => {
  const source = await readFile(new URL('../src/routes/jornadasRoutes.ts', import.meta.url), 'utf8')
  const inicio = source.indexOf("jornadasRoutes.post('/api/interno/agendamento/:id/jornada'")
  const proximaRota = source.indexOf('\njornadasRoutes.', inicio + 1)
  const endpoint = source.slice(inicio, proximaRota === -1 ? undefined : proximaRota)

  assert.notEqual(inicio, -1)
  assert.match(endpoint, /checklist_pre_voo_obrigatorio/)
  assert.doesNotMatch(endpoint, /ctm_ficha_peso_balanceamento|peso_balanceamento_obrigatorio|pesoBalanceamentoConcluido/)
})

test('permite editar horários a partir do acionamento ou decolagem, mas não fora da operação', async () => {
  for (const status of ['acionado', 'decolado', 'em_voo', 'em voo', 'em_rota', 'em rota', 'em_solo', 'em solo', 'pousado']) {
    assert.equal(agendamentoPermiteCompletarHorarios(status), true, `status ${status}`)
  }
  for (const status of ['aprovada', 'encerrada', 'concluida', 'cancelada', 'reprovada']) {
    assert.equal(agendamentoPermiteCompletarHorarios(status), false, `status ${status}`)
  }

  const source = await readFile(new URL('../src/routes/jornadasRoutes.ts', import.meta.url), 'utf8')
  const inicio = source.indexOf("jornadasRoutes.patch('/api/interno/jornadas/:jornadaId/pernas/:pernaId'")
  const proximaRota = source.indexOf('\njornadasRoutes.', inicio + 1)
  const endpoint = source.slice(inicio, proximaRota === -1 ? undefined : proximaRota)
  assert.notEqual(inicio, -1)
  assert.match(endpoint, /requireFlightOperationAccess\(c, jornadaAcesso\.solicitacao_id\)/)
  assert.match(endpoint, /agendamentoPermiteCompletarHorarios\(jornadaAcesso\.status_agendamento\)/)
  assert.match(endpoint, /!body \|\| typeof body !== 'object' \|\| Array\.isArray\(body\)/)
  assert.doesNotMatch(endpoint, /campos_restritos/)
  assert.doesNotMatch(endpoint, /isInternalRequest/)
  assert.match(endpoint, /perna\.lancamento_diario_id/)
})

test('sincronização do resumo lê horario_dep antes de preservar a fase AC', async () => {
  const source = await readFile(new URL('../src/routes/jornadasRoutes.ts', import.meta.url), 'utf8')
  assert.match(source, /SELECT horario_ac, horario_dep, horario_pouso, horario_corte, status FROM pernas_jornada_voo/)
  assert.match(source, /ultimaPerna\?\.horario_dep \|\| ultimaPerna\?\.status === 'em_voo' \? 'em_rota'/)
})
