import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { XMLParser } from 'fast-xml-parser';

type Bindings = {
  AISWEB_API_KEY: string;
  AISWEB_API_PASS: string;
  CACHE_KV: KVNamespace;
  AI: any;
};

const app = new Hono<{ Bindings: Bindings }>();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ['item', 'notam', 'carta', 'sol'].includes(name),
});

app.use('*', cors());

const AISWEB_BASE_URL = 'https://api.decea.mil.br/aisweb/';

const AREA_NODE_MAP: Record<string, string> = {
  met:         'met',
  cartas:      'cartas',
  notam:       'notam',
  infotemp:    'infotemp',
  sol:         'sol',
  routesp:     'routesp',
  waypoints:   'waypoints',
  rotaer:      'rotaer',
  pub:         'pub',
  suplementos: 'suplementos',
  geiloc:      'geiloc',
};

const fetchAisweb = async (
  c: Context<{ Bindings: Bindings }>,
  area: string,
  additionalParams: Record<string, string | undefined>
) => {
  const apiKey  = c.env.AISWEB_API_KEY?.trim();
  const apiPass = c.env.AISWEB_API_PASS?.trim();

  if (!apiKey || !apiPass) {
    throw new Error(`Credenciais AISWEB ausentes`);
  }

  const parts: string[] = [
    `apiKey=${apiKey}`,
    `apiPass=${apiPass}`,
    `area=${area}`,
  ];
  Object.entries(additionalParams).forEach(([k, v]) => {
    if (v !== undefined && v !== '') parts.push(`${k}=${v}`);
  });

  const url = `${AISWEB_BASE_URL}?${parts.join('&')}`;

  console.log(`[AISWEB] area=${area} params=${JSON.stringify(additionalParams)}`);

  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':     'text/xml, application/xml, */*',
    },
  });

  const text = await res.text();

  if (!res.ok)                              throw new Error(`HTTP ${res.status}`);
  if (!text || text.trim() === '')          throw new Error('Resposta vazia');
  if (text.includes('Erro nos parametros')) throw new Error('Parâmetros rejeitados pela AISWEB');

  try { return JSON.parse(text); } catch { /* segue XML */ }

  const parsed = parser.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Falha ao parsear XML');

  const aisweb  = parsed['aisweb'] ?? parsed;
  const nodeKey = AREA_NODE_MAP[area];
  return (nodeKey && aisweb[nodeKey] !== undefined) ? aisweb[nodeKey] : aisweb;
};

// ─── HELPERS de coordenada ────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Tenta extrair lat/lon de um item de aeródromo retornado pela AisWeb.
 * A AisWeb devolve coordenadas em vários formatos:
 * - Decimal: "-23.4356" / "-46.4731"
 * - GMS compacto: "234100S" / "0464400W"  (DDMMSS + hemisfério)
 */
function parseCoord(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null) return null;

  // Já é número
  if (typeof raw === 'number') return raw;

  const s = String(raw).trim();

  // Decimal puro: "-23.435" ou "23.435"
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);

  // GMS compacto AisWeb: "234100S", "0464400W", "234100N", "0000000E"
  // Pode ter 6 ou 7 dígitos antes do hemisfério
  const gms = s.match(/^(\d{2,3})(\d{2})(\d{2})[,.]?(\d*)([NSEW])$/i);
  if (gms) {
    const deg = parseInt(gms[1], 10);
    const min = parseInt(gms[2], 10);
    const sec = parseInt(gms[3], 10);
    const dec = deg + min / 60 + sec / 3600;
    const hem = gms[5].toUpperCase();
    return (hem === 'S' || hem === 'W') ? -dec : dec;
  }

  // Fallback: parseInt/parseFloat simples
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  distKm: number;
}

/** Normaliza a lista de aeródromos vinda de qualquer formato de resposta GEILOC/ROTAER */
function normalizeAirportList(data: any, userLat: number, userLon: number): Airport[] {
  if (!data) return [];

  // O parser pode retornar objeto único ou array
  const src = data?.geiloc ?? data?.rotaer ?? data?.item ?? data;
  const items: any[] = Array.isArray(src) ? src : [src];

  const results: Airport[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const icao =
      item?.icaoCode?.trim() ??
      item?.icao?.trim() ??
      item?.CodICAO?.trim() ??
      item?.['@_icao']?.trim() ??
      '';

    if (!icao || icao.length !== 4) continue;

    const rawLat =
      item?.latitude  ?? item?.lat  ?? item?.Latitude  ??
      item?.latGMS    ?? item?.LatGMS;
    const rawLon =
      item?.longitude ?? item?.lon  ?? item?.Longitude ??
      item?.lonGMS    ?? item?.LonGMS;

    const lat = parseCoord(rawLat);
    const lon = parseCoord(rawLon);

    if (lat === null || lon === null) continue;

    const name =
      item?.nome?.trim() ?? item?.name?.trim() ??
      item?.Name?.trim() ?? icao;

    const distKm = Math.round(haversineKm(userLat, userLon, lat, lon));

    results.push({ icao, name, lat, lon, distKm });
  }

  return results;
}

// ============= ROTAS =============

app.get('/', (c) => c.text('ShareBrasil API - Central DECEA Ativa 🚀'));

// 1. Meteorologia (METAR/TAF) - Resposta Raw da AisWeb
app.get('/api/weather/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'met', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 1b. Meteorologia com Tradução IA (Llama 3)
app.get('/api/weather-human/:icao', async (c) => {
  try {
    const icao = c.req.param('icao').toUpperCase();
    
    // Busca os dados originais usando sua função
    const data = await fetchAisweb(c, 'met', {
      icaoCode: icao,
    });
    
    // Tenta extrair a string do METAR (lida com o fato de 'item' poder ser array ou objeto)
    const items = Array.isArray(data?.item) ? data.item : [data?.item];
    const metarString = items[0]?.metar ?? null;

    if (!metarString) {
      return c.json({ error: 'Nenhum METAR encontrado para este ICAO na AisWeb' }, 404);
    }

    // Chama a IA do Cloudflare
    const iaResponse = await c.env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { 
          role: 'system', 
          content: 'Você é um copiloto especialista em aviação. Traduza a string do METAR para português claro, resumido e em linguagem natural para um piloto. Seja direto, não use jargões complexos e não invente dados.' 
        },
        { 
          role: 'user', 
          content: `Traduza este METAR: ${metarString}` 
        }
      ]
    });

    // Retorna o pacote completo para o frontend
    return c.json({
      icao: icao,
      metar_raw: metarString,
      traducao_ia: iaResponse.response
    });

  } catch (err: any) { 
    return c.json({ error: err.message }, 502); 
  }
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
    const data = await fetchAisweb(c, 'notam', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 4. InfoTemp
app.get('/api/infotemp/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'infotemp', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 5. ROTAER (aeródromos)
app.get('/api/rotaer/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'rotaer', {
      icaoCode: c.req.param('icao').toUpperCase(),
    });
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

// 9. GEILOC por ICAO (rota original)
app.get('/api/geiloc', async (c) => {
  try {
    const data = await fetchAisweb(c, 'geiloc', {
      icaoCode: c.req.query('icao')?.toUpperCase(),
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// ─── NOVA ROTA ────────────────────────────────────────────────────────────────
// 9b. GEILOC por proximidade geográfica
//
//   GET /api/geiloc/nearby?lat=-23.43&lon=-46.47
//   GET /api/geiloc/nearby?lat=-23.43&lon=-46.47&limit=5
//
//   Retorna lista de aeródromos mais próximos, ordenados por distância,
//   com campo distKm calculado no Worker.
//
//   Estratégia:
//     1. Chama geiloc sem icaoCode → AisWeb devolve lista geral de aeródromos
//     2. Normaliza coordenadas (decimal ou GMS compacto)
//     3. Ordena por haversine e devolve os `limit` mais próximos
//     4. Se a AisWeb não devolver lista utilizável, faz fallback com ROTAER
//        (que tem mais dados de coordenadas) chamando sem ICAO também.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/geiloc/nearby', async (c) => {
  // Validação dos parâmetros
  const latStr = c.req.query('lat');
  const lonStr = c.req.query('lon');
  const limit  = Math.min(parseInt(c.req.query('limit') ?? '1', 10), 20);

  if (!latStr || !lonStr) {
    return c.json({ error: 'Parâmetros obrigatórios: lat e lon' }, 400);
  }

  const userLat = parseFloat(latStr);
  const userLon = parseFloat(lonStr);

  if (isNaN(userLat) || isNaN(userLon)) {
    return c.json({ error: 'lat e lon devem ser números válidos' }, 400);
  }

  if (userLat < -90 || userLat > 90 || userLon < -180 || userLon > 180) {
    return c.json({ error: 'Coordenadas fora do intervalo válido' }, 400);
  }

  try {
    let airports: Airport[] = [];

    // Tentativa 1: geiloc sem icaoCode (lista geral)
    try {
      const raw = await fetchAisweb(c, 'geiloc', {});
      airports = normalizeAirportList(raw, userLat, userLon);
    } catch (e) {
      console.warn('[nearby] geiloc sem icao falhou:', e);
    }

    // Tentativa 2: rotaer sem icaoCode como fallback
    if (airports.length === 0) {
      try {
        const raw = await fetchAisweb(c, 'rotaer', {});
        airports = normalizeAirportList(raw, userLat, userLon);
      } catch (e) {
        console.warn('[nearby] rotaer fallback falhou:', e);
      }
    }

    if (airports.length === 0) {
      return c.json({ error: 'Nenhum aeródromo encontrado na AisWeb' }, 502);
    }

    // Ordena por distância e limita
    airports.sort((a, b) => a.distKm - b.distKm);
    const nearest = airports.slice(0, limit);

    return c.json({
      userLocation: { lat: userLat, lon: userLon },
      count: nearest.length,
      airports: nearest,
    });

  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
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

export default { fetch: app.fetch };
