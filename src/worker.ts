import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { cache } from 'hono/cache';
import { createClient } from '@supabase/supabase-js';

// Types
type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  CACHE_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use('*', cors());

// Helper to create Supabase client
const getSupabase = (c: any) => {
  return createClient(
    c.env.SUPABASE_URL,
    c.env.SUPABASE_ANON_KEY
  );
};

// Cache helper
const getCached = async (c: any, key: string, ttl: number, fetchFn: () => Promise<any>) => {
  const cached = await c.env.CACHE_KV.get(key, 'json');
  
  if (cached) {
    return { ...cached, cached: true };
  }
  
  const data = await fetchFn();
  await c.env.CACHE_KV.put(key, JSON.stringify(data), { expirationTtl: ttl });
  
  return { ...data, cached: false };
};

// ============= HEALTH CHECK =============
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    platform: 'Cloudflare Workers'
  });
});

// ============= USERS ROUTES =============

// GET all users (cached - 10 min)
app.get('/users', async (c) => {
  try {
    const result = await getCached(c, 'users:all', 600, async () => {
      const supabase = getSupabase(c);
      const { data, error } = await supabase.from('users').select('*');
      
      if (error) throw error;
      
      return { data, timestamp: new Date().toISOString() };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch users', message: error.message }, 500);
  }
});

// GET user by ID (cached - 10 min)
app.get('/users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    const result = await getCached(c, `users:${id}`, 600, async () => {
      const supabase = getSupabase(c);
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .single();
      
      if (error) throw error;
      
      return { data, timestamp: new Date().toISOString() };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch user', message: error.message }, 500);
  }
});

// GET user profile with related data (cached - 10 min)
app.get('/users/:id/profile', async (c) => {
  try {
    const id = c.req.param('id');
    
    const result = await getCached(c, `users:${id}:profile`, 600, async () => {
      const supabase = getSupabase(c);
      
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .single();
      
      if (userError) throw userError;
      
      let relatedData: any = {};
      
      if (user.role === 'pilot' || user.role === 'crew') {
        const { data: licenses } = await supabase
          .from('crew_licenses')
          .select('*')
          .eq('crew_id', id);
        relatedData = { ...relatedData, licenses };
      }
      
      if (user.role === 'admin' || user.role === 'manager') {
        const { data: permissions } = await supabase
          .from('role_permissions')
          .select('*')
          .eq('role_id', user.role);
        relatedData = { ...relatedData, permissions };
      }
      
      return { 
        data: { ...user, ...relatedData }, 
        timestamp: new Date().toISOString() 
      };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch user profile', message: error.message }, 500);
  }
});

// ============= FLIGHTS ROUTES =============

// GET flights with filters - NO CACHE (real-time)
app.get('/flights', async (c) => {
  try {
    const supabase = getSupabase(c);
    const { status, date, aircraft_id } = c.req.query();
    
    let query = supabase
      .from('flight_schedules')
      .select(`
        *,
        aircraft:aircraft_id(registration, model),
        crew_members:crew_member_id(full_name, license),
        clients:client_id(company_name)
      `);
    
    if (status) {
      query = query.eq('status', status);
    }
    
    if (date) {
      query = query.eq('flight_date', date);
    }
    
    if (aircraft_id) {
      query = query.eq('aircraft_id', aircraft_id);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    return c.json({ 
      data, 
      timestamp: new Date().toISOString(),
      cached: false 
    });
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch flights', message: error.message }, 500);
  }
});

// GET flight by ID (cached - 2 min)
app.get('/flights/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    const result = await getCached(c, `flights:${id}`, 120, async () => {
      const supabase = getSupabase(c);
      
      const { data: flight, error } = await supabase
        .from('flight_schedules')
        .select(`
          *,
          aircraft:aircraft_id(registration, model, max_range),
          crew_members:crew_member_id(full_name, license, flight_hours),
          clients:client_id(company_name, contact_person),
          flight_plans(*)
        `)
        .eq('id', id)
        .single();
      
      if (error) throw error;
      
      const { data: weather } = await supabase
        .from('flight_weather')
        .select('*')
        .eq('flight_id', id)
        .single();
      
      return { 
        data: { ...flight, weather }, 
        timestamp: new Date().toISOString()
      };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch flight', message: error.message }, 500);
  }
});

// GET active flights - Real-time, NO CACHE
app.get('/flights/active/now', async (c) => {
  try {
    const supabase = getSupabase(c);
    
    const { data, error } = await supabase
      .from('flight_schedules')
      .select(`
        *,
        aircraft:aircraft_id(registration, model),
        crew_members:crew_member_id(full_name)
      `)
      .eq('status', 'em_voo')
      .order('flight_date', { ascending: false });
    
    if (error) throw error;
    
    return c.json({ 
      data, 
      timestamp: new Date().toISOString(),
      cached: false,
      realtime: true
    });
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch active flights', message: error.message }, 500);
  }
});

// ============= CLIENTS ROUTES =============

// GET all clients (cached - 15 min)
app.get('/clients', async (c) => {
  try {
    const result = await getCached(c, 'clients:all', 900, async () => {
      const supabase = getSupabase(c);
      
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('company_name', { ascending: true });
      
      if (error) throw error;
      
      return { data, timestamp: new Date().toISOString() };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch clients', message: error.message }, 500);
  }
});

// GET client by ID (cached - 15 min)
app.get('/clients/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    const result = await getCached(c, `clients:${id}`, 900, async () => {
      const supabase = getSupabase(c);
      
      const { data: client, error: clientError } = await supabase
        .from('clients')
        .select(`
          *,
          flight_schedules(
            id,
            flight_date,
            origin,
            destination,
            status
          )
        `)
        .eq('id', id)
        .single();
      
      if (clientError) throw clientError;
      
      const { data: expenses } = await supabase
        .from('expenses')
        .select('amount, category')
        .eq('client_id', id);
      
      const totalExpenses = expenses?.reduce((sum, exp) => sum + (exp.amount || 0), 0) || 0;
      
      return { 
        data: { 
          ...client, 
          totalExpenses,
          flightCount: client.flight_schedules?.length || 0 
        }, 
        timestamp: new Date().toISOString()
      };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch client', message: error.message }, 500);
  }
});

// GET client contracts (cached - 1 day)
app.get('/clients/:id/contracts', async (c) => {
  try {
    const id = c.req.param('id');
    
    const result = await getCached(c, `clients:${id}:contracts`, 86400, async () => {
      const supabase = getSupabase(c);
      
      const { data, error } = await supabase
        .from('client_contracts')
        .select('*')
        .eq('client_id', id)
        .order('start_date', { ascending: false });
      
      if (error) throw error;
      
      return { data, timestamp: new Date().toISOString() };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch contracts', message: error.message }, 500);
  }
});

// ============= AIRCRAFT ROUTES =============

// GET all aircraft (cached - 20 min)
app.get('/aircraft', async (c) => {
  try {
    const result = await getCached(c, 'aircraft:all', 1200, async () => {
      const supabase = getSupabase(c);
      
      const { data, error } = await supabase
        .from('aircraft')
        .select('*')
        .eq('status', 'Ativa')
        .order('registration', { ascending: true });
      
      if (error) throw error;
      
      return { data, timestamp: new Date().toISOString() };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch aircraft', message: error.message }, 500);
  }
});

// GET aircraft by ID (cached - 20 min)
app.get('/aircraft/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    const result = await getCached(c, `aircraft:${id}`, 1200, async () => {
      const supabase = getSupabase(c);
      
      const { data: aircraft, error } = await supabase
        .from('aircraft')
        .select(`
          *,
          maintenance_records(
            id,
            maintenance_date,
            type,
            description,
            cost
          )
        `)
        .eq('id', id)
        .single();
      
      if (error) throw error;
      
      return { data: aircraft, timestamp: new Date().toISOString() };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch aircraft', message: error.message }, 500);
  }
});

// ============= WEATHER ROUTES (METAR/TAF) =============

// Helper to fetch METAR from AISWEB API
const fetchAISWebMETAR = async (icao: string): Promise<any> => {
  try {
    const response = await fetch(`https://api.aisweb.aer.mil.br/api/metar/${icao.toUpperCase()}`);
    
    if (!response.ok) {
      console.error(`[AISWEB] Erro ${response.status} para ${icao}`);
      return null;
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`[AISWEB] Erro ao buscar METAR para ${icao}:`, error);
    return null;
  }
};

// Helper to fetch TAF from AISWEB API
const fetchAISWebTAF = async (icao: string): Promise<any> => {
  try {
    const response = await fetch(`https://api.aisweb.aer.mil.br/api/taf/${icao.toUpperCase()}`);
    
    if (!response.ok) {
      console.error(`[AISWEB] Erro ${response.status} para ${icao}`);
      return null;
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`[AISWEB] Erro ao buscar TAF para ${icao}:`, error);
    return null;
  }
};

// Parse temperatura do METAR (23/18 ou M05/M10)
function parseTemperature(metar: string): { temp: number | null; dewp: number | null } {
  const match = metar.match(/(M?)(\d{2})\/(M?)(\d{2})/);
  if (match) {
    const temp = parseInt(match[2]) * (match[1] === 'M' ? -1 : 1);
    const dewp = parseInt(match[4]) * (match[3] === 'M' ? -1 : 1);
    return { temp, dewp };
  }
  return { temp: null, dewp: null };
}

// Parse vento do METAR (09015G25KT ou VRB05KT)
function parseWind(metar: string): { wdir: number | null; wspd: number | null; wgst: number | null } {
  const vrbMatch = metar.match(/VRB(\d{2})KT/);
  if (vrbMatch) {
    return { wdir: null, wspd: parseInt(vrbMatch[1]), wgst: null };
  }
  
  const match = metar.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
  if (match) {
    return {
      wdir: parseInt(match[1]),
      wspd: parseInt(match[2]),
      wgst: match[3] ? parseInt(match[3]) : null
    };
  }
  return { wdir: null, wspd: null, wgst: null };
}

// Parse visibilidade do METAR (10SM ou 9999 ou CAVOK)
function parseVisibility(metar: string): string | number | null {
  const smMatch = metar.match(/(\d+)SM/);
  if (smMatch) return parseInt(smMatch[1]);
  
  const mMatch = metar.match(/\s(\d{4})\s/);
  if (mMatch) return parseInt(mMatch[1]) / 1609.34;
  
  if (metar.includes('CAVOK')) return 9999;
  
  return null;
}

// Parse altímetro do METAR (A2992 ou Q1013)
function parseAltimeter(metar: string): number | null {
  const aMatch = metar.match(/A(\d{4})/);
  if (aMatch) return parseInt(aMatch.substring(0, 2)) + parseInt(aMatch.substring(2)) / 100;
  
  const qMatch = metar.match(/Q(\d{4})/);
  if (qMatch) return parseInt(qMatch[1]) * 0.02953;
  
  return null;
}

// Determinar categoria de voo (VFR, MVFR, IFR, LIFR)
function getFlightCategory(metar: string): 'VFR' | 'MVFR' | 'IFR' | 'LIFR' {
  if (metar.includes('CAVOK')) return 'VFR';
  
  const visibility = parseVisibility(metar);
  const ceilingMatch = metar.match(/([A-Z]{2,3})(\d{3})/);
  
  let ceiling = 99999;
  if (ceilingMatch && (ceilingMatch[1] === 'FEW' || ceilingMatch[1] === 'SCT' || ceilingMatch[1] === 'BKN' || ceilingMatch[1] === 'OVC')) {
    ceiling = parseInt(ceilingMatch[2]) * 100;
  }
  
  const visValue = typeof visibility === 'number' ? visibility : 10;
  
  if (visValue < 1 || ceiling < 500) return 'LIFR';
  if (visValue < 3 || ceiling < 1000) return 'IFR';
  if (visValue < 5 || ceiling < 3000) return 'MVFR';
  return 'VFR';
}

// GET METAR (cached - 5 min)
app.get('/api/weather/metar/:icao', async (c) => {
  try {
    const icao = c.req.param('icao');
    
    const result = await getCached(c, `metar:${icao.toUpperCase()}`, 300, async () => {
      // Tentar buscar dados reais da API AISWEB
      const aiswebData = await fetchAISWebMETAR(icao);
      
      if (!aiswebData || !aiswebData.rawOb) {
        return { 
          error: 'Sem dados METAR disponível',
          icao: icao.toUpperCase(),
          timestamp: new Date().toISOString()
        };
      }
      
      const metar = aiswebData.rawOb;
      const { temp, dewp } = parseTemperature(metar);
      const { wdir, wspd, wgst } = parseWind(metar);
      const visib = parseVisibility(metar);
      const altim = parseAltimeter(metar);
      const flightCategory = getFlightCategory(metar);
      
      return {
        icao: icao.toUpperCase(),
        rawOb: metar,
        temp,
        dewp,
        wdir,
        wspd,
        wgst,
        visib,
        altim,
        flightCategory,
        reportTime: aiswebData.reportTime || new Date().toISOString(),
        updatedTime: new Date().toISOString(),
        source: 'AISWEB',
        timestamp: new Date().toISOString()
      };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ 
      error: 'Failed to fetch METAR', 
      message: error.message,
      icao: c.req.param('icao'),
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// GET TAF (cached - 10 min)
app.get('/api/weather/taf/:icao', async (c) => {
  try {
    const icao = c.req.param('icao');
    
    const result = await getCached(c, `taf:${icao.toUpperCase()}`, 600, async () => {
      // Tentar buscar dados reais da API AISWEB
      const aiswebData = await fetchAISWebTAF(icao);
      
      if (!aiswebData || !aiswebData.rawTAF) {
        return { 
          error: 'Sem dados TAF disponível',
          icao: icao.toUpperCase(),
          timestamp: new Date().toISOString()
        };
      }
      
      return {
        icao: icao.toUpperCase(),
        rawTAF: aiswebData.rawTAF,
        validTimeFrom: aiswebData.validTimeFrom || new Date().toISOString(),
        validTimeTo: aiswebData.validTimeTo || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        source: 'AISWEB',
        timestamp: new Date().toISOString()
      };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ 
      error: 'Failed to fetch TAF', 
      message: error.message,
      icao: c.req.param('icao'),
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// GET múltiplos METARs
app.get('/api/weather/metar', async (c) => {
  try {
    const icaos = c.req.query('icaos')?.split(',') || [];
    
    if (icaos.length === 0) {
      return c.json({ error: 'Nenhum ICAO fornecido', timestamp: new Date().toISOString() }, 400);
    }
    
    const results: Record<string, any> = {};
    
    for (const icao of icaos) {
      try {
        const metarData = await fetchAISWebMETAR(icao);
        
        if (metarData?.rawOb) {
          const metar = metarData.rawOb;
          const { temp, dewp } = parseTemperature(metar);
          const { wdir, wspd, wgst } = parseWind(metar);
          
          results[icao.toUpperCase()] = {
            rawOb: metar,
            temp,
            dewp,
            wdir,
            wspd,
            wgst,
            visib: parseVisibility(metar),
            altim: parseAltimeter(metar),
            flightCategory: getFlightCategory(metar),
            source: 'AISWEB'
          };
        } else {
          results[icao.toUpperCase()] = { error: 'Sem dados disponível' };
        }
      } catch (error: any) {
        results[icao.toUpperCase()] = { error: error.message };
      }
    }
    
    return c.json({ data: results, timestamp: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ 
      error: 'Failed to fetch METARs', 
      message: error.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
});
// ============= AIRPORTS ROUTES =============

// GET airport by ICAO code (cached - 1 day)
app.get('/api/airports/:icao', async (c) => {
  try {
    const icao = c.req.param('icao').toUpperCase().trim();
    
    const result = await getCached(c, `airport:${icao}`, 86400, async () => {
      const supabase = getSupabase(c);
      
      const { data, error } = await supabase
        .from('aerodromes')
        .select('designativo, name, coordenadas')
        .eq('designativo', icao)
        .single();
      
      if (error || !data) {
        console.warn(`Airport ${icao} not found`);
        return {
          error: 'Airport not found',
          icao,
          timestamp: new Date().toISOString()
        };
      }
      
      // Parse coordinates
      const coords = parseCoordinates(data.coordenadas);
      
      if (!coords) {
        return {
          error: 'Invalid coordinates',
          icao,
          timestamp: new Date().toISOString()
        };
      }
      
      return {
        icao: data.designativo,
        name: data.name,
        lat: coords.lat,
        lng: coords.lng,
        timestamp: new Date().toISOString()
      };
    });
    
    return c.json(result);
  } catch (error: any) {
    return c.json({ 
      error: 'Failed to fetch airport', 
      message: error.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// GET airports search (NOT cached - real-time search)
app.get('/api/airports/search', async (c) => {
  try {
    const q = c.req.query('q')?.toUpperCase() || '';
    
    if (!q || q.length < 2) {
      return c.json({ 
        error: 'Query must be at least 2 characters',
        results: [],
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    const supabase = getSupabase(c);
    
    // Search by designativo (ICAO) or name
    const { data, error } = await supabase
      .from('aerodromes')
      .select('designativo, name, coordenadas')
      .or(`designativo.ilike.%${q}%,name.ilike.%${q}%`)
      .limit(20);
    
    if (error) throw error;
    
    const results = (data || [])
      .map((aero: any) => {
        const coords = parseCoordinates(aero.coordenadas);
        if (!coords) return null;
        
        return {
          icao: aero.designativo,
          name: aero.name,
          lat: coords.lat,
          lng: coords.lng
        };
      })
      .filter(Boolean);
    
    return c.json({ 
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    return c.json({ 
      error: 'Failed to search airports', 
      message: error.message,
      results: [],
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// ============= FLIGHT CALCULATIONS ROUTES =============

// Helper: Parse coordinates from DMS or decimal format
function parseCoordinates(coordStr: string | null): { lat: number; lng: number } | null {
  if (!coordStr) return null;

  // Try DMS format: N23°32'20" W46°28'10"
  const dmsMatch = coordStr.match(
    /([NS])(\d+)°(\d+)'(\d+)"?\s*([EW])(\d+)°(\d+)'(\d+)"?/i
  );
  if (dmsMatch) {
    const lat = (
      parseInt(dmsMatch[2]) +
      parseInt(dmsMatch[3]) / 60 +
      parseInt(dmsMatch[4]) / 3600
    ) * (dmsMatch[1].toUpperCase() === 'S' ? -1 : 1);

    const lng = (
      parseInt(dmsMatch[6]) +
      parseInt(dmsMatch[7]) / 60 +
      parseInt(dmsMatch[8]) / 3600
    ) * (dmsMatch[5].toUpperCase() === 'W' ? -1 : 1);

    return { lat, lng };
  }

  // Try decimal format: -23.5389, -46.4697 or -23.5389,-46.4697
  const decimalMatch = coordStr.match(/([-\d.]+)[,\s]+([-\d.]+)/);
  if (decimalMatch) {
    return {
      lat: parseFloat(decimalMatch[1]),
      lng: parseFloat(decimalMatch[2]),
    };
  }

  return null;
}

// Helper: Calculate distance between two points (Haversine formula)
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): { nm: number; km: number } {
  const R = 3440.065; // Earth radius in nautical miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const nm = R * c;
  
  return {
    nm: Math.round(nm * 10) / 10,
    km: Math.round(nm * 1.852 * 10) / 10
  };
}

// Helper: Calculate solar times (sunrise, sunset, dawn, dusk)
function calculateSolarTimes(lat: number, lng: number, date: Date): any {
  // Approximation for solar times in Brazil (simplified)
  // In production, use proper library like suncalc
  
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000);
  
  // Approximate sunrise/sunset calculation
  // Using a simplified formula for Brazil
  const B = (360 / 365) * (dayOfYear - 81);
  const B_rad = (B * Math.PI) / 180;
  
  const eot = 9.87 * Math.sin(2 * B_rad) - 7.53 * Math.cos(B_rad) - 1.5 * Math.sin(B_rad);
  
  // Standard time correction
  const timeZoneOffset = -3 * 60; // UTC-3 for Brazil
  const lng_offset = (-lng / 15) * 60;
  const timeCorrection = timeZoneOffset + lng_offset + eot;
  
  // Solar declination
  const decl_rad = (23.45 * Math.sin(B_rad) * Math.PI) / 180;
  const lat_rad = (lat * Math.PI) / 180;
  
  // Sunrise/Sunset calculation
  const cos_h = -Math.tan(lat_rad) * Math.tan(decl_rad);
  const h_rad = Math.acos(Math.max(-1, Math.min(1, cos_h)));
  const h_deg = (h_rad * 180) / Math.PI;
  
  const sunrise_minutes = 720 - (4 * h_deg) - timeCorrection;
  const sunset_minutes = 720 + (4 * h_deg) - timeCorrection;
  const dawn_minutes = sunrise_minutes - 30;
  const dusk_minutes = sunset_minutes + 30;
  
  const formatTime = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    return {
      time: `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`,
      minutes: Math.round(minutes)
    };
  };
  
  return {
    sunrise: formatTime(sunrise_minutes),
    sunset: formatTime(sunset_minutes),
    dawn: formatTime(dawn_minutes),
    dusk: formatTime(dusk_minutes)
  };
}

// Helper: Calculate night time for a flight
function calculateNightTime(
  depLat: number, depLng: number,
  arrLat: number, arrLng: number,
  departureTime: string,
  arrivalTime: string,
  flightDate: string
): number {
  // Simplified calculation: count 30 minutes before sunset to 30 minutes after sunrise
  try {
    const [depHour, depMin] = departureTime.split(':').map(Number);
    const [arrHour, arrMin] = arrivalTime.split(':').map(Number);
    
    const depDate = new Date(flightDate);
    const depDateTime = new Date(depDate.getFullYear(), depDate.getMonth(), depDate.getDate(), depHour, depMin);
    
    const arrDate = new Date(flightDate);
    const arrDateTime = new Date(arrDate.getFullYear(), arrDate.getMonth(), arrDate.getDate(), arrHour, arrMin);
    
    // If arrival is before departure, assume next day
    if (arrDateTime < depDateTime) {
      arrDateTime.setDate(arrDateTime.getDate() + 1);
    }
    
    // Calculate average position (middle of route)
    const avgLat = (depLat + arrLat) / 2;
    const avgLng = (depLng + arrLng) / 2;
    
    // Get solar times for both departure and arrival
    const depSolar = calculateSolarTimes(depLat, depLng, depDate);
    const arrSolar = calculateSolarTimes(arrLat, arrLng, arrDate);
    
    // Parse times
    const parseTimeStr = (timeStr: string) => {
      const [h, m] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };
    
    const duskDep = parseTimeStr(depSolar.dusk.time);
    const dawnArr = parseTimeStr(arrSolar.dawn.time);
    
    const depTimeMinutes = depHour * 60 + depMin;
    const arrTimeMinutes = arrHour * 60 + arrMin;
    
    let nightMinutes = 0;
    
    // If departure is after dusk
    if (depTimeMinutes > duskDep) {
      if (arrTimeMinutes < dawnArr) {
        // Entire flight is night
        nightMinutes = arrTimeMinutes - depTimeMinutes;
      } else {
        // Flight started in night, ended in day
        nightMinutes = dawnArr - depTimeMinutes;
      }
    } else {
      // Departure is during day
      if (arrTimeMinutes > duskDep) {
        // Flight ended in night
        nightMinutes = arrTimeMinutes - duskDep;
      }
    }
    
    // Ensure positive value
    return Math.max(0, nightMinutes);
  } catch (error) {
    console.error('Error calculating night time:', error);
    return 0;
  }
}

// POST Flight Calculations
app.post('/api/flight-calculations', async (c) => {
  try {
    const payload = await c.req.json();
    const { departureIcao, arrivalIcao, arrivalManual, flightDate, landingTime } = payload;
    
    // Validations
    if (!departureIcao || !flightDate || !landingTime) {
      return c.json({
        error: 'Missing required fields: departureIcao, flightDate, landingTime',
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    if (!arrivalIcao && !arrivalManual) {
      return c.json({
        error: 'Missing arrival: provide either arrivalIcao or arrivalManual',
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    const supabase = getSupabase(c);
    
    // Get departure airport
    const { data: depData, error: depError } = await supabase
      .from('aerodromes')
      .select('designativo, name, coordenadas')
      .eq('designativo', departureIcao.toUpperCase())
      .single();
    
    if (depError || !depData) {
      return c.json({
        error: `Departure airport ${departureIcao} not found`,
        timestamp: new Date().toISOString()
      }, 404);
    }
    
    const depCoords = parseCoordinates(depData.coordenadas);
    if (!depCoords) {
      return c.json({
        error: 'Invalid departure coordinates',
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    let arrCoords: any;
    let arrivalName: string;
    let arrivalIcaoCode: string;
    
    if (arrivalManual) {
      // Use manual coordinates
      arrCoords = { lat: arrivalManual.lat, lng: arrivalManual.lng };
      arrivalName = arrivalManual.nome;
      arrivalIcaoCode = 'MANUAL';
    } else {
      // Get arrival airport from database
      const { data: arrData, error: arrError } = await supabase
        .from('aerodromes')
        .select('designativo, name, coordenadas')
        .eq('designativo', arrivalIcao.toUpperCase())
        .single();
      
      if (arrError || !arrData) {
        return c.json({
          error: `Arrival airport ${arrivalIcao} not found`,
          timestamp: new Date().toISOString()
        }, 404);
      }
      
      arrCoords = parseCoordinates(arrData.coordenadas);
      if (!arrCoords) {
        return c.json({
          error: 'Invalid arrival coordinates',
          timestamp: new Date().toISOString()
        }, 400);
      }
      
      arrivalName = arrData.name;
      arrivalIcaoCode = arrData.designativo;
    }
    
    // Calculate distance
    const distance = calculateDistance(depCoords.lat, depCoords.lng, arrCoords.lat, arrCoords.lng);
    
    // Calculate solar times
    const depDate = new Date(flightDate);
    const solarTimes = calculateSolarTimes(
      (depCoords.lat + arrCoords.lat) / 2,
      (depCoords.lng + arrCoords.lng) / 2,
      depDate
    );
    
    // Estimate departure time (assuming 1 hour before landing, or 2 hours for longer flights)
    const flightTimeMinutes = (distance.nm / 250) * 60; // assuming 250 knots cruise
    const [arrHour, arrMin] = landingTime.split(':').map(Number);
    const arrMinutes = arrHour * 60 + arrMin;
    const depMinutes = arrMinutes - Math.round(flightTimeMinutes);
    const depHour = Math.floor(depMinutes / 60);
    const depMin = depMinutes % 60;
    const departureTime = `${String(depHour).padStart(2, '0')}:${String(depMin).padStart(2, '0')}`;
    
    // Calculate night time
    const nightMinutes = calculateNightTime(
      depCoords.lat, depCoords.lng,
      arrCoords.lat, arrCoords.lng,
      departureTime,
      landingTime,
      flightDate
    );
    
    // Check if landing is at night
    const [landHour, landMin] = landingTime.split(':').map(Number);
    const landMinutes = landHour * 60 + landMin;
    const duskMinutes = parseInt(solarTimes.dusk.time.split(':')[0]) * 60 + 
                        parseInt(solarTimes.dusk.time.split(':')[1]);
    const dawnMinutes = parseInt(solarTimes.dawn.time.split(':')[0]) * 60 + 
                        parseInt(solarTimes.dawn.time.split(':')[1]);
    const isNightLanding = landMinutes >= duskMinutes || landMinutes < dawnMinutes;
    
    const response = {
      data: {
        distance,
        nightTime: {
          hours: Math.floor(nightMinutes / 60),
          minutes: nightMinutes % 60,
          decimal: Math.round((nightMinutes / 60) * 100) / 100
        },
        solarTimes,
        flight: {
          departure: { icao: departureIcao.toUpperCase(), name: depData.name },
          arrival: { icao: arrivalIcaoCode, name: arrivalName },
          date: flightDate,
          landingTime,
          isNightFlightAtLanding: isNightLanding
        }
      },
      timestamp: new Date().toISOString()
    };
    
    return c.json(response);
  } catch (error: any) {
    console.error('Flight calculation error:', error);
    return c.json({
      error: 'Failed to calculate flight metrics',
      message: error.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
});


export default app;
