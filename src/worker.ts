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

// ─────────────────────────────────────────────
// CORREÇÕES APLICADAS:
//
// 1. URL ERRADA → A documentação usa http://aisweb.decea.gov.br/api/
//    O código usava https://aisweb.decea.mil.br/api/ (domínio e protocolo errados)
//
// 2. BACKTICK QUEBRADO → fetch`${url}` estava sem o `(` antes do template literal
//    Deveria ser fetch(`${url}`, { ... })
//
// 3. dt_f OBRIGATÓRIO com dt_i → A API exige dt_f quando dt_i é informado.
//    Para /solar, se não passar dt_f, é gerado automaticamente = dt_i (mesmo dia)
//
// 4. PARSING VAZIO → O parser extraía apenas a "casca" raiz <aisweb> sem
//    descer para o conteúdo real. Agora desce até o nó correto por área.
// ─────────────────────────────────────────────

const AISWEB_BASE_URL = 'http://aisweb.decea.gov.br/api/';

// Mapa de qual nó XML extrair por área de serviço
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
  // CORREÇÃO 1: URL correta conforme documentação oficial
  const params = new URLSearchParams({
    apiKey:  c.env.AISWEB_API_KEY,
    apiPass: c.env.AISWEB_API_PASS,
    area:    area,
  });

  Object.entries(additionalParams).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      params.append(key, value);
    }
  });

  const url = `${AISWEB_BASE_URL}?${params.toString()}`;

  console.log(`[AISWEB] Chamando: ${url.replace(c.env.AISWEB_API_KEY, '***').replace(c.env.AISWEB_API_PASS, '***')}`);

  // CORREÇÃO 2: fetch() com parênteses corretos (estava com backtick direto)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 ShareBrasil',
      'Accept':     'text/xml, application/xml, */*',
    },
  });

  if (!res.ok) {
    throw new Error(`AISWEB retornou HTTP ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  console.log(`[AISWEB] Resposta bruta (${area}):`, text.substring(0, 500));

  if (!text || text.trim() === '') {
    throw new Error('AISWEB retornou resposta vazia');
  }

  // Tenta JSON direto (caso a API mude de formato)
  try {
    const json = JSON.parse(text);
    return json;
  } catch {
    // Segue para parsing XML
  }

  // CORREÇÃO 4: Parse XML e desce para o nó correto dentro de <aisweb>
  const parsed = parser.parse(text);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Falha ao parsear resposta da AISWEB');
  }

  // A resposta tem sempre a forma: { aisweb: { <area>: { ... } } }
  const aeisweb = parsed['aisweb'] ?? parsed;
  const nodeKey = AREA_NODE_MAP[area];

  if (nodeKey && aeisweb[nodeKey] !== undefined) {
    return aeisweb[nodeKey];
  }

  // Fallback: retorna tudo dentro de <aisweb>
  return aeisweb;
};

// ============= ROTAS =============

app.get('/', (c) => c.text('ShareBrasil API - Central DECEA Ativa 🚀'));

// 1. Meteorologia (METAR/TAF)
app.get('/api/weather/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'met', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 2. Cartas (Espécie, Tipo, ICAO)
app.get('/api/charts/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'cartas', {
      icaoCode: c.req.param('icao').toUpperCase(),
      especie:  c.req.query('especie') || 'IFR',
      tipo:     c.req.query('tipo'),
      useAll:   '1',
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 3. NOTAM
// ATENÇÃO: o parâmetro correto é 'icaoCode' (não 'icaocode' em minúsculas)
app.get('/api/notam/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'notam', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 4. InfoTemp (ROTAER)
app.get('/api/infotemp/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'infotemp', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 5. Nascer/Pôr do Sol
// CORREÇÃO 3: dt_f é obrigatório quando dt_i é informado → gerado automaticamente
app.get('/api/solar/:icao', async (c) => {
  try {
    const dt_i = c.req.query('date');   // ex: 2025-08-10
    const dt_f = c.req.query('date_f'); // opcional, padrão = mesmo dia

    const params: Record<string, string | undefined> = {
      icaoCode: c.req.param('icao').toUpperCase(),
    };

    if (dt_i) {
      params.dt_i = dt_i;
      // CORREÇÃO 3: dt_f obrigatório se dt_i for fornecido
      params.dt_f = dt_f ?? dt_i;
    }

    const data = await fetchAisweb(c, 'sol', params);
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 6. Rotas Preferenciais
app.get('/api/routes', async (c) => {
  try {
    const adep = c.req.query('adep');
    const ades = c.req.query('ades');

    if (!adep || !ades) {
      return c.json({ error: 'Parâmetros adep e ades são obrigatórios' }, 400);
    }

    const data = await fetchAisweb(c, 'routesp', {
      adep: adep.toUpperCase(),
      ades: ades.toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 7. Waypoints
app.get('/api/waypoints', async (c) => {
  try {
    const data = await fetchAisweb(c, 'waypoints', {});
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// 8. ROTAER (dados do aeródromo)
app.get('/api/rotaer/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'rotaer', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

export default { fetch: app.fetch };
