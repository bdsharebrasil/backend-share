import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agruparJornadasVoo, checklistPreVooConcluido, determinarStatusAgendamentoVoo } from '../src/routes/jornadasRoutes.ts'

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

test('mantém EM VOO somente enquanto houver perna sem pouso registrado', () => {
  assert.equal(determinarStatusAgendamentoVoo('aprovada', 1, 0), 'em_voo')
  assert.equal(determinarStatusAgendamentoVoo('em_voo', 0, 1), 'em_solo')
  assert.equal(determinarStatusAgendamentoVoo('em_voo', 0, 0), 'em_solo')
})

test('encerra em EM SOLO e preserva estados finais ou solicitações ainda sem voo', () => {
  assert.equal(determinarStatusAgendamentoVoo('aprovada', 0, 0), 'aprovada')
  assert.equal(determinarStatusAgendamentoVoo('aprovada', 0, 0, true), 'em_solo')
  assert.equal(determinarStatusAgendamentoVoo('encerrada', 0, 1, true), 'encerrada')
})

test('somente checklist pré-voo concluído libera o início da jornada', () => {
  assert.equal(checklistPreVooConcluido(null), false)
  assert.equal(checklistPreVooConcluido('rascunho'), false)
  assert.equal(checklistPreVooConcluido(' CONCLUIDO '), true)
})
