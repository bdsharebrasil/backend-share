import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';

// ============= DEFINIÇÃO DE TIPOS =============
type Bindings = {
  AISWEB_API_KEY: string;
  AISWEB_API_PASS: string;
  VITE_SUPABASE_URL: string;
  VITE_SUPABASE_ANON_KEY: string;
  CACHE_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// ============= MIDDLEWARE =============
app.use('*', cors({
  origin: '*', 
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));

// ============= HELPERS GERAIS =============

const getSupabase = (c: Context<{ Bindings: Bindings }>) => 
  createClient(c.env.VITE_SUPABASE_URL, c.env.VITE_SUPABASE_ANON_KEY);

const isValidICAO = (icao: string) => /^[A-Z]{4}$/.test(icao.toUpperCase().trim());

const getCached = async <T>(
  c: Context<{ Bindings: Bindings }>,
  key: string,
  ttl: number,
  fetchFn: () => Promise<T>
): Promise<{ data: T; cached: boolean; timestamp: string }> => {
  const cached = await c.env.CACHE_KV.get(key, 'json');
  if (cached) {
    return { ...(cached as any), cached: true };
  }
  const data = await fetchFn();
  const storage = { data, timestamp: new Date().toISOString() };
  await c.env.CACHE_KV.put(key, JSON.stringify(storage), { expirationTtl: ttl });
  return { ...storage, cached: false };
};

// ============= PARSERS DE COORDENADAS E CLIMA =============

function parseCoordinates(coordStr: string | null): { lat: number; lng: number } | null {
  if (!coordStr) return null;
  const dmsMatch = coordStr.match(/([NS])\s*(\d+)°?\s*(\d+)'?\s*(\d+)"?\s*([EW])\s*(\d+)°?\s*(\d+)'?\s*(\d+)"?/i);
  if (dmsMatch) {
    const lat = (parseInt(dmsMatch[2]) + parseInt(dmsMatch[3]) / 60 + parseInt(dmsMatch[4]) / 3600) * (dmsMatch[1].toUpperCase() === 'S' ? -1 : 1);
    const lng = (parseInt(dmsMatch[6]) + parseInt(dmsMatch[7]) / 60 + parseInt(dmsMatch[8]) / 3600) * (dmsMatch[5].toUpperCase() === 'W' ? -1 : 1);
    return { lat, lng };
  }
  const decimalMatch = coordStr.match(/([-\d.]+)[,\s]+([-\d.]+)/);
  if (decimalMatch) {
    const lat = parseFloat(decimalMatch[1]);
    const lng = parseFloat(decimalMatch[2]);
    return (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) ? { lat, lng } : null;
  }
  return null;
}

const weatherParsers = {
  temperature: (raw: string) => {
    const match = raw.match(/(M?)(\d{2})\/(M?)(\d{2})/);
    return match ? { 
      temp: parseInt(match[2]) * (match[1] === 'M' ? -1 : 1), 
      dewp: parseInt(match[4]) * (match[3] === 'M' ? -1 : 1) 
    } : { temp: null, dewp: null };
  },
  wind: (raw: string) => {
    const match = raw.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
    return match ? { wdir: parseInt(match[1]), wspd: parseInt(match[2]), wgst: match[3] ? parseInt(match[3]) : null } : { wdir: null, wspd: null, wgst: null };
  },
  category: (raw: string): 'VFR' | 'MVFR' | 'IFR' | 'LIFR' => {
    if (raw.includes('CAVOK')) return 'VFR';
    const ceilingMatch = raw.match(/(BKN|OVC)(\d{3})/);
    if (ceilingMatch) {
      const h = parseInt(ceilingMatch[2]) * 100;
      if (h < 500) return 'LIFR';
      if (h < 1000) return 'IFR';
      if (h < 3000) return 'MVFR';
    }
    return 'VFR';
  }
};

// ============= CÁLCULOS NÁUTICOS E SOLARES =============

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 3440.065; // NM
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const nm = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  return { nm: Math.round(nm * 10) / 10, km: Math.round(nm * 1.852 * 10) / 10 };
}

function calculateSolarTimes(lat: number, lng: number, date: Date) {
  // Simplificado para o fuso do Brasil (UTC-3)
  const sunriseMinutes = 360 - (lng * 4); // Aproximação básica
  const sunsetMinutes = 1080 - (lng * 4);
  const format = (min: number) => `${String(Math.floor((min/60)%24)).padStart(2,'0')}:${String(Math.floor(min%60)).padStart(2,'0')}`;
  return {
    sunrise: { time: format(sunriseMinutes), minutes: sunriseMinutes },
    sunset: { time: format(sunsetMinutes), minutes: sunsetMinutes },
    dawn: { time: format(sunriseMinutes - 30), minutes: sunriseMinutes - 30 },
    dusk: { time: format(sunsetMinutes + 30), minutes: sunsetMinutes + 30 }
  };
}

// ============= ROTAS =============

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// METAR AISWEB
app.get('/api/weather/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase();
  if (!isValidICAO(icao)) return c.json({ error: 'ICAO Inválido' }, 400);

  try {
    const result = await getCached(c, `weather:${icao}`, 300, async () => {
      const url = `https://api.aisweb.aer.mil.br/api/?apiKey=${c.env.AISWEB_API_KEY}&apiPass=${c.env.AISWEB_API_PASS}&area=metar&icao=${icao}`;
      const res = await fetch(url);
      const data: any = await res.json();
      const raw = data?.metar || data?.rawOb;
      if (!raw) throw new Error('Dados não encontrados');
      return { icao, raw, ...weatherParsers.temperature(raw), ...weatherParsers.wind(raw), category: weatherParsers.category(raw) };
    });
    return c.json(result);
  } catch (err: any) { return c.json({ error: err.message }, 500); }
});

// AERÓDROMOS
app.get('/api/airports/:icao', async (c) => {
  const icao = c.req.param('icao').toUpperCase();
  const result = await getCached(c, `airport:${icao}`, 86400, async () => {
    const { data, error } = await getSupabase(c).from('aerodromes').select('*').eq('designativo', icao).single();
    if (error || !data) throw new Error('Aeródromo não encontrado');
    const coords = parseCoordinates(data.coordenadas);
    return { icao: data.designativo, name: data.name, ...coords };
  });
  return c.json(result);
});

// CÁLCULO DE VOO COMPLETO
app.post('/api/flight-calculations', async (c) => {
  const { departureIcao, arrivalIcao, flightDate, landingTime, departureTime } = await c.req.json();
  const supabase = getSupabase(c);

  const { data: airps } = await supabase.from('aerodromes').select('*').in('designativo', [departureIcao.toUpperCase(), arrivalIcao.toUpperCase()]);
  if (!airps || airps.length < 2) return c.json({ error: 'Aeródromos não encontrados' }, 404);

  const dep = airps.find(a => a.designativo === departureIcao.toUpperCase());
  const arr = airps.find(a => a.designativo === arrivalIcao.toUpperCase());
  const cDep = parseCoordinates(dep.coordenadas)!;
  const cArr = parseCoordinates(arr.coordenadas)!;

  const dist = calculateDistance(cDep.lat, cDep.lng, cArr.lat, cArr.lng);
  const solar = calculateSolarTimes((cDep.lat + cArr.lat)/2, (cDep.lng + cArr.lng)/2, new Date(flightDate));

  return c.json({ data: { distance: dist, solarTimes: solar, flight: { departureIcao, arrivalIcao, date: flightDate } } });
});

// USUÁRIOS
app.get('/api/users', async (c) => {
  const res = await getCached(c, 'users:all', 600, async () => {
    const { data } = await getSupabase(c).from('users').select('*');
    return data;
  });
  return c.json(res);
});

// VOOS ATIVOS
app.get('/api/flights/active', async (c) => {
  const { data, error } = await getSupabase(c).from('flight_schedules').select('*, aircraft:aircraft_id(registration)').eq('status', 'em_voo');
  return c.json({ data, cached: false });
});

export default app;
