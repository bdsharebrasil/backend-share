import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const ler = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
const compilar = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext } }).outputText;
function funcoes(codigo, nomes, deps = {}) {
  const texto = compilar(codigo).replace(/\bexport /g, '');
  return Function(...Object.keys(deps), texto + ';return {' + nomes.join(',') + '}')(...Object.values(deps));
}
const { codigoAerodromoValido } = funcoes(await ler('src/lib/aerodromo.ts'), ['codigoAerodromoValido']);
const geo = funcoes(await ler('src/lib/geo.ts'), ['parseCoord', 'numericValue', 'haversineKm']);
const ais = await ler('src/routes/aiswebRoutes.ts');
const jornadas = await ler('src/routes/jornadasRoutes.ts');
const worker = await ler('src/worker.ts');
// Executa os handlers reais com dependências externas substituídas, sem inicializar rede/D1.
function handler(source, method, path, deps) {
  const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  let encontrado;
  const visitar = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === path) encontrado = node.arguments.at(-1);
    ts.forEachChild(node, visitar);
  };
  visitar(ast); assert.ok(encontrado, `Handler ausente: ${path}`);
  return Function(...Object.keys(deps), compilar('const executar = ' + encontrado.getText(ast)) + ';return executar')(...Object.values(deps));
}
const astAis = ts.createSourceFile('ais.ts', ais, ts.ScriptTarget.Latest, true);
const nomes = ['collectionItems', 'normalizeNotamItems', 'normalizeRouteItems'];
const normalizadores = funcoes(astAis.statements.filter(n => ts.isFunctionDeclaration(n) && nomes.includes(n.name?.text)).map(n => n.getText(astAis)).join('\n'), nomes);
const depsAis = {
  codigoAerodromoValido, ...geo, ...normalizadores,
  requireAiswebRateLimit: async () => true, cachedFetch: async (_c, _key, _ttl, fn) => fn(),
  fetchAisweb: async () => [], fetchNearby: async () => [], log: { warn() {} },
  fetchRotaerByIcao: async (_c, icao) => ({ name: icao, coordinates: icao === 'SN9T' ? { lat: -12.4841527778, lng: -57.1980555556 } : { lat: -15.65, lng: -56.12 } }),
};
const contexto = ({ params = {}, query = {}, body = {}, db = {}, ...outros } = {}) => ({
  req: { param: k => params[k], query: k => query[k], json: async () => body },
  env: { SHARE_DB: db }, json: (body, status = 200) => ({ body, status }), ...outros,
});
test('SN9T e outros designativos alfanuméricos passam na validação de formato', () => {
  for (const valor of ['SN9T', 'sn9t', 'SBGR', ' SS9A ']) assert.equal(codigoAerodromoValido(valor), true);
  for (const valor of ['', 'SN9', 'SN9TT', 'SN-T', null]) assert.equal(codigoAerodromoValido(valor), false);
});
test('coordenadas AISWEB aceitam GMS com espaços, aspas e segundos decimais sem inverter Sul/Oeste', () => {
  const { parseCoord } = geo;
  const lat = -(12 + 29 / 60 + 2.95 / 3600), lon = -(57 + 11 / 60 + 53 / 3600);
  for (const entrada of ['12 29 02.95S', '122902.95S', 'S12°29\'02.95"']) assert.ok(Math.abs(parseCoord(entrada) - lat) < 1e-10);
  assert.ok(Math.abs(parseCoord('057 11 53.00W') - lon) < 1e-10);
  assert.equal(parseCoord('-12.484'), -12.484); assert.equal(parseCoord('0'), 0);
  for (const entrada of ['12texto', '12 99 01S', '91 00 00S', '181 00 00W', '', Infinity]) assert.equal(parseCoord(entrada), null);
});
test('NOTAM e rotas aceitam SN9T e continuam recusando pontuação', async () => {
  const notam = handler(ais, 'get', '/api/notam/:icao', depsAis);
  assert.equal((await notam(contexto({ params: { icao: 'SN9T' } }))).status, 200);
  assert.equal((await notam(contexto({ params: { icao: 'SN!T' } }))).status, 400);
  const rotas = handler(ais, 'get', '/api/routes', depsAis);
  const resposta = await rotas(contexto({ query: { adep: 'SN9T', ades: 'SBCY' } }));
  assert.equal(resposta.status, 200); assert.equal(resposta.body.routes[0].route, 'SN9T DCT SBCY');
});
test('cálculo de voo usa as coordenadas normalizadas para SN9T e não exige latitude bruta', async () => {
  const calcular = handler(ais, 'get', '/api/flightplan', depsAis);
  const resposta = await calcular(contexto({ query: { adep: ' sn9t ', ades: 'SBCY', speed: '200', fuel_burn: '100' } }));
  assert.equal(resposta.status, 200); assert.equal(resposta.body.flightplan.adep, 'SN9T');
  assert.ok(resposta.body.departure.lat < 0 && resposta.body.departure.lon < 0);
  assert.ok(resposta.body.flightplan.distance_nm > 0);
  assert.equal((await calcular(contexto({ query: { adep: 'SN!T', ades: 'SBCY' } }))).status, 400);
});

test('rota principal continua disponível quando alternados e NOTAMs falham', async () => {
  const calcular = handler(ais, 'get', '/api/flightplan', {
    ...depsAis,
    fetchNearby: async () => { throw new Error('geilóc indisponível'); },
    cachedFetch: async (_c, key, _ttl, fn) => key.startsWith('routes-') ? fn() : Promise.reject(new Error('NOTAM indisponível')),
  });
  const resposta = await calcular(contexto({ query: { adep: 'SN9T', ades: 'SBCY' } }));
  assert.equal(resposta.status, 200);
  assert.equal(resposta.body.flightplan.route, 'SN9T DCT SBCY');
  assert.deepEqual(resposta.body.alternates, []);
  assert.deepEqual(resposta.body.notam_alerts, []);
});

test('plano de voo preserva os dados ICAO e de identificação cadastrados para a aeronave', async () => {
  const calcular = handler(ais, 'get', '/api/flightplan', depsAis);
  const aircraft = {
    id: 'aeronave-1', fabricante: 'FAB', modelo: 'MODELO', tipo_aeronave: 'TURBOELICE',
    consumo_combustivel: 80, velocidade_cruzeiro: '150', performance_velocidade_cruzeiro_kt: 175,
    designador_icao: 'AT72', esteira_turbulencia: 'M', equipamentos_icao: 'SDFGIRW',
    vigilancia_icao: 'LB1', pbn_icao: 'B2C2D2', autonomia_padrao_minutos: 240, cor_marcas: 'BRANCO/AZUL',
  };
  const db = { prepare: () => ({ bind: () => ({ first: async () => aircraft }) }) };
  const resposta = await calcular(contexto({ db, query: { adep: 'SBGR', ades: 'SBCY', aeronave_id: aircraft.id } }));
  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.body.performance, {
    source: 'performance_aeronave', fabricante: 'FAB', modelo: 'MODELO', tipo_aeronave: 'TURBOELICE',
    velocidade_cruzeiro_kt: 175, consumo_combustivel_lh: 80, categoria: null,
    teto_servico_ft: null, taxa_subida_fpm: null, taxa_descida_fpm: null,
    designador_icao: 'AT72', esteira_turbulencia: 'M', equipamentos_icao: 'SDFGIRW',
    vigilancia_icao: 'LB1', pbn_icao: 'B2C2D2', autonomia_padrao_minutos: 240, cor_marcas: 'BRANCO/AZUL',
  });
});

test('salvamento aceita SN9T e mantém a perna selecionada no payload', async () => {
  let vinculos, gravacoes = 0;
  const salvar = handler(worker, 'post', '/api/interno/planos-voo', {
    codigoAerodromoValido, requireShareInternal: async () => true, garantirTabelaPlanosVoo: async () => {}, uuid: () => 'plano-teste', extractSupabaseUserId: () => 'usuario-teste',
  });
  const db = { prepare: () => ({ bind: (...args) => { vinculos = args; return { run: async () => { gravacoes++; } }; } }) };
  const resposta = await salvar(contexto({ db, body: { adep: ' sn9t ', ades: 'SBCY', pernaSelecionadaId: 'perna-2' } }));
  assert.equal(resposta.status, 201); assert.equal(vinculos[2], 'SN9T');
  assert.equal(JSON.parse(vinculos.at(-1)).pernaSelecionadaId, 'perna-2');
  assert.equal((await salvar(contexto({ db, body: { adep: 'SN-T', ades: 'SBCY' } }))).status, 400);
  assert.equal(gravacoes, 1);
});
test('consulta de pernas é autenticada, abrange as jornadas do voo e não executa escritas', async () => {
  let permitido = true, consultas = 0, sql, id;
  const pernas = [{ id: 'p1', numero_jornada: 1 }, { id: 'p2', numero_jornada: 2 }];
  const consultar = handler(jornadas, 'get', '/api/interno/agendamento/:id/pernas-plano', {
    requireFlightOperationAccess: async () => permitido, validateWorkerSchema: async () => {}, console: { error() {} },
  });
  const db = { prepare: q => { sql = q; return { bind: valor => { id = valor; return { all: async () => { consultas++; return { results: pernas }; } }; } }; } };
  const c = contexto({ params: { id: 'solicitacao-a' }, db });
  const resposta = await consultar(c); assert.equal(resposta.status, 200); assert.deepEqual(resposta.body.pernas, pernas);
  assert.equal(id, 'solicitacao-a'); assert.match(sql, /WHERE j\.solicitacao_id = \?1/); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  permitido = false; assert.equal((await consultar(c)).status, 403); assert.equal(consultas, 1);
});
test('falha na leitura das pernas informa indisponibilidade sem devolver detalhes do banco', async () => {
  const consultar = handler(jornadas, 'get', '/api/interno/agendamento/:id/pernas-plano', {
    requireFlightOperationAccess: async () => true, validateWorkerSchema: async () => { throw Error('D1_SQL_SCHEMA_PRIVATE'); }, console: { error() {} },
  });
  const resposta = await consultar(contexto({ params: { id: 'a' } }));
  assert.equal(resposta.status, 503); assert.doesNotMatch(JSON.stringify(resposta.body), /D1_SQL_SCHEMA_PRIVATE/);
});
