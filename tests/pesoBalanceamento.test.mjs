import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calcularPesoBalanceamento,
  erroConfiguracaoPeso,
  parseEnvelope,
  pontoDentroEnvelope,
  validarNomesPassageiros,
} from '../src/lib/pesoBalanceamento.ts'

const config = (envelope = [
  { peso_kg: 1000, cg_estacao: 2 },
  { peso_kg: 1500, cg_estacao: 2 },
  { peso_kg: 1500, cg_estacao: 4 },
  { peso_kg: 1000, cg_estacao: 4 },
]) => ({
  id: 'config-afm', validado: 1, peso_vazio_padrao: 1000, braco_cg_padrao: 3,
  peso_maximo_decolagem: 2000, peso_maximo_pouso: 1900, peso_maximo_sem_combustivel: 1500,
  cg_limite_dianteiro: 2, cg_limite_traseiro: 4, mac_comprimento: 1.2, lemac_distancia: 2, capacidade_combustivel_util: 500,
  envelope_pontos_json: JSON.stringify(envelope), data_ultima_pesagem: '2026-10-01',
  numero_relatorio_pesagem: 'PES-001', responsavel_tecnico: 'Responsável técnico',
})
const input = (overrides = {}) => ({
  passageiros: ['Ana'],
  itens_carregamento: [{ descricao: 'Ana', categoria: 'passageiro', peso_kg: 100, braco: 4 }],
  fuel_kg: 200, fuel_litros: 250, fuel_braco: 3,
  consumo_estimado_combustivel_kg: 100,
  ...overrides,
})

test('valida nomes não vazios e exatamente a quantidade solicitada', () => {
  assert.deepEqual(validarNomesPassageiros([' Ana '], 1), { ok: true, nomes: ['Ana'] })
  assert.equal(validarNomesPassageiros(['Ana', 'Bia'], 1).error, 'passageiros_quantidade_invalida')
  assert.equal(validarNomesPassageiros(['Ana'], 2).error, 'passageiros_quantidade_invalida')
  assert.equal(validarNomesPassageiros(['   '], 1).error, 'passageiros_nome_obrigatorio')
})

test('point-in-polygon avalia (peso kg, estação), incluindo borda', () => {
  const envelope = parseEnvelope(config().envelope_pontos_json)
  assert.ok(envelope)
  assert.equal(pontoDentroEnvelope(1250, 3, envelope), true)
  assert.equal(pontoDentroEnvelope(1000, 3, envelope), true)
  assert.equal(pontoDentroEnvelope(1600, 3, envelope), false)
  assert.equal(pontoDentroEnvelope(1250, 4.1, envelope), false)
})

test('calcula e valida CG e peso na decolagem e no pouso em estação', () => {
  const result = calcularPesoBalanceamento(config(), input())
  assert.equal(result.ok, true)
  assert.equal(result.resultado.peso_decolagem_kg, 1300)
  assert.equal(result.resultado.peso_pouso_kg, 1200)
  assert.equal(result.resultado.cg_decolagem_estacao, 4000 / 1300)
  assert.equal(result.resultado.cg_pouso_estacao, 3700 / 1200)
  assert.equal(result.resultado.envelope_decolagem_ok, true)
  assert.equal(result.resultado.envelope_pouso_ok, true)
  assert.equal(result.resultado.envelope_zero_combustivel_ok, true)
  assert.equal(result.resultado.cg_zero_combustivel_estacao, 3400 / 1100)
})

test('rejeita separadamente ponto de decolagem ou pouso fora do envelope', () => {
  const envelopeSomentePouso = [
    { peso_kg: 1150, cg_estacao: 2 }, { peso_kg: 1250, cg_estacao: 2 },
    { peso_kg: 1250, cg_estacao: 4 }, { peso_kg: 1150, cg_estacao: 4 },
  ]
  const falhaDecolagem = calcularPesoBalanceamento(config(envelopeSomentePouso), input())
  assert.equal(falhaDecolagem.ok, false)
  assert.equal(falhaDecolagem.error, 'ficha_fora_dos_limites')

  const envelopeSomenteDecolagem = [
    { peso_kg: 1250, cg_estacao: 2 }, { peso_kg: 1400, cg_estacao: 2 },
    { peso_kg: 1400, cg_estacao: 4 }, { peso_kg: 1250, cg_estacao: 4 },
  ]
  const falhaPouso = calcularPesoBalanceamento(config(envelopeSomenteDecolagem), input())
  assert.equal(falhaPouso.ok, false)
  assert.equal(falhaPouso.error, 'ficha_fora_dos_limites')
})

test('bloqueia configuração validada sem envelope geométrico', () => {
  const incompleta = config([])
  assert.equal(erroConfiguracaoPeso(incompleta), 'envelope_peso_nao_configurado')
  assert.equal(parseEnvelope('[]'), null)
})

test('aceita volume de combustível omitido, mas exige categoria de passageiro correspondente', () => {
  assert.equal(calcularPesoBalanceamento(config(), input({ fuel_litros: null })).ok, true)
  const semCategoria = calcularPesoBalanceamento(config(), input({ itens_carregamento: [{ descricao: 'Ana', peso_kg: 100, braco: 4 }] }))
  assert.equal(semCategoria.ok, false)
  assert.equal(semCategoria.error, 'carga_passageiros_incompleta')
})

test('rejeita CG zero combustível fora do envelope mesmo se decolagem e pouso caírem dentro', () => {
  const envelopeSemZfw = [
    { peso_kg: 1150, cg_estacao: 2 }, { peso_kg: 1400, cg_estacao: 2 },
    { peso_kg: 1400, cg_estacao: 4 }, { peso_kg: 1150, cg_estacao: 4 },
  ]
  const result = calcularPesoBalanceamento(config(envelopeSemZfw), input())
  assert.equal(result.ok, false)
  assert.equal(result.error, 'ficha_fora_dos_limites')
})

test('rejeita combustível acima da capacidade técnica cadastrada', () => {
  const result = calcularPesoBalanceamento(config(), input({ fuel_kg: 501 }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dados_peso_combustivel_invalidos')
})

test('bloqueia configuração validada sem MAC, LEMAC e limites CG coerentes', () => {
  const incompleta = config()
  delete incompleta.mac_comprimento
  assert.equal(erroConfiguracaoPeso(incompleta), 'limites_cg_nao_configurados')
})
