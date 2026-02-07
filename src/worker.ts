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

// Parse vento do METAR (09015G25KT ou VRB05KT) - CORRIGIDO
function parseWind(metar: string): { wdir: number | null; wspd: number | null; wgst: number | null } {
  // Variable wind
  const vrbMatch = metar.match(/VRB(\d{2})KT/);
  if (vrbMatch) {
    return { wdir: null, wspd: parseInt(vrbMatch[1]), wgst: null };
  }
  
  // Normal wind with optional gusts
  const match = metar.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
  if (match) {
    const wdir = parseInt(match[1]);
    const wspd = parseInt(match[2]);
    const wgst = match[3] ? parseInt(match[3]) : null;
    
    // Validate wind direction (0-360)
    if (wdir < 0 || wdir > 360) {
      return { wdir: null, wspd, wgst };
    }
    
    return { wdir, wspd, wgst };
  }
  
  return { wdir: null, wspd: null, wgst: null };
}

// Parse visibilidade do METAR (10SM ou 9999 ou CAVOK)
function parseVisibility(metar: string): number | null {
  // CAVOK = visibility 10km or more
  if (metar.includes('CAVOK')) return 9999;
  
  // Statute miles (US format)
  const smMatch = metar.match(/(\d+)SM/);
  if (smMatch) return parseInt(smMatch[1]) * 1609; // Convert to meters
  
  // Meters (ICAO format)
  const mMatch = metar.match(/\s(\d{4})\s/);
  if (mMatch) return parseInt(mMatch[1]);
  
  return null;
}

// Parse altímetro do METAR (A2992 ou Q1013) - CORRIGIDO
function parseAltimeter(metar: string): number | null {
  // US format (inHg * 100)
  const aMatch = metar.match(/A(\d{4})/);
  if (aMatch) {
    const value = aMatch[1];
    return parseInt(value.substring(0, 2)) + parseInt(value.substring(2)) / 100;
  }
  
  // ICAO format (hPa)
  const qMatch = metar.match(/Q(\d{4})/);
  if (qMatch) {
    return parseInt(qMatch[1]) * 0.02953; // Convert hPa to inHg
  }
  
  return null;
}

// Determinar categoria de voo (VFR, MVFR, IFR, LIFR) - CORRIGIDO
function getFlightCategory(metar: string): 'VFR' | 'MVFR' | 'IFR' | 'LIFR' {
  if (metar.includes('CAVOK')) return 'VFR';
  
  const visibility = parseVisibility(metar);
  
  // Find ceiling (only BKN or OVC count as ceiling, not FEW or SCT)
  const cloudMatches = metar.match(/\b(FEW|SCT|BKN|OVC)(\d{3})/g);
  let ceiling = 99999;
  
  if (cloudMatches) {
    for (const match of cloudMatches) {
      const type = match.substring(0, 3);
      const height = parseInt(match.substring(3)) * 100;
      
      // Only BKN (5-7 oktas) and OVC (8 oktas) count as ceiling
      if ((type === 'BKN' || type === 'OVC') && height < ceiling) {
        ceiling = height;
      }
    }
  }
  
  const visMeters = visibility || 10000;
  
  // LIFR: visibility < 1SM (1609m) or ceiling < 500ft
  if (visMeters < 1609 || ceiling < 500) return 'LIFR';
  
  // IFR: visibility < 3SM (4828m) or ceiling < 1000ft
  if (visMeters < 4828 || ceiling < 1000) return 'IFR';
  
  // MVFR: visibility 3-5SM (4828-8046m) or ceiling 1000-3000ft
  if (visMeters < 8046 || ceiling < 3000) return 'MVFR';
  
  return 'VFR';
}

// Validate ICAO code - NOVO
function isValidICAO(icao: string): boolean {
  return /^[A-Z]{4}$/i.test(icao);
}

// GET METAR (cached - 5 min) - CORRIGIDO
app.get('/api/weather/metar/:icao', async (c) => {
  try {
    const icao = c.req.param('icao').toUpperCase();
    
    // Validate ICAO
    if (!isValidICAO(icao)) {
      return c.json({ 
        error: 'ICAO inválido (deve ter 4 letras)',
        icao,
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    const result = await getCached(c, `metar:${icao}`, 300, async () => {
      // Tentar buscar dados reais da API AISWEB
      const aiswebData = await fetchAISWebMETAR(icao);
      
      if (!aiswebData || !aiswebData.rawOb) {
        return { 
          error: 'Sem dados METAR disponível',
          icao,
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
        icao,
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
    const icao = c.req.param('icao').toUpperCase();
    
    // Validate ICAO
    if (!isValidICAO(icao)) {
      return c.json({ 
        error: 'ICAO inválido (deve ter 4 letras)',
        icao,
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    const result = await getCached(c, `taf:${icao}`, 600, async () => {
      // Tentar buscar dados reais da API AISWEB
      const aiswebData = await fetchAISWebTAF(icao);
      
      if (!aiswebData || !aiswebData.rawTAF) {
        return { 
          error: 'Sem dados TAF disponível',
          icao,
          timestamp: new Date().toISOString()
        };
      }
      
      return {
        icao,
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

// GET múltiplos METARs - MELHORADO
app.get('/api/weather/metar', async (c) => {
  try {
    const icaos = c.req.query('icaos')?.split(',').map(i => i.trim().toUpperCase()) || [];
    
    if (icaos.length === 0) {
      return c.json({ error: 'Nenhum ICAO fornecido', timestamp: new Date().toISOString() }, 400);
    }
    
    // Validate all ICAOs
    const invalidIcaos = icaos.filter(icao => !isValidICAO(icao));
    if (invalidIcaos.length > 0) {
      return c.json({ 
        error: `ICAOs inválidos: ${invalidIcaos.join(', ')}`,
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    const results: Record<string, any> = {};
    
    for (const icao of icaos) {
      try {
        const metarData = await fetchAISWebMETAR(icao);
        
        if (metarData?.rawOb) {
          const metar = metarData.rawOb;
          const { temp, dewp } = parseTemperature(metar);
          const { wdir, wspd, wgst } = parseWind(metar);
          
          results[icao] = {
            rawOb: metar,
            temp,
            dewp,
            wdir,
            wspd,
            wgst,
            visib: parseVisibility(metar),
            altim: parseAltimeter(metar),
            flightCategory: getFlightCategory(metar),
            reportTime: metarData.reportTime || new Date().toISOString(),
            source: 'AISWEB'
          };
        } else {
          results[icao] = { error: 'Sem dados disponível' };
        }
      } catch (error: any) {
        results[icao] = { error: error.message };
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

// Helper: Parse coordinates from DMS or decimal format - MELHORADO
function parseCoordinates(coordStr: string | null): { lat: number; lng: number } | null {
  if (!coordStr) return null;

  // Try DMS format with symbols: N23°32'20" W46°28'10"
  const dmsMatch = coordStr.match(
    /([NS])\s*(\d+)°?\s*(\d+)'?\s*(\d+)"?\s*([EW])\s*(\d+)°?\s*(\d+)'?\s*(\d+)"?/i
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
    const lat = parseFloat(decimalMatch[1]);
    const lng = parseFloat(decimalMatch[2]);
    
    // Validate ranges
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

// GET airport by ICAO code (cached - 1 day)
app.get('/api/airports/:icao', async (c) => {
  try {
    const icao = c.req.param('icao').toUpperCase().trim();
    
    // Validate ICAO
    if (!isValidICAO(icao)) {
      return c.json({ 
        error: 'ICAO inválido (deve ter 4 letras)',
        icao,
        timestamp: new Date().toISOString()
      }, 400);
    }
    
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
    const q = c.req.query('q')?.trim().toUpperCase() || '';
    
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
      count: results.length,
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

// Helper: Calculate solar times (sunrise, sunset, dawn, dusk) - MELHORADO
function calculateSolarTimes(lat: number, lng: number, date: Date): any {
  // Simplified solar calculation for Brazil
  // For production, consider using a library like suncalc for better accuracy
  
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  
  // Julian day calculation
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const jd = jdn + 0.5;
  
  // Number of days since J2000.0
  const n = jd - 2451545.0;
  
  // Mean solar noon
  const J_star = n - lng / 360;
  
  // Solar mean anomaly
  const M = (357.5291 + 0.98560028 * J_star) % 360;
  const M_rad = M * Math.PI / 180;
  
  // Equation of center
  const C = 1.9148 * Math.sin(M_rad) + 0.02 * Math.sin(2 * M_rad) + 0.0003 * Math.sin(3 * M_rad);
  
  // Ecliptic longitude
  const lambda = (M + C + 180 + 102.9372) % 360;
  const lambda_rad = lambda * Math.PI / 180;
  
  // Solar transit
  const J_transit = 2451545.0 + J_star + 0.0053 * Math.sin(M_rad) - 0.0069 * Math.sin(2 * lambda_rad);
  
  // Declination of the sun
  const sin_delta = Math.sin(lambda_rad) * Math.sin(23.44 * Math.PI / 180);
  const delta_rad = Math.asin(sin_delta);
  
  // Hour angle
  const lat_rad = lat * Math.PI / 180;
  const cos_omega = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(lat_rad) * Math.sin(delta_rad)) / 
                    (Math.cos(lat_rad) * Math.cos(delta_rad));
  
  // Check if sun rises/sets
  if (cos_omega > 1 || cos_omega < -1) {
    // Polar day or polar night
    return {
      sunrise: { time: '06:00', minutes: 360 },
      sunset: { time: '18:00', minutes: 1080 },
      dawn: { time: '05:30', minutes: 330 },
      dusk: { time: '18:30', minutes: 1110 }
    };
  }
  
  const omega = Math.acos(cos_omega) * 180 / Math.PI;
  
  // Sunrise and sunset Julian days
  const J_rise = J_transit - omega / 360;
  const J_set = J_transit + omega / 360;
  
  // Convert to local time (UTC-3 for Brazil)
  const timeZoneOffset = -3;
  
  const jdToTime = (jd: number) => {
    const hours = ((jd + 0.5) % 1) * 24 + timeZoneOffset;
    const adjustedHours = (hours + 24) % 24;
    const h = Math.floor(adjustedHours);
    const m = Math.floor((adjustedHours - h) * 60);
    return {
      time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      minutes: h * 60 + m
    };
  };
  
  const sunrise = jdToTime(J_rise);
  const sunset = jdToTime(J_set);
  
  return {
    sunrise,
    sunset,
    dawn: { time: sunrise.time, minutes: sunrise.minutes - 30 },
    dusk: { time: sunset.time, minutes: sunset.minutes + 30 }
  };
}

// Helper: Calculate night time for a flight - MELHORADO
function calculateNightTime(
  depLat: number, depLng: number,
  arrLat: number, arrLng: number,
  departureTime: string,
  arrivalTime: string,
  flightDate: string
): number {
  try {
    const [depHour, depMin] = departureTime.split(':').map(Number);
    const [arrHour, arrMin] = arrivalTime.split(':').map(Number);
    
    if (isNaN(depHour) || isNaN(depMin) || isNaN(arrHour) || isNaN(arrMin)) {
      return 0;
    }
    
    const depDate = new Date(flightDate);
    const arrDate = new Date(flightDate);
    
    // Calculate minutes from midnight
    let depMinutes = depHour * 60 + depMin;
    let arrMinutes = arrHour * 60 + arrMin;
    
    // If arrival is before departure, assume next day
    if (arrMinutes < depMinutes) {
      arrMinutes += 24 * 60;
    }
    
    // Calculate average position for solar times
    const avgLat = (depLat + arrLat) / 2;
    const avgLng = (depLng + arrLng) / 2;
    
    const solar = calculateSolarTimes(avgLat, avgLng, depDate);
    
    // Night is from dusk to dawn (civil twilight)
    const duskMinutes = solar.dusk.minutes;
    const dawnMinutes = solar.dawn.minutes;
    const nextDawnMinutes = dawnMinutes + 24 * 60; // Dawn next day
    
    let nightMinutes = 0;
    
    // Case 1: Flight entirely during day
    if (depMinutes >= dawnMinutes && arrMinutes <= duskMinutes) {
      nightMinutes = 0;
    }
    // Case 2: Flight entirely during night
    else if ((depMinutes >= duskMinutes || depMinutes < dawnMinutes) && 
             (arrMinutes >= duskMinutes || arrMinutes < nextDawnMinutes)) {
      nightMinutes = arrMinutes - depMinutes;
    }
    // Case 3: Departure in day, arrival in night
    else if (depMinutes < duskMinutes && arrMinutes > duskMinutes) {
      nightMinutes = arrMinutes - duskMinutes;
    }
    // Case 4: Departure in night, arrival in day
    else if (depMinutes < dawnMinutes && arrMinutes > dawnMinutes) {
      nightMinutes = dawnMinutes - depMinutes;
    }
    // Case 5: Flight crosses both dusk and dawn
    else if (depMinutes < duskMinutes && arrMinutes > nextDawnMinutes) {
      nightMinutes = (nextDawnMinutes - duskMinutes);
    }
    
    return Math.max(0, Math.round(nightMinutes));
  } catch (error) {
    console.error('Error calculating night time:', error);
    return 0;
  }
}

// POST Flight Calculations - MELHORADO
app.post('/api/flight-calculations', async (c) => {
  try {
    const payload = await c.req.json();
    const { departureIcao, arrivalIcao, arrivalManual, flightDate, landingTime, departureTime } = payload;
    
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
    
    // Validate ICAO codes
    if (!isValidICAO(departureIcao)) {
      return c.json({
        error: `Invalid departure ICAO: ${departureIcao}`,
        timestamp: new Date().toISOString()
      }, 400);
    }
    
    if (arrivalIcao && !isValidICAO(arrivalIcao)) {
      return c.json({
        error: `Invalid arrival ICAO: ${arrivalIcao}`,
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
      if (!arrivalManual.lat || !arrivalManual.lng || !arrivalManual.nome) {
        return c.json({
          error: 'Manual arrival requires lat, lng, and nome',
          timestamp: new Date().toISOString()
        }, 400);
      }
      
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
    
    // Estimate departure time if not provided
    let estimatedDepartureTime = departureTime;
    if (!estimatedDepartureTime) {
      const flightTimeMinutes = (distance.nm / 250) * 60; // assuming 250 knots cruise
      const [arrHour, arrMin] = landingTime.split(':').map(Number);
      const arrMinutes = arrHour * 60 + arrMin;
      const depMinutes = arrMinutes - Math.round(flightTimeMinutes);
      const depHour = Math.floor((depMinutes + 24 * 60) % (24 * 60) / 60);
      const depMin = Math.floor((depMinutes + 24 * 60) % 60);
      estimatedDepartureTime = `${String(depHour).padStart(2, '0')}:${String(depMin).padStart(2, '0')}`;
    }
    
    // Calculate night time
    const nightMinutes = calculateNightTime(
      depCoords.lat, depCoords.lng,
      arrCoords.lat, arrCoords.lng,
      estimatedDepartureTime,
      landingTime,
      flightDate
    );
    
    // Check if landing is at night
    const [landHour, landMin] = landingTime.split(':').map(Number);
    const landMinutes = landHour * 60 + landMin;
    const duskMinutes = solarTimes.dusk.minutes;
    const dawnMinutes = solarTimes.dawn.minutes;
    const isNightLanding = landMinutes >= duskMinutes || landMinutes < dawnMinutes;
    
    const response = {
      data: {
        distance,
        nightTime: {
          hours: Math.floor(nightMinutes / 60),
          minutes: nightMinutes % 60,
          decimal: Math.round((nightMinutes / 60) * 100) / 100
        },
        solarTimes: {
          sunrise: solarTimes.sunrise.time,
          sunset: solarTimes.sunset.time,
          dawn: solarTimes.dawn.time,
          dusk: solarTimes.dusk.time
        },
        flight: {
          departure: { 
            icao: departureIcao.toUpperCase(), 
            name: depData.name,
            lat: depCoords.lat,
            lng: depCoords.lng
          },
          arrival: { 
            icao: arrivalIcaoCode, 
            name: arrivalName,
            lat: arrCoords.lat,
            lng: arrCoords.lng
          },
          date: flightDate,
          departureTime: estimatedDepartureTime,
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