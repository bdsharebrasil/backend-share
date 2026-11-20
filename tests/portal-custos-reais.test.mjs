import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { portalRoutes } from '../src/routes/portalRoutes.ts'
import { carregarCustosPortal, calcularCamadasPortal, grupoCustoPortal, mesesAte, premissasHistoricasPortal, resumoCustosPortal } from '../src/financeiro/portalCustos.ts'

const aeronave = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const outra = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const segredo = 'segredo-apenas-para-testes'
function banco() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE aeronave (id TEXT, matricula_registro TEXT, consumo_combustivel REAL, velocidade_cruzeiro TEXT, tipo_aeronave TEXT, modelo TEXT, performance_aeronave_id TEXT, custo_hora_complementar_centavos INTEGER, taxas_trecho_centavos INTEGER, custo_dia_pernoite_centavos INTEGER);
    CREATE TABLE performance_aeronave (id TEXT, categoria TEXT, modelo TEXT, velocidade_cruzeiro_kt REAL, atualizado_em TEXT);
    CREATE TABLE aerodromo (designativo_icao TEXT, coordenadas TEXT);
    CREATE TABLE fornecedores_combustivel (codigo_icao TEXT, preco_jet REAL, preco_avgas REAL);
    CREATE TABLE cotista_aeronave (id TEXT, aeronave_id TEXT, cliente_id TEXT, socio_id TEXT, percentual_sociedade REAL, status TEXT);
    CREATE TABLE user_cliente (id TEXT, login TEXT, cotista_id TEXT, nome_exibicao TEXT, url_avatar TEXT, principal_id TEXT, permissoes TEXT);
    CREATE TABLE portal_sessoes_revogadas (token_hash TEXT, expires_at INTEGER);
    CREATE TABLE rateio_despesas (id TEXT, aeronave_id TEXT, cotista_id TEXT, data_emissao TEXT, data_competencia_demonstrativo TEXT, valor_rateado_centavos INTEGER, valor_total_centavos INTEGER, natureza_custo TEXT, categoria_nome TEXT, descricao_despesa TEXT, status TEXT);
    CREATE TABLE rateio_hold (id TEXT, aeronave_id TEXT, socio_id TEXT, data_emissao TEXT, data_competencia_demonstrativo TEXT, valor_rateado_centavos INTEGER, natureza_custo TEXT, categoria_nome TEXT, descricao_despesa TEXT, status TEXT);
    CREATE TABLE lancamentos_diario_bordo (id TEXT, aeronave_id TEXT, data_registro TEXT, tempo_dep TEXT, tempo_pou TEXT, tempo_voo REAL, cliente_id TEXT, socio_id TEXT, cliente_tomador_emprestimo_id TEXT, socio_tomador_emprestimo_id TEXT, tempo_total REAL, tempo_ac TEXT, tempo_cor TEXT, natureza_voo TEXT, voo_emprestado INTEGER);
    INSERT INTO aeronave VALUES ('${aeronave}', 'PT-TESTE', 240, '200', 'TURBOELICE', 'MODELO', NULL, 90000, 30000, 40000), ('${outra}', 'PT-OUTRA', 100, '150', 'PISTAO', 'OUTRO', NULL, 0, 0, 0);
    INSERT INTO aerodromo VALUES ('SBCY', '-15.65,-56.12'), ('SBSI', '-11.89,-55.59');
    INSERT INTO fornecedores_combustivel VALUES ('SBCY', 8.5, 12), ('SBSI', 8.5, 12);
    INSERT INTO cotista_aeronave VALUES ('cota-a', '${aeronave}', 'cliente-a', NULL, 60, 'ativo'), ('cota-b', '${aeronave}', 'cliente-b', NULL, 40, 'ativo'), ('cota-socio', '${aeronave}', NULL, 'socio-a', 20, 'inativo');
    INSERT INTO user_cliente VALUES ('user-a', 'login-a', 'cota-a', 'Teste', NULL, NULL, NULL);
    INSERT INTO rateio_hold VALUES ('hold-1', '${aeronave}', 'socio-a', '2026-10-05', '2026-11-01', 2000, 'FIXO', 'TRIPULAÇÃO', 'Subdivisão holding', 'PAGO');
    INSERT INTO lancamentos_diario_bordo VALUES
      ('v1', '${aeronave}', '2026-10-01', '23:30', '00:30', 999, 'cliente-a', NULL, NULL, NULL, 1.33, '23:20', '00:40', NULL, 0),
      ('v2', '${aeronave}', '2026-10-04', '12:00', '12:30', 999, 'cliente-b', NULL, 'cliente-a', NULL, 0.83, '11:50', '12:40', NULL, 1),
      ('v3', '${aeronave}', '2026-10-05', NULL, NULL, 0.25, 'cliente-b', 'socio-a', NULL, NULL, 0.4, NULL, NULL, NULL, 0),
      ('outra', '${outra}', '2026-10-01', '00:00', '20:00', 20, 'cliente-a', NULL, NULL, NULL, 20, NULL, NULL, NULL, 0);
  `)
  for (const [id, total, categoria, natureza] of [['fixo', 10000, 'TRIPULAÇÃO', 'FIXO'], ['gas', 5000, 'COMBUSTÍVEIS', null], ['reserva', 1000, 'RESERVA', null], ['sem', 300, 'DESCONHECIDA', null]]) {
    for (const [cota, fator] of [['cota-a', .6], ['cota-b', .4]]) sqlite.prepare('INSERT INTO rateio_despesas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`${id}-${cota}`, aeronave, cota, '2026-10-05', '2026-11-01', Math.round(total * fator), total, natureza, categoria, id, 'EM_ABERTO')
  }
  sqlite.prepare('INSERT INTO rateio_despesas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('cancelado', aeronave, 'cota-a', '2026-10-01', '', 500, 500, null, 'VIAGEM', 'Cancelado', 'CANCELADO')
  sqlite.prepare('INSERT INTO rateio_despesas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('outra', outra, 'cota-a', '2026-10-01', '', 900000, 900000, null, 'VIAGEM', 'Outra aeronave', 'PAGO')
  const consultas = []
  return { sqlite, consultas, prepare(sql) {
    consultas.push(sql)
    let valores = []
    return { bind(...args) { valores = args; return this }, async all() { return { results: sqlite.prepare(sql).all(...valores) } }, async first() { return sqlite.prepare(sql).get(...valores) ?? null } }
  } }
}
async function token() {
  const payload = Buffer.from(JSON.stringify({ id: 'user-a', login: 'login-a', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `${payload}.${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url')}`
}
const chamar = async (db, path, body) => portalRoutes.request(path, { headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }, { SHARE_DB: db, CLIENT_SESSION_SECRET: segredo })

test('consolidação soma parcelas uma vez e usa emissão, aeronave e tomador do empréstimo', async () => {
  const db = banco()
  const r = await carregarCustosPortal(db, aeronave, 'cota-a', 'cliente-a', null, ['2026-10'])
  assert.equal(r.resposta.resumo.aeronave.total_centavos, 16300)
  assert.equal(r.resposta.resumo.cotista.total_centavos, 9780)
  assert.equal(r.resposta.resumo.aeronave.etapas_atribuidas, 3)
  // Compete em outubro pela emissão; data_competencia_demonstrativo diz novembro.
  assert.equal(r.resposta.resumo.aeronave.minutos_voo, 105)
  assert.equal(r.resposta.resumo.cotista.minutos_voo, 90)
  assert.equal(r.resposta.resumo.aeronave.minutos_operacionais, 154)
  assert.equal(r.resposta.resumo.cotista.minutos_operacionais, 130)
  assert.equal(r.resposta.resumo.aeronave.custo_hora_centavos, Math.round(16300 * 60 / 154))
  assert.equal(r.resposta.resumo.cotista.custo_hora_centavos, Math.round(9780 * 60 / 130))
  assert.equal(r.resposta.resumo.aeronave.grupos.fixos.valor_centavos, 10000)
  assert.equal(r.resposta.resumo.aeronave.grupos.reservas.valor_centavos, 1000)
  assert.equal(r.resposta.resumo.aeronave.grupos.nao_classificados.valor_centavos, 300)
  assert.equal(r.resposta.mensal.find(m => m.mes === '2026-09').aeronave.total_centavos, 0)
  db.sqlite.close()
})

test('sócio lê a parcela da holding sem somá-la novamente ao custo da aeronave', async () => {
  const db = banco()
  const r = await carregarCustosPortal(db, aeronave, 'cota-socio', null, 'socio-a', ['2026-10'])
  assert.equal(r.resposta.resumo.aeronave.total_centavos, 16300)
  assert.equal(r.resposta.resumo.cotista.total_centavos, 2000)
  assert.equal(r.resposta.resumo.cotista.minutos_voo, 15)
  db.sqlite.close()
})

test('horas ausentes e divisões sem base não produzem custo/hora zero ou Infinity', () => {
  const r = resumoCustosPortal([{ mes: '2026-10', categoria_nome: 'VIAGEM', valor_rateado_centavos: 10000 }], [{ mes: '2026-10', tempo_voo: null }], ['2026-10'])
  assert.equal(r.custo_hora_centavos, null)
  assert.equal(r.etapas_sem_tempo, 1)
  assert.equal(resumoCustosPortal([], [{ mes: '2026-10', tempo_voo: 1 }], ['2026-10']).custo_hora_centavos, null)
  assert.equal(premissasHistoricasPortal([], []).fixo_anual_centavos, null)
  assert.equal(grupoCustoPortal({ categoria_nome: 'SEM CADASTRO', tipo_rateio: 'FIXO' }), 'nao_classificados')
  assert.equal(grupoCustoPortal({ categoria_nome: 'COMBUSTÍVEIS', natureza_custo: 'FIXO' }), 'fixos')
})

test('camadas alocam apenas os fixos por participação e uso, com centavos exatos', () => {
  const entrada = { horas: 2, horasAno: 100, participacao: .6, passageiros: 4, dias: 3, combustivel: 100000, taxas: 20000, viagem: 30000, fixoAnual: 12000000, reservaHora: 50000 }
  const r = calcularCamadasPortal(entrada)
  assert.equal(r.curto_prazo_centavos, 150000)
  assert.equal(r.medio_prazo_centavos, 144000)
  assert.equal(r.longo_prazo_centavos, 100000)
  assert.equal(r.total_alocado_centavos, 394000)
  assert.equal(r.por_passageiro_centavos, 98500)
  assert.equal(calcularCamadasPortal({ ...entrada, horasAno: 200 }).medio_prazo_centavos, 72000)
  assert.equal(calcularCamadasPortal({ ...entrada, reservaHora: null }).total_alocado_centavos, null)
  assert.equal(calcularCamadasPortal({ ...entrada, reservaHora: null }).subtotal_conhecido_centavos, 294000)
  assert.throws(() => calcularCamadasPortal({ ...entrada, horasAno: 0 }), /parametros_invalidos/)
  assert.deepEqual(mesesAte('2026-01', 3), ['2025-11', '2025-12', '2026-01'])
})

test('média de viagem não reaproveita combustível e taxas como hospedagem e alimentação', () => {
  const rateios = [
    { mes: '2026-10', categoria_nome: 'VIAGEM', descricao_despesa: 'TAXA INFRAERO', valor_rateado_centavos: 3000 },
    { mes: '2026-10', categoria_nome: 'VIAGEM', descricao_despesa: 'ABASTECIMENTO', valor_rateado_centavos: 8000 },
    { mes: '2026-10', categoria_nome: 'VIAGEM', descricao_despesa: 'HOTEL', valor_rateado_centavos: 5000 },
  ]
  const p = premissasHistoricasPortal(rateios, [{ mes: '2026-10', data_registro: '2026-10-01', tempo_voo: 1 }])
  assert.equal(p.taxas_trecho_centavos, 3000)
  assert.equal(p.viagem_dia_centavos, 5000)
})

test('endpoint exige vínculo, valida competências e respeita a permissão financeira', async () => {
  const db = banco()
  const ok = await chamar(db, `/api/portal/financeiro/custos?aeronave_id=${aeronave}&meses=2026-10`)
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('Cache-Control'), /private, no-store/)
  const body = await ok.json()
  assert.equal(body.resumo.aeronave.total_centavos, 16300)
  assert.equal(body.vinculo.quantidade_cotas, 2)
  assert.equal(body.vinculo.percentual_sociedade, 60)
  assert.equal((await chamar(db, `/api/portal/financeiro/custos?aeronave_id=${outra}&meses=2026-10`)).status, 404)
  assert.equal((await chamar(db, `/api/portal/financeiro/custos?aeronave_id=${aeronave}&meses=2026-13`)).status, 400)
  db.sqlite.exec(`UPDATE user_cliente SET principal_id = 'principal', permissoes = '["agendamento"]'`)
  assert.equal((await chamar(db, `/api/portal/financeiro/custos?aeronave_id=${aeronave}&meses=2026-10`)).status, 403)
  db.sqlite.close()
})

test('simulação real mantém contrato legado e não apresenta projeção incompleta como total', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T12:00:00Z') })
  const db = banco()
  const pedido = { aeronave_id: aeronave, origem: 'SBCY', destino: 'SBSI', ida_e_volta: true, incluir_estrutura: true, horas_ano: 120, passageiros: 4, dias_jornada: 3 }
  const resposta = await chamar(db, '/api/portal/simulador/voo', pedido)
  assert.equal(resposta.status, 200)
  const body = await resposta.json()
  assert(Number.isSafeInteger(body.total_centavos))
  assert.equal(body.projecao.percentual_participacao, 60)
  assert.equal(body.projecao.total_alocado_centavos, null) // há despesa sem natureza
  assert.equal(body.projecao.completo, false)
  assert(body.projecao.pendencias.some(p => p.includes('sem natureza')))
  db.sqlite.exec("DELETE FROM rateio_despesas WHERE id LIKE 'sem-%'")
  const completa = await chamar(db, '/api/portal/simulador/voo', pedido)
  const resultado = (await completa.json()).projecao
  assert.equal(resultado.completo, true)
  assert.equal(resultado.total_alocado_centavos, resultado.curto_prazo_centavos + resultado.medio_prazo_centavos + resultado.longo_prazo_centavos)
  const cenario = await chamar(db, '/api/portal/simulador/voo', { ...pedido, quantidade_cotas: 4 })
  assert.equal((await cenario.json()).projecao.percentual_participacao, 25)
  assert.equal((await chamar(db, '/api/portal/simulador/voo', { ...pedido, horas_ano: 0 })).status, 400)
  db.sqlite.exec(`UPDATE user_cliente SET principal_id = 'principal', permissoes = '["agendamento"]'`)
  assert.equal((await chamar(db, '/api/portal/simulador/voo', pedido)).status, 403)
  const legado = await chamar(db, '/api/portal/simulador/voo', { aeronave_id: aeronave, origem: 'SBCY', destino: 'SBSI' })
  assert.equal(legado.status, 200)
  assert.equal('projecao' in await legado.json(), false)
  db.sqlite.close()
})

test('estimativa de ida e volta é custo de um voo, sem ratear custo anual de cotista', async () => {
  const db = banco()
  const rota = { aeronave_id: aeronave, origem: 'SBCY', destino: 'SBSI', ida_e_volta: true }
  const resp = await chamar(db, '/api/portal/simulador/voo', rota)
  assert.equal(resp.status, 200)
  const v = await resp.json()
  assert.equal(v.modelo_estimativa, 'voo_individual')
  assert.equal(v.inclui_estrutura_fixa_mensal, false)
  assert.equal(v.ida_e_volta, true)
  assert.equal(v.projecao, undefined)
  assert.equal(v.componentes.pernoite_centavos, 0)
  assert.equal(v.componentes_disponiveis.combustivel, true)
  assert.equal(v.componentes_disponiveis.taxas, true)
  assert.equal(v.componentes_disponiveis.manutencao_reservas, true)
  assert.equal(v.total_centavos,
    v.componentes.combustivel_centavos +
    v.componentes.manutencao_reservas_centavos +
    v.componentes.taxas_centavos)
  const ida = await chamar(db, '/api/portal/simulador/voo', { ...rota, ida_e_volta: false })
  assert.equal(ida.status, 200)
  const soIda = await ida.json()
  assert.equal(v.tempo_voo_minutos, soIda.tempo_voo_minutos * 2)
  assert.equal(v.componentes.combustivel_centavos, soIda.componentes.combustivel_centavos * 2)
  assert.equal(v.componentes.taxas_centavos, soIda.componentes.taxas_centavos * 2)
  db.sqlite.close()
})

test('simulador sinaliza taxa ou manutenção ausentes sem inventar que custam zero', async () => {
  const db = banco()
  db.sqlite.exec('UPDATE aeronave SET custo_hora_complementar_centavos = NULL, taxas_trecho_centavos = NULL')
  const resp = await chamar(db, '/api/portal/simulador/voo', {
    aeronave_id: aeronave, origem: 'SBCY', destino: 'SBSI', ida_e_volta: true,
  })
  assert.equal(resp.status, 200)
  const sim = await resp.json()
  assert.equal(sim.aviso, 'estimativa parcial')
  assert.equal(sim.componentes_disponiveis.manutencao_reservas, false)
  assert.equal(sim.componentes_disponiveis.taxas, false)
  assert.equal(sim.total_centavos, sim.componentes.combustivel_centavos)
  db.sqlite.close()
})
