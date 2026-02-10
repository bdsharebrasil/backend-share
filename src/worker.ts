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

// ✅ URL CORRETA conforme documentação oficial v00.00.02
const AISWEB_BASE_URL = 'https://api.decea.mil.br/aisweb/';

const AREA_NODE_MAP: Record<string, string> = {
  met:          'met',
  cartas:       'cartas',
  notam:        'notam',
  infotemp:     'infotemp',
  sol:          'sol',
  routesp:      'routesp',
  waypoints:    'waypoints',
  rotaer:       'rotaer',
  pub:          'pub',
  suplementos:  'suplementos',
  geiloc:       'geiloc',
};

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

  // Monta query string sem encodeURIComponent nas chaves (API espera valores literais)
  const parts: string[] = [
    `apiKey=${apiKey}`,
    `apiPass=${apiPass}`,
    `area=${area}`,
  ];
  Object.entries(additionalParams).forEach(([k, v]) => {
    if (v !== undefined && v !== '') parts.push(`${k}=${v}`);
  });

  const url = `${AISWEB_BASE_URL}?${parts.join('&')}`;

  const safeUrl = `${AISWEB_BASE_URL}?apiKey=***&apiPass=***&area=${area}&${
    Object.entries(additionalParams).filter(([,v])=>v).map(([k,v])=>`${k}=${v}`).join('&')
  }`;
  console.log(`[AISWEB] GET ${safeUrl}`);

  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':     'text/xml, application/xml, */*',
    },
  });

  const text = await res.text();
  console.log(`[AISWEB] Status: ${res.status} | Preview: ${text.substring(0, 300)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  if (!text || text.trim() === '') throw new Error('Resposta vazia');
  if (text.includes('Erro nos parametros')) {
    throw new Error(`Parâmetros rejeitados: ${text.replace(/<[^>]+>/g, '').trim()}`);
  }

  try { return JSON.parse(text); } catch { /* segue XML */ }

  const parsed = parser.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Falha ao parsear XML');

  const aisweb  = parsed['aisweb'] ?? parsed;
  const nodeKey = AREA_NODE_MAP[area];
  return (nodeKey && aisweb[nodeKey] !== undefined) ? aisweb[nodeKey] : aisweb;
};

// ============= ROTAS =============

app.get('/', (c) => c.text('ShareBrasil API - Central DECEA Ativa 🚀'));

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

// 4. InfoTemp / ROTAER
app.get('/api/infotemp/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'infotemp', { icaoCode: c.req.param('icao').toUpperCase() });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 5. ROTAER (aeródromos)
app.get('/api/rotaer/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'rotaer', { icaoCode: c.req.param('icao').toUpperCase() });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 6. Nascer/Pôr do Sol
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

// 7. Rotas Preferenciais
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

// 8. Waypoints
app.get('/api/waypoints', async (c) => {
  try {
    const data = await fetchAisweb(c, 'waypoints', {});
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 9. GEILOC (aeródromos, TMAs e FIRs simplificados)
app.get('/api/geiloc', async (c) => {
  try {
    const data = await fetchAisweb(c, 'geiloc', {
      icaoCode: c.req.query('icao')?.toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 10. Publicações AIP
app.get('/api/pub', async (c) => {
  try {
    const data = await fetchAisweb(c, 'pub', {
      tipo: c.req.query('tipo'),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// ─── DIAGNÓSTICO (remova após confirmar funcionamento) ───────────────────────
app.get('/debug/probe', async (c) => {
  const apiKey  = c.env.AISWEB_API_KEY;
  const apiPass = c.env.AISWEB_API_PASS;
  if (!apiKey || !apiPass) return c.json({ error: 'Credenciais ausentes' }, 500);

  const url = `${AISWEB_BASE_URL}?apiKey=${apiKey}&apiPass=${apiPass}&area=met&icaoCode=SBGR`;

  try {
    const res  = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    return c.json({
      dominio_usado: AISWEB_BASE_URL,
      status:        res.status,
      ok:            res.ok,
      tamanho:       text.length,
      preview:       text.substring(0, 400).replace(/\s+/g, ' ').trim(),
      erro_api:      text.includes('Erro nos parametros'),
      tem_metar:     text.toLowerCase().includes('metar'),
    });
  } catch (err: any) {
    return c.json({ erro: err.message });
  }
});

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

export default { fetch: app.fetch };
