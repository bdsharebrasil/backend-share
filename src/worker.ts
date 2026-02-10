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

const AISWEB_BASE_URL = 'http://aisweb.decea.gov.br/api/';

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

const fetchAisweb = async (
  c: Context<{ Bindings: Bindings }>,
  area: string,
  additionalParams: Record<string, string | undefined>
) => {
  const apiKey  = c.env.AISWEB_API_KEY;
  const apiPass = c.env.AISWEB_API_PASS;

  // DEBUG: loga estado real dos env vars no wrangler tail
  // URLSearchParams converte `undefined` para a STRING "undefined" — causando o erro!
  console.log(`[ENV] apiKey  → tipo:${typeof apiKey}  tamanho:${apiKey?.length ?? 'N/A'}`);
  console.log(`[ENV] apiPass → tipo:${typeof apiPass} tamanho:${apiPass?.length ?? 'N/A'}`);

  if (!apiKey || !apiPass) {
    throw new Error(
      `Credenciais AISWEB ausentes. apiKey=${!!apiKey} apiPass=${!!apiPass}`
    );
  }

  // Constrói a query string manualmente (evita o bug do URLSearchParams com undefined)
  const queryParts: string[] = [
    `apiKey=${encodeURIComponent(apiKey)}`,
    `apiPass=${encodeURIComponent(apiPass)}`,
    `area=${encodeURIComponent(area)}`,
  ];

  Object.entries(additionalParams).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      queryParts.push(`${key}=${encodeURIComponent(value)}`);
    }
  });

  const url = `${AISWEB_BASE_URL}?${queryParts.join('&')}`;

  // Log seguro (sem credenciais reais)
  const safeParams = Object.entries(additionalParams)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  console.log(`[AISWEB] GET area=${area} ${safeParams}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 ShareBrasil',
      'Accept':     'text/xml, application/xml, */*',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  console.log(`[AISWEB] Resposta (${area}): ${text.substring(0, 300)}`);

  if (!text || text.trim() === '') {
    throw new Error('AISWEB retornou resposta vazia');
  }

  if (text.includes('Erro nos parametros')) {
    throw new Error(`AISWEB rejeitou: ${text.replace(/<[^>]+>/g, '').trim()}`);
  }

  // Tenta JSON
  try { return JSON.parse(text); } catch { /* segue para XML */ }

  // Parse XML → desce para o nó correto
  const parsed = parser.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Falha ao parsear XML da AISWEB');
  }

  const aisweb  = parsed['aisweb'] ?? parsed;
  const nodeKey = AREA_NODE_MAP[area];

  return (nodeKey && aisweb[nodeKey] !== undefined) ? aisweb[nodeKey] : aisweb;
};

// ============= ROTAS =============

app.get('/', (c) => c.text('ShareBrasil API - Central DECEA Ativa 🚀'));

// DIAGNÓSTICO — remova após confirmar funcionamento
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
    if (dt_i) {
      params.dt_i = dt_i;
      params.dt_f = dt_f ?? dt_i;
    }
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
