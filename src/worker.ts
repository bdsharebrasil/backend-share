import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { XMLParser } from 'fast-xml-parser';

type Bindings = {
  AISWEB_API_KEY: string;
  AISWEB_API_PASS: string;
  CACHE_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ['item', 'notam', 'carta', 'sol'].includes(name),
});

app.use('*', cors());

// Domínios a tentar em ordem — o primeiro que responder com dados válidos vence
const AISWEB_CANDIDATES = [
  'https://aisweb.decea.gov.br/api/',       // HTTPS novo (mais provável)
  'http://aisweb.decea.gov.br/api/',         // HTTP documentado
  'https://www.aisweb.aer.mil.br/api/',      // HTTPS legado
  'http://www.aisweb.aer.mil.br/api/',       // HTTP legado (curl da doc)
];

const AREA_NODE_MAP: Record<string, string> = {
  met:       'met',
  cartas:    'cartas',
  notam:     'notam',
  infotemp:  'infotemp',
  sol:       'sol',
  routesp:   'routesp',
  waypoints: 'waypoints',
  rotaer:    'rotaer',
};

// Monta query string manualmente — URLSearchParams converte undefined→"undefined"
const buildUrl = (
  base: string,
  apiKey: string,
  apiPass: string,
  area: string,
  extra: Record<string, string | undefined>
) => {
  const parts: string[] = [
    `apiKey=${encodeURIComponent(apiKey)}`,
    `apiPass=${encodeURIComponent(apiPass)}`,
    `area=${encodeURIComponent(area)}`,
  ];
  Object.entries(extra).forEach(([k, v]) => {
    if (v !== undefined && v !== '') parts.push(`${k}=${encodeURIComponent(v)}`);
  });
  return `${base}?${parts.join('&')}`;
};

// Faz uma única chamada HTTP com timeout e follow redirect
const tryFetch = async (url: string): Promise<{ ok: boolean; status: number; text: string }> => {
  try {
    const res = await fetch(url, {
      redirect: 'follow',           // segue redirects 301/302
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/xml, application/xml, */*',
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err: any) {
    return { ok: false, status: 0, text: err.message };
  }
};

// Resposta é válida se não contém erro e tem algum conteúdo XML
const isValidResponse = (text: string) =>
  text.length > 10 &&
  !text.includes('Erro nos parametros') &&
  !text.includes('404') &&
  (text.includes('<') || text.includes('{'));

const fetchAisweb = async (
  c: Context<{ Bindings: Bindings }>,
  area: string,
  additionalParams: Record<string, string | undefined>
) => {
  const apiKey  = c.env.AISWEB_API_KEY;
  const apiPass = c.env.AISWEB_API_PASS;

  if (!apiKey || !apiPass) {
    throw new Error(`Credenciais ausentes. apiKey=${!!apiKey} apiPass=${!!apiPass}`);
  }

  let lastError = '';

  // Tenta cada domínio até um responder com dados válidos
  for (const base of AISWEB_CANDIDATES) {
    const url  = buildUrl(base, apiKey, apiPass, area, additionalParams);
    const safe = `${base}?apiKey=***&apiPass=***&area=${area}`;

    console.log(`[AISWEB] Tentando: ${safe}`);

    const { ok, status, text } = await tryFetch(url);

    console.log(`[AISWEB] Status ${status}, tamanho ${text.length}, preview: ${text.substring(0, 120)}`);

    if (!ok || !isValidResponse(text)) {
      lastError = `${base} → HTTP ${status}: ${text.substring(0, 80)}`;
      continue; // tenta o próximo
    }

    // Sucesso — faz o parse
    try { return JSON.parse(text); } catch { /* segue XML */ }

    const parsed = parser.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('Falha ao parsear XML');

    const aisweb  = parsed['aisweb'] ?? parsed;
    const nodeKey = AREA_NODE_MAP[area];
    return (nodeKey && aisweb[nodeKey] !== undefined) ? aisweb[nodeKey] : aisweb;
  }

  throw new Error(`Todos os domínios falharam. Último erro: ${lastError}`);
};

// ============= ROTAS =============

app.get('/', (c) => c.text('ShareBrasil API - Central DECEA Ativa 🚀'));

// DIAGNÓSTICO: testa todos os domínios e retorna resultado detalhado
app.get('/debug/probe', async (c) => {
  const apiKey  = c.env.AISWEB_API_KEY;
  const apiPass = c.env.AISWEB_API_PASS;

  if (!apiKey || !apiPass) return c.json({ error: 'Credenciais ausentes' }, 500);

  const results: Record<string, any> = {};

  for (const base of AISWEB_CANDIDATES) {
    const url = buildUrl(base, apiKey, apiPass, 'met', { icaoCode: 'SBGR' });
    const { ok, status, text } = await tryFetch(url);
    results[base] = {
      status,
      ok,
      tamanho:    text.length,
      preview:    text.substring(0, 200).replace(/\s+/g, ' ').trim(),
      erro_api:   text.includes('Erro nos parametros'),
      tem_dados:  isValidResponse(text),
      tem_metar:  text.toLowerCase().includes('metar'),
    };
  }

  return c.json(results);
});

// DIAGNÓSTICO: env vars
app.get('/debug/env', (c) => {
  const key  = c.env.AISWEB_API_KEY;
  const pass = c.env.AISWEB_API_PASS;
  return c.json({
    apiKey_ok:      !!key  && key.trim()  !== '',
    apiPass_ok:     !!pass && pass.trim() !== '',
    apiKey_length:  key?.length  ?? 0,
    apiPass_length: pass?.length ?? 0,
    apiKey_prefix:  key  ? key.substring(0, 4)  + '***' : 'AUSENTE',
    apiPass_prefix: pass ? pass.substring(0, 4) + '***' : 'AUSENTE',
  });
});

// 1. Meteorologia (METAR/TAF)
app.get('/api/weather/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'met', { icaoCode: c.req.param('icao').toUpperCase() });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 2. Cartas
app.get('/api/charts/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'cartas', {
      icaoCode: c.req.param('icao').toUpperCase(),
      especie:  c.req.query('especie') || 'IFR',
      tipo:     c.req.query('tipo'),
      useAll:   '1',
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 3. NOTAM
app.get('/api/notam/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'notam', { icaoCode: c.req.param('icao').toUpperCase() });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 4. InfoTemp
app.get('/api/infotemp/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'infotemp', { icaoCode: c.req.param('icao').toUpperCase() });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 5. Nascer/Pôr do Sol
app.get('/api/solar/:icao', async (c) => {
  try {
    const dt_i = c.req.query('date');
    const dt_f = c.req.query('date_f');
    const params: Record<string, string | undefined> = {
      icaoCode: c.req.param('icao').toUpperCase(),
    };
    if (dt_i) { params.dt_i = dt_i; params.dt_f = dt_f ?? dt_i; }
    const data = await fetchAisweb(c, 'sol', params);
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 6. Rotas Preferenciais
app.get('/api/routes', async (c) => {
  try {
    const adep = c.req.query('adep');
    const ades = c.req.query('ades');
    if (!adep || !ades) return c.json({ error: 'adep e ades são obrigatórios' }, 400);
    const data = await fetchAisweb(c, 'routesp', {
      adep: adep.toUpperCase(),
      ades: ades.toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 7. Waypoints
app.get('/api/waypoints', async (c) => {
  try {
    const data = await fetchAisweb(c, 'waypoints', {});
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 8. ROTAER
app.get('/api/rotaer/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'rotaer', { icaoCode: c.req.param('icao').toUpperCase() });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

export default { fetch: app.fetch };
