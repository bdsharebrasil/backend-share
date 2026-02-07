import { Router, Request, Response } from 'express';
import { supabase, queryWithJoin } from '../lib/supabase';
import { cacheMiddleware } from '../middleware/cacheMiddleware';
import {
  calculateDistanceNM,
  calculateNightTime,
  getSolarTimes,
  parseDMSCoordinate,
} from '../lib/flight-calculations';
import { getAirportCoordinates, searchAirports } from '../lib/airports';
import financialRouter from './financial';

const router: Router = Router();

// ============= USERS ROUTES =============

// GET all users (cached - 10 min)
router.get(
  '/users',
  cacheMiddleware({ ttl: 10 * 60 * 1000, key: 'users:all' }),
  async (req: Request, res: Response) => {
    try {
      const users = await queryWithJoin('users', '*');
      res.json({ data: users, timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }
);

// GET user by ID (cached - 10 min)
router.get(
  '/users/:id',
  cacheMiddleware({ 
    ttl: 10 * 60 * 1000, 
    key: (req) => `users:${req.params.id}` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (error) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ data, timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  }
);

// GET user profile with related data (cached - 10 min)
router.get(
  '/users/:id/profile',
  cacheMiddleware({ 
    ttl: 10 * 60 * 1000, 
    key: (req) => `users:${req.params.id}:profile` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (userError) {
        return res.status(404).json({ error: 'User not found' });
      }

      let relatedData = {};

      if (user.role === 'pilot' || user.role === 'crew') {
        const { data: licenses } = await supabase
          .from('crew_licenses')
          .select('*')
          .eq('crew_id', req.params.id);
        relatedData = { ...relatedData, licenses };
      }

      if (user.role === 'admin' || user.role === 'manager') {
        const { data: permissions } = await supabase
          .from('role_permissions')
          .select('*')
          .eq('role_id', user.role);
        relatedData = { ...relatedData, permissions };
      }

      res.json({ 
        data: { ...user, ...relatedData }, 
        timestamp: new Date().toISOString() 
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch user profile' });
    }
  }
);

// ============= FLIGHTS ROUTES =============

// GET flights with filters - NO CACHE (real-time)
router.get('/flights', async (req: Request, res: Response) => {
  try {
    const { status, date, aircraft_id } = req.query;

    let query = supabase
      .from('flight_schedules')
      .select(`
        *,
        aircraft:aircraft_id(registration, model),
        crew_members:crew_member_id(full_name, license),
        clients:client_id(company_name)
      `);

    if (status) {
      query = query.eq('status', status as string);
    }

    if (date) {
      query = query.eq('flight_date', date as string);
    }

    if (aircraft_id) {
      query = query.eq('aircraft_id', aircraft_id as string);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch flights' });
    }

    res.json({ 
      data, 
      timestamp: new Date().toISOString(),
      cached: false 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

// GET flight by ID with aggregated data - Short cache (2 min)
router.get(
  '/flights/:id',
  cacheMiddleware({ 
    ttl: 2 * 60 * 1000, 
    key: (req) => `flights:${req.params.id}` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data: flight, error } = await supabase
        .from('flight_schedules')
        .select(`
          *,
          aircraft:aircraft_id(registration, model, max_range),
          crew_members:crew_member_id(full_name, license, flight_hours),
          clients:client_id(company_name, contact_person),
          flight_plans(*)
        `)
        .eq('id', req.params.id)
        .single();

      if (error) {
        return res.status(404).json({ error: 'Flight not found' });
      }

      const { data: weather } = await supabase
        .from('flight_weather')
        .select('*')
        .eq('flight_id', req.params.id)
        .single();

      res.json({ 
        data: { ...flight, weather }, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch flight details' });
    }
  }
);

// GET active flights - Real-time, NO CACHE
router.get('/flights/active/now', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('flight_schedules')
      .select(`
        *,
        aircraft:aircraft_id(registration, model),
        crew_members:crew_member_id(full_name)
      `)
      .eq('status', 'em_voo')
      .order('flight_date', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch active flights' });
    }

    res.json({ 
      data, 
      timestamp: new Date().toISOString(),
      cached: false,
      realtime: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active flights' });
  }
});

// ============= CLIENTS ROUTES =============

// GET all clients (cached - 15 min)
router.get(
  '/clients',
  cacheMiddleware({ ttl: 15 * 60 * 1000, key: 'clients:all' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('company_name', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch clients' });
      }

      res.json({ 
        data, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch clients' });
    }
  }
);

// GET client by ID with related flights (cached - 15 min)
router.get(
  '/clients/:id',
  cacheMiddleware({ 
    ttl: 15 * 60 * 1000, 
    key: (req) => `clients:${req.params.id}` 
  }),
  async (req: Request, res: Response) => {
    try {
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
        .eq('id', req.params.id)
        .single();

      if (clientError) {
        return res.status(404).json({ error: 'Client not found' });
      }

      const { data: expenses } = await supabase
        .from('expenses')
        .select('amount, category')
        .eq('client_id', req.params.id);

      const totalExpenses = expenses?.reduce((sum, exp) => sum + (exp.amount || 0), 0) || 0;

      res.json({ 
        data: { 
          ...client, 
          totalExpenses,
          flightCount: client.flight_schedules?.length || 0 
        }, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch client details' });
    }
  }
);

// GET client contracts (cached - 1 day)
router.get(
  '/clients/:id/contracts',
  cacheMiddleware({ 
    ttl: 24 * 60 * 60 * 1000, 
    key: (req) => `clients:${req.params.id}:contracts` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('client_contracts')
        .select('*')
        .eq('client_id', req.params.id)
        .order('start_date', { ascending: false });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch contracts' });
      }

      res.json({ 
        data, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch contracts' });
    }
  }
);

// ============= AIRCRAFT ROUTES =============

// GET all aircraft (cached - 20 min)
router.get(
  '/aircraft',
  cacheMiddleware({ ttl: 20 * 60 * 1000, key: 'aircraft:all' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('aircraft')
        .select('*')
        .eq('status', 'Ativa')
        .order('registration', { ascending: true });

      if (error) {
        console.error('[Aircraft API] Supabase error:', error);
        return res.status(500).json({
          error: 'Failed to fetch aircraft',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
      }

      res.json({
        data,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      console.error('[Aircraft API] Exception:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: 'Failed to fetch aircraft',
        details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
      });
    }
  }
);

// GET aircraft by ID with maintenance and utilization (cached - 10 min)
router.get(
  '/aircraft/:id',
  cacheMiddleware({ 
    ttl: 10 * 60 * 1000, 
    key: (req) => `aircraft:${req.params.id}` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data: aircraft, error: aircraftError } = await supabase
        .from('aircraft')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (aircraftError) {
        return res.status(404).json({ error: 'Aircraft not found' });
      }

      const { data: maintenance } = await supabase
        .from('maintenance_logs')
        .select('*')
        .eq('aircraft_id', req.params.id)
        .order('date', { ascending: false })
        .limit(10);

      const { data: flights } = await supabase
        .from('flight_schedules')
        .select('estimated_duration')
        .eq('aircraft_id', req.params.id)
        .eq('status', 'completado');

      const totalFlightHours = flights?.reduce((sum, flight) => {
        const duration = flight.estimated_duration;
        if (typeof duration === 'string') {
          const [hours, minutes] = duration.split(':').map(Number);
          return sum + hours + minutes / 60;
        }
        return sum;
      }, 0) || 0;

      res.json({ 
        data: { 
          ...aircraft, 
          maintenance,
          totalFlightHours: Math.round(totalFlightHours * 100) / 100,
          flightCount: flights?.length || 0
        }, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch aircraft details' });
    }
  }
);

// GET aircraft availability (cached - 5 min)
router.get(
  '/aircraft/:id/availability',
  cacheMiddleware({ 
    ttl: 5 * 60 * 1000, 
    key: (req) => `aircraft:${req.params.id}:availability` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('flight_schedules')
        .select('flight_date, status')
        .eq('aircraft_id', req.params.id)
        .gte('flight_date', new Date().toISOString().split('T')[0]);

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch availability' });
      }

      const availability = {
        available: true,
        nextFlight: null as any,
        upcomingFlights: (data || []).length
      };

      if (data && data.length > 0) {
        const activeFlights = data.filter(f => f.status === 'confirmado' || f.status === 'em_voo');
        availability.nextFlight = activeFlights[0]?.flight_date || null;
        availability.available = !data.some(f => f.status === 'em_voo');
      }

      res.json({ 
        data: availability, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch availability' });
    }
  }
);

// ============= AERODROMES ROUTES =============

// GET all aerodromes (cached - 24 hours)
router.get(
  '/aerodromes',
  cacheMiddleware({ ttl: 24 * 60 * 60 * 1000, key: 'aerodromes:all' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('aerodromes')
        .select('id, designativo, name, coordenadas')
        .order('designativo', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch aerodromes' });
      }

      res.json({
        data,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch aerodromes' });
    }
  }
);

// GET aerodromes with complete data (cached - 24 hours)
router.get(
  '/aerodromes/details',
  cacheMiddleware({ ttl: 24 * 60 * 60 * 1000, key: 'aerodromes:details' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('aerodromes')
        .select('*')
        .order('designativo', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch aerodromes details' });
      }

      res.json({
        data,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch aerodromes details' });
    }
  }
);

// GET aerodrome by ICAO code (cached - 24 hours)
router.get(
  '/aerodromes/:icao',
  cacheMiddleware({
    ttl: 24 * 60 * 60 * 1000,
    key: (req) => `aerodrome:${req.params.icao}`
  }),
  async (req: Request, res: Response) => {
    try {
      const { icao } = req.params;
      const { data, error } = await supabase
        .from('aerodromes')
        .select('*')
        .eq('designativo', icao.toUpperCase())
        .single();

      if (error) {
        return res.status(404).json({ error: 'Aerodrome not found' });
      }

      res.json({
        data,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch aerodrome' });
    }
  }
);

// ============= CATEGORIES ROUTES =============

// GET all financial categories (cached - 12 hours)
router.get(
  '/categories',
  cacheMiddleware({ ttl: 12 * 60 * 60 * 1000, key: 'categories:all' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('categorias_movimentacao')
        .select('id, nome, tipo, grupo_categoria, descricao, ativo, reembolsavel, icone, cor')
        .eq('ativo', true)
        .order('nome', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch categories' });
      }

      res.json({
        data,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  }
);

// GET unique categories grouped by type (cached - 12 hours)
router.get(
  '/categories/unique-by-type',
  cacheMiddleware({ ttl: 12 * 60 * 60 * 1000, key: 'categories:unique' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('categorias_movimentacao')
        .select('id, nome, tipo')
        .eq('ativo', true)
        .order('nome', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch categories' });
      }

      const grouped = (data || []).reduce((acc: any, cat: any) => {
        if (!acc[cat.tipo]) {
          acc[cat.tipo] = [];
        }
        acc[cat.tipo].push(cat);
        return acc;
      }, {});

      res.json({
        data: grouped,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  }
);

// ============= MAINTENANCE ROUTES =============

// POST new maintenance record
router.post('/maintenance', async (req: Request, res: Response) => {
  try {
    const { tipo, data_programada, mecanico, etapa, aeronave_id, oficina, observacoes, custo_estimado } = req.body;

    if (!tipo || !data_programada) {
      return res.status(400).json({
        error: 'Missing required fields: tipo, data_programada'
      });
    }

    const { data, error } = await supabase
      .from('manutencoes')
      .insert([
        {
          aeronave_id: aeronave_id || null,
          tipo,
          data_programada,
          mecanico: mecanico || 'Sistema',
          etapa: etapa || 'aguardando',
          oficina: oficina || null,
          observacoes: observacoes || null,
          custo_estimado: custo_estimado || null
        }
      ])
      .select();

    if (error) {
      console.error('[Maintenance API] Supabase error:', error);
      return res.status(500).json({
        error: 'Failed to create maintenance record',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.status(201).json({
      data: data?.[0] || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Maintenance API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to create maintenance record',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

// PUT update maintenance record
router.put('/maintenance/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tipo, data_programada, mecanico, etapa, aeronave_id, oficina, observacoes, custo_estimado } = req.body;

    if (!tipo || !data_programada) {
      return res.status(400).json({
        error: 'Missing required fields: tipo, data_programada'
      });
    }

    const { data, error } = await supabase
      .from('manutencoes')
      .update({
        aeronave_id: aeronave_id || null,
        tipo,
        data_programada,
        mecanico,
        etapa,
        oficina: oficina || null,
        observacoes: observacoes || null,
        custo_estimado: custo_estimado || null
      })
      .eq('id', id)
      .select();

    if (error) {
      console.error('[Maintenance API] Supabase error:', error);
      return res.status(500).json({
        error: 'Failed to update maintenance record',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.json({
      data: data?.[0] || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Maintenance API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to update maintenance record',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

// ============= FLIGHT DOCUMENTS ROUTES =============

// POST new flight document
router.post('/flight-documents', async (req: Request, res: Response) => {
  try {
    const { aircraft_id, name, document_type, expiry_date, file_path } = req.body;

    if (!aircraft_id || !name || !expiry_date) {
      return res.status(400).json({
        error: 'Missing required fields: aircraft_id, name, expiry_date'
      });
    }

    const { data, error } = await supabase
      .from('flight_documents')
      .insert([
        {
          aircraft_id,
          name,
          document_type: document_type || null,
          expiry_date,
          file_path: file_path || 'placeholder'
        }
      ])
      .select();

    if (error) {
      console.error('[Flight Documents API] Supabase error:', error);
      return res.status(500).json({
        error: 'Failed to create flight document',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.status(201).json({
      data: data?.[0] || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Flight Documents API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to create flight document',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

// GET flight documents by flight_id (optional) or all
router.get('/flight-documents', async (req: Request, res: Response) => {
  try {
    const { flight_id } = req.query;

    let query = supabase.from('flight_documents').select('*');

    if (flight_id && typeof flight_id === 'string') {
      query = query.eq('flight_id', flight_id);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('[Flight Documents GET] Supabase error:', error);
      return res.status(500).json({ error: 'Failed to fetch flight documents' });
    }

    res.json({
      data: data || [],
      count: data?.length || 0,
      timestamp: new Date().toISOString(),
      cached: res.get('X-Cache') === 'HIT'
    });
  } catch (error) {
    console.error('[Flight Documents GET] Exception:', error);
    res.status(500).json({ error: 'Failed to fetch flight documents' });
  }
});

// ============= FLIGHT CALCULATIONS ROUTES =============

/**
 * POST /api/flight-calculations
 * Processa os cálculos finais do trecho de voo
 * Suporta busca por ICAO ou coordenadas manuais
 *
 * Body esperado:
 * {
 *   departureIcao: string (ex: "SBGR")
 *   arrivalIcao?: string (ex: "SBBR")
 *   arrivalManual?: { lat: number, lng: number, nome: string }
 *   flightDate: string (YYYY-MM-DD)
 *   landingTime: string (HH:MM)
 * }
 */
router.post('/flight-calculations', async (req: Request, res: Response) => {
  try {
    const {
      departureIcao,
      arrivalIcao,
      arrivalManual,
      flightDate,
      landingTime,
    } = req.body;

    // Validações básicas
    if (!departureIcao || !flightDate || !landingTime) {
      return res.status(400).json({
        error: 'Missing required fields: departureIcao, flightDate, landingTime',
      });
    }

    if (!arrivalIcao && !arrivalManual) {
      return res.status(400).json({
        error: 'Must provide either arrivalIcao or arrivalManual coordinates',
      });
    }

    // Validar formato da data (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flightDate)) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD',
      });
    }

    // Validar formato do horário (HH:MM)
    if (!/^\d{2}:\d{2}$/.test(landingTime)) {
      return res.status(400).json({
        error: 'Invalid time format. Use HH:MM',
      });
    }

    // Buscar aeródromo de partida
    const { data: departureData, error: departureError } = await supabase
      .from('aerodromes')
      .select('*')
      .eq('designativo', departureIcao.toUpperCase())
      .single();

    if (departureError) {
      return res.status(404).json({
        error: `Departure aerodrome not found: ${departureIcao}`,
      });
    }

    // Parse coordenadas de partida
    const departureParsed = parseDMSCoordinate(departureData.coordenadas);
    if (!departureParsed) {
      return res.status(400).json({
        error: 'Invalid departure aerodrome coordinates',
      });
    }

    let arrivalLat: number;
    let arrivalLng: number;
    let arrivalName: string;

    // Se for manual, usa as coordenadas diretas
    if (arrivalManual) {
      if (!arrivalManual.lat || !arrivalManual.lng) {
        return res.status(400).json({
          error: 'Manual arrival must include lat and lng',
        });
      }
      arrivalLat = arrivalManual.lat;
      arrivalLng = arrivalManual.lng;
      arrivalName = arrivalManual.nome || 'Manual Location';
    } else {
      // Se for ICAO, busca no banco
      const { data: arrivalData, error: arrivalError } = await supabase
        .from('aerodromes')
        .select('*')
        .eq('designativo', arrivalIcao!.toUpperCase())
        .single();

      if (arrivalError) {
        return res.status(404).json({
          error: `Arrival aerodrome not found: ${arrivalIcao}`,
        });
      }

      const arrivalParsed = parseDMSCoordinate(arrivalData.coordenadas);
      if (!arrivalParsed) {
        return res.status(400).json({
          error: 'Invalid arrival aerodrome coordinates',
        });
      }

      arrivalLat = arrivalParsed.lat;
      arrivalLng = arrivalParsed.lng;
      arrivalName = arrivalData.name || arrivalData.designativo;
    }

    // Calcular distância
    const distance = calculateDistanceNM(
      departureParsed.lat,
      departureParsed.lng,
      arrivalLat,
      arrivalLng
    );

    // Calcular tempo noturno
    const nightTime = calculateNightTime(flightDate, landingTime, arrivalLat, arrivalLng);

    // Obter tempos solares
    const solarTimes = getSolarTimes(flightDate, arrivalLat, arrivalLng);

    // Verificar se o pouso é noturno (após dusk)
    const [landingHours, landingMinutes] = landingTime.split(':').map(Number);
    const landingTotalMinutes = landingHours * 60 + landingMinutes;
    const isNightFlightAtLanding = landingTotalMinutes > solarTimes.duskMinutes;

    res.json({
      data: {
        distance: {
          nm: distance,
          km: Math.round(distance * 1.852 * 100) / 100,
        },
        nightTime: {
          hours: Math.floor(nightTime),
          minutes: Math.round((nightTime % 1) * 60),
          decimal: nightTime,
        },
        solarTimes: {
          sunrise: {
            time: `${String(Math.floor(solarTimes.sunriseMinutes / 60)).padStart(2, '0')}:${String(solarTimes.sunriseMinutes % 60).padStart(2, '0')}`,
            minutes: solarTimes.sunriseMinutes,
          },
          sunset: {
            time: `${String(Math.floor(solarTimes.sunsetMinutes / 60)).padStart(2, '0')}:${String(solarTimes.sunsetMinutes % 60).padStart(2, '0')}`,
            minutes: solarTimes.sunsetMinutes,
          },
          dawn: {
            time: `${String(Math.floor(solarTimes.dawnMinutes / 60)).padStart(2, '0')}:${String(solarTimes.dawnMinutes % 60).padStart(2, '0')}`,
            minutes: solarTimes.dawnMinutes,
          },
          dusk: {
            time: `${String(Math.floor(solarTimes.duskMinutes / 60)).padStart(2, '0')}:${String(solarTimes.duskMinutes % 60).padStart(2, '0')}`,
            minutes: solarTimes.duskMinutes,
          },
        },
        flight: {
          departure: {
            icao: departureIcao.toUpperCase(),
            name: departureData.name,
          },
          arrival: {
            icao: arrivalIcao ? arrivalIcao.toUpperCase() : 'MANUAL',
            name: arrivalName,
          },
          date: flightDate,
          landingTime: landingTime,
          isNightFlightAtLanding: isNightFlightAtLanding,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Flight Calculations API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to calculate flight metrics',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
    });
  }
});

// ============= WEATHER/METAR ROUTES =============

// GET METAR data for a given airport (cached - 10 min)
router.get(
  '/weather/metar',
  cacheMiddleware({
    ttl: 10 * 60 * 1000,
    key: (req) => `metar:${(req.query.icao as string)?.toUpperCase() || 'unknown'}`
  }),
  async (req: Request, res: Response) => {
    try {
      const { icao } = req.query;

      if (!icao || typeof icao !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid icao parameter' });
      }

      const response = await fetch(
        `https://aviationweather.gov/api/data/metar?ids=${icao.toUpperCase()}&format=json`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ShareBrasil-Aviation-App/1.0',
          },
          signal: AbortSignal.timeout(10000), // 10 second timeout
        }
      );

      if (!response.ok) {
        console.error(`[METAR API] HTTP Error: ${response.status} for ${icao}`);
        return res.status(response.status).json({
          error: `METAR API returned ${response.status}`,
          icao: icao.toUpperCase()
        });
      }

      // Get the response text first to check if it's empty
      const responseText = await response.text();

      if (!responseText || responseText.trim().length === 0) {
        console.warn(`[METAR API] Empty response body for ${icao}`);
        return res.status(503).json({
          error: 'METAR service returned empty response',
          icao: icao.toUpperCase()
        });
      }

      // Try to parse JSON
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[METAR API] JSON Parse Error for ${icao}:`, parseError);
        return res.status(502).json({
          error: 'METAR service returned invalid JSON',
          icao: icao.toUpperCase(),
          details: process.env.NODE_ENV === 'development' ? String(parseError) : undefined
        });
      }

      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`[METAR API] No METAR data found for ${icao}`);
        return res.status(404).json({
          error: 'METAR not found',
          icao: icao.toUpperCase()
        });
      }

      console.log(`[METAR API] ✅ Successfully fetched METAR for ${icao}`);
      res.json({
        data: data[0],
        icao: icao.toUpperCase(),
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      console.error('[METAR API] Unexpected Exception:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: 'Failed to fetch METAR data',
        details: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
      });
    }
  }
);

// GET METAR by ICAO as path param - normalized response
router.get(
  '/weather/metar/:icao',
  cacheMiddleware({
    ttl: 10 * 60 * 1000,
    key: (req) => `metar:${(req.params.icao as string)?.toUpperCase() || 'unknown'}`
  }),
  async (req: Request, res: Response) => {
    try {
      const icaoParam = req.params.icao;

      if (!icaoParam || typeof icaoParam !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid icao parameter' });
      }

      const icao = icaoParam.toUpperCase();

      const response = await fetch(
        `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ShareBrasil-Aviation-App/1.0',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: `METAR API returned ${response.status}`, icao });
      }

      const text = await response.text();
      if (!text || text.trim().length === 0) {
        return res.status(503).json({ error: 'METAR service returned empty response', icao });
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (parseError) {
        return res.status(502).json({ error: 'METAR service returned invalid JSON', icao });
      }

      if (!Array.isArray(json) || json.length === 0) {
        return res.status(404).json({ error: 'METAR not found', icao });
      }

      const item = json[0];
      const raw = item.raw_text || item.rawText || item.raw || item.raw_ob || '';
      const flightCategory = item.flight_category || item.flightCategory || 'UNKNOWN';

      res.json({
        data: {
          rawText: raw,
          flightCategory,
          original: item
        },
        icao,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      console.error('[METAR by ICAO] Exception:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: 'Failed to fetch METAR data', details: process.env.NODE_ENV === 'development' ? errorMsg : undefined });
    }
  }
);

// GET TAF by ICAO as path param - normalized response
router.get(
  '/weather/taf/:icao',
  cacheMiddleware({
    ttl: 10 * 60 * 1000,
    key: (req) => `taf:${(req.params.icao as string)?.toUpperCase() || 'unknown'}`
  }),
  async (req: Request, res: Response) => {
    try {
      const icaoParam = req.params.icao;

      if (!icaoParam || typeof icaoParam !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid icao parameter' });
      }

      const icao = icaoParam.toUpperCase();

      const response = await fetch(
        `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ShareBrasil-Aviation-App/1.0',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: `TAF API returned ${response.status}`, icao });
      }

      const text = await response.text();
      if (!text || text.trim().length === 0) {
        return res.status(503).json({ error: 'TAF service returned empty response', icao });
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (parseError) {
        return res.status(502).json({ error: 'TAF service returned invalid JSON', icao });
      }

      if (!Array.isArray(json) || json.length === 0) {
        return res.status(404).json({ error: 'TAF not found', icao });
      }

      const item = json[0];
      const raw = item.raw_text || item.rawText || item.raw || '';
      const validFrom = item.valid_time_from || item.validTimeFrom || null;
      const validTo = item.valid_time_to || item.validTimeTo || null;

      res.json({
        data: {
          rawText: raw,
          validTimeFrom: validFrom,
          validTimeTo: validTo,
          original: item
        },
        icao,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      console.error('[TAF by ICAO] Exception:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: 'Failed to fetch TAF data', details: process.env.NODE_ENV === 'development' ? errorMsg : undefined });
    }
  }
);

// GET TAF by query param ?icao= - compatibilidade com frontend
router.get(
  '/weather/taf',
  cacheMiddleware({
    ttl: 10 * 60 * 1000,
    key: (req) => `taf:${(req.query.icao as string)?.toUpperCase() || 'unknown'}`
  }),
  async (req: Request, res: Response) => {
    try {
      const icaoParam = req.query.icao;

      if (!icaoParam || typeof icaoParam !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid icao parameter' });
      }

      // Delegate to the path-param implementation by calling internal fetch
      const icao = icaoParam.toUpperCase();
      const response = await fetch(
        `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ShareBrasil-Aviation-App/1.0',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: `TAF API returned ${response.status}`, icao });
      }

      const text = await response.text();
      if (!text || text.trim().length === 0) {
        return res.status(503).json({ error: 'TAF service returned empty response', icao });
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (parseError) {
        return res.status(502).json({ error: 'TAF service returned invalid JSON', icao });
      }

      if (!Array.isArray(json) || json.length === 0) {
        return res.status(404).json({ error: 'TAF not found', icao });
      }

      const item = json[0];
      const raw = item.raw_text || item.rawText || item.raw || '';
      const validFrom = item.valid_time_from || item.validTimeFrom || null;
      const validTo = item.valid_time_to || item.validTimeTo || null;

      res.json({
        data: {
          rawText: raw,
          validTimeFrom: validFrom,
          validTimeTo: validTo,
          original: item
        },
        icao,
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      console.error('[TAF query] Exception:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: 'Failed to fetch TAF data', details: process.env.NODE_ENV === 'development' ? errorMsg : undefined });
    }
  }
);

// ============= LOGBOOK ROUTES =============

// POST /logbook - Create new logbook entry with validation
router.post('/logbook', async (req: Request, res: Response) => {
  try {
    const {
      total_time,
      time,
      night_time,
      entry_date,
      departure_aerodrome,
      arrival_aerodrome,
      ac_time,
      cor_time,
      dep_time,
      pou_time,
      pic_canac,
      sic_canac,
      client_id,
      aircraft_id,
      pousos,
      fuel_added,
      distance_nm,
      flight_nature,
      ifr_time,
      observations,
    } = req.body;

    if (total_time <= 0) {
      return res.status(400).json({
        error: 'Tempo total inválido',
        message: 'O tempo de bloco (acionamento ao corte) deve ser maior que 0'
      });
    }

    if (time <= 0) {
      return res.status(400).json({
        error: 'Tempo de voo inválido',
        message: 'O tempo de voo (decolagem ao pouso) deve ser maior que 0'
      });
    }

    if (time > total_time) {
      return res.status(400).json({
        error: 'Tempo de voo maior que o bloco',
        message: 'O tempo de voo não pode ser maior que o tempo de bloco'
      });
    }

    if (night_time > time) {
      return res.status(400).json({
        error: 'Tempo noturno maior que o tempo de voo',
        message: 'O tempo noturno não pode ser maior que o tempo de voo'
      });
    }

    if (time - night_time < 0) {
      return res.status(400).json({
        error: 'Tempo diurno negativo',
        message: 'O tempo diurno não pode ser negativo'
      });
    }

    if (!pic_canac) {
      return res.status(400).json({
        error: 'Comandante não informado',
        message: 'O campo PIC (Comandante) é obrigatório'
      });
    }

    if (!departure_aerodrome || !arrival_aerodrome) {
      return res.status(400).json({
        error: 'Aerodromo não informado',
        message: 'Os aerodromes de origem e destino são obrigatórios'
      });
    }

    if (!client_id) {
      return res.status(400).json({
        error: 'Cliente não informado',
        message: 'O cliente é obrigatório'
      });
    }

    if (!entry_date) {
      return res.status(400).json({
        error: 'Data não informada',
        message: 'A data da operação é obrigatória'
      });
    }

    const { data, error } = await supabase
      .from('logbook_entries')
      .insert([
        {
          entry_date,
          departure_aerodrome,
          arrival_aerodrome,
          ac_time,
          cor_time,
          dep_time,
          pou_time,
          pic_canac,
          sic_canac: sic_canac || null,
          client_id,
          aircraft_id: aircraft_id || null,
          total_time,
          time,
          night_time,
          pousos: pousos || 1,
          fuel_added: fuel_added || 0,
          distance_nm: distance_nm || 0,
          flight_nature: flight_nature || 'PV',
          ifr_time: ifr_time || 0,
          observations: observations || '',
          confirmed: false,
          created_at: new Date().toISOString(),
        }
      ])
      .select();

    if (error) {
      console.error('Database error:', error);
      return res.status(500).json({
        error: 'Erro ao salvar no banco de dados',
        message: error.message
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Voo registrado com sucesso',
      data: data?.[0] || null
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({
      error: 'Erro inesperado do servidor',
      message: err instanceof Error ? err.message : 'Erro desconhecido'
    });
  }
});

// GET /logbook - List logbook entries
router.get('/logbook', async (req: Request, res: Response) => {
  try {
    const { aircraft_id, month, year } = req.query;

    let query = supabase.from('logbook_entries').select('*');

    if (aircraft_id) {
      query = query.eq('aircraft_id', aircraft_id);
    }

    if (month && year) {
      const startDate = new Date(Number(year), Number(month) - 1, 1).toISOString().split('T')[0];
      const endDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];
      query = query.gte('entry_date', startDate).lte('entry_date', endDate);
    }

    const { data, error } = await query.order('entry_date', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Erro ao buscar registros' });
    }

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Erro ao buscar registros' });
  }
});

// GET /logbook/:id - Get single logbook entry
router.get('/logbook/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('logbook_entries')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Registro não encontrado' });
    }

    return res.json({
      success: true,
      data
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Erro ao buscar registro' });
  }
});

// ============= CONSOLIDATION & RATEIO ROUTES =============

router.post('/consolidacao/consolidar-rateio', async (req: Request, res: Response) => {
  try {
    const {
      lancamento_rateio_id,
      bank_transaction_id,
      bank_reconciliation_id,
      horas_voadas
    } = req.body;

    if (!lancamento_rateio_id || !bank_reconciliation_id) {
      return res.status(400).json({
        error: 'Missing required fields: lancamento_rateio_id, bank_reconciliation_id'
      });
    }

    const { data: user } = await supabase.auth.getUser();
    if (!user?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase.rpc('consolidar_rateio_historico', {
      p_lancamento_rateio_id: lancamento_rateio_id,
      p_bank_transaction_id: bank_transaction_id,
      p_bank_reconciliation_id: bank_reconciliation_id,
      p_horas_voadas: horas_voadas || 0,
      p_consolidado_por: user.user.id
    });

    if (error) {
      console.error('[Consolidation API] RPC error:', error);
      return res.status(500).json({
        error: 'Failed to consolidate rateio',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.status(201).json({
      data: { historico_id: data },
      message: 'Rateio consolidado com sucesso',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Consolidation API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to consolidate rateio',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

router.post('/consolidacao/consolidar-horas-mensais', async (req: Request, res: Response) => {
  try {
    const {
      cliente_id,
      aeronave_id,
      ano,
      mes,
      horas_voadas
    } = req.body;

    if (!cliente_id || !aeronave_id || !ano || !mes || horas_voadas === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: cliente_id, aeronave_id, ano, mes, horas_voadas'
      });
    }

    if (ano < 2000 || ano > 2100) {
      return res.status(400).json({ error: 'Invalid year' });
    }

    if (mes < 1 || mes > 12) {
      return res.status(400).json({ error: 'Invalid month (must be 1-12)' });
    }

    const { data, error } = await supabase.rpc('consolidar_horas_mensais', {
      p_cliente_id: cliente_id,
      p_aeronave_id: aeronave_id,
      p_ano: ano,
      p_mes: mes,
      p_horas_voadas: horas_voadas
    });

    if (error) {
      console.error('[Consolidation Hours API] RPC error:', error);
      return res.status(500).json({
        error: 'Failed to consolidate hours',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.status(201).json({
      data: { id: data },
      message: 'Horas consolidadas com sucesso',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Consolidation Hours API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to consolidate hours',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

router.get('/consolidacao/extrato-cliente/:cliente_id', async (req: Request, res: Response) => {
  try {
    const { cliente_id } = req.params;
    const { data_inicio, data_fim } = req.query;

    if (!cliente_id) {
      return res.status(400).json({ error: 'Missing cliente_id' });
    }

    let query = supabase
      .from('historico_rateio_consolidado')
      .select('*')
      .eq('cliente_id', cliente_id)
      .eq('status', 'consolidado')
      .order('data_competencia', { ascending: false });

    if (data_inicio) {
      query = query.gte('data_competencia', data_inicio as string);
    }

    if (data_fim) {
      query = query.lte('data_competencia', data_fim as string);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({
        error: 'Failed to fetch extrato',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.json({
      data,
      count: data?.length || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Extrato API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to fetch extrato',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

router.get('/consolidacao/resumo-mensal-cliente/:cliente_id', async (req: Request, res: Response) => {
  try {
    const { cliente_id } = req.params;
    const { ano, mes } = req.query;

    if (!cliente_id || !ano || !mes) {
      return res.status(400).json({
        error: 'Missing required params: cliente_id, ano, mes'
      });
    }

    const { data, error } = await supabase
      .from('v_resumo_mensal_cliente')
      .select('*')
      .eq('cliente_id', cliente_id)
      .eq('ano', parseInt(ano as string))
      .eq('mes', parseInt(mes as string));

    if (error) {
      console.warn('[Resumo Mensal API] Warning:', error.message);
      return res.json({
        data: [],
        summary: {
          total_gasto: 0,
          total_horas: 0,
          num_categorias: 0
        },
        timestamp: new Date().toISOString()
      });
    }

    const totalGasto = data?.reduce((sum, item) => sum + (parseFloat(item.total_categoria) || 0), 0) || 0;
    const totalHoras = data?.reduce((sum, item) => sum + (parseFloat(item.total_horas_cliente) || 0), 0) || 0;

    res.json({
      data,
      summary: {
        total_gasto: totalGasto,
        total_horas: totalHoras,
        num_categorias: data?.length || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Resumo Mensal API] Exception:', error);
    res.json({
      data: [],
      summary: {
        total_gasto: 0,
        total_horas: 0,
        num_categorias: 0
      },
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/consolidacao/comparativo-uso/:aeronave_id', async (req: Request, res: Response) => {
  try {
    const { aeronave_id } = req.params;
    const { ano, mes } = req.query;

    if (!aeronave_id || !ano || !mes) {
      return res.status(400).json({
        error: 'Missing required params: aeronave_id, ano, mes'
      });
    }

    const { data, error } = await supabase
      .from('v_comparativo_uso_clientes')
      .select('*')
      .eq('aeronave_id', aeronave_id)
      .eq('ano', parseInt(ano as string))
      .eq('mes', parseInt(mes as string))
      .order('ranking', { ascending: true });

    if (error) {
      console.warn('[Comparativo Uso API] Warning:', error.message);
      return res.json({
        data: [],
        summary: {
          total_clientes: 0,
          total_horas: 0
        },
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      data,
      summary: {
        total_clientes: data?.[0]?.total_clientes || 0,
        total_horas: data?.[0]?.horas_totais_aeronave || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Comparativo Uso API] Exception:', error);
    res.json({
      data: [],
      summary: {
        total_clientes: 0,
        total_horas: 0
      },
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/consolidacao/pendencias-cliente/:cliente_id', async (req: Request, res: Response) => {
  try {
    const { cliente_id } = req.params;

    const defaultPendencias = {
      cliente_id,
      total_lancamentos_pendentes: 0,
      total_pendente: 0,
      dias_pendente: 0
    };

    const { data, error } = await supabase
      .from('v_pendencias_cliente')
      .select('*')
      .eq('cliente_id', cliente_id)
      .single();

    if (error) {
      console.warn('[Pendencias API] Warning:', error.message);
      return res.json({
        data: defaultPendencias,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      data: data || defaultPendencias,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Pendencias API] Exception:', error);
    res.json({
      data: {
        cliente_id: req.params.cliente_id,
        total_lancamentos_pendentes: 0,
        total_pendente: 0,
        dias_pendente: 0
      },
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/consolidacao/analise-anual/:cliente_id', async (req: Request, res: Response) => {
  try {
    const { cliente_id } = req.params;
    const { ano } = req.query;

    let query = supabase
      .from('v_analise_anual_cliente')
      .select('*')
      .eq('cliente_id', cliente_id);

    if (ano) {
      query = query.eq('ano', parseInt(ano as string));
    }

    const { data, error } = await query.order('ano', { ascending: false });

    if (error) {
      console.warn('[Analise Anual API] Warning:', error.message);
      return res.json({
        data: [],
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Analise Anual API] Exception:', error);
    res.json({
      data: [],
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/consolidacao/status-conciliacao', async (req: Request, res: Response) => {
  try {
    const defaultStatus = {
      pendentes: 0,
      conciliadas: 0,
      consolidadas: 0,
      total: 0,
      valor_pendente: 0,
      valor_conciliado: 0,
      valor_consolidado: 0
    };

    const { data, error } = await supabase
      .from('v_conciliacao_status')
      .select('*')
      .single();

    if (error) {
      console.warn('[Status Conciliacao API] Warning:', error.message);
      return res.json({
        data: defaultStatus,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      data: data || defaultStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Status Conciliacao API] Exception:', error);
    res.json({
      data: {
        pendentes: 0,
        conciliadas: 0,
        consolidadas: 0,
        total: 0,
        valor_pendente: 0,
        valor_conciliado: 0,
        valor_consolidado: 0
      },
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/consolidacao/reembolsos-pendentes', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('v_reembolsos_pendentes')
      .select('*')
      .order('data_pagamento', { ascending: true });

    if (error) {
      console.warn('[Reembolsos API] Warning:', error.message);
      return res.json({
        data: [],
        summary: {
          total_reembolsos: 0,
          count: 0
        },
        timestamp: new Date().toISOString()
      });
    }

    const totalReembolsos = data?.reduce((sum, item) => sum + (parseFloat(item.valor_rateado) || 0), 0) || 0;

    res.json({
      data,
      summary: {
        total_reembolsos: totalReembolsos,
        count: data?.length || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Reembolsos API] Exception:', error);
    res.json({
      data: [],
      summary: {
        total_reembolsos: 0,
        count: 0
      },
      timestamp: new Date().toISOString()
    });
  }
});

// ============= FUEL ROUTES =============

// GET fuel records (abastecimentos) by client/aircraft and date range
router.get('/fuel', async (req: Request, res: Response) => {
  try {
    const { client_id, aircraft_id, date_start, date_end } = req.query;

    if (!client_id || typeof client_id !== 'string') {
      return res.status(400).json({ error: 'Missing client_id parameter' });
    }

    if (!date_start || !date_end || typeof date_start !== 'string' || typeof date_end !== 'string') {
      return res.status(400).json({ error: 'Missing date_start and date_end parameters' });
    }

    // Build query using PostgREST with proper date filtering
    let query = supabase
      .from('abastecimentos')
      .select('id, valor_total, status_pagamento, data')
      .eq('client_id', client_id)
      .gte('data', date_start)
      .lte('data', date_end);

    // Add aircraft filter if provided
    if (aircraft_id && typeof aircraft_id === 'string') {
      query = query.eq('aeronave_id', aircraft_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[Fuel API] Supabase error:', error);
      return res.status(500).json({
        error: 'Failed to fetch fuel records',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    res.json({
      data: data || [],
      timestamp: new Date().toISOString(),
      count: data?.length || 0
    });
  } catch (error) {
    console.error('[Fuel API] Exception:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: 'Failed to fetch fuel records',
      details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
    });
  }
});

// ============= AIRPORTS ROUTES =============

router.get('/airports/:icao', async (req: Request, res: Response) => {
  try {
    const { icao } = req.params;

    if (!icao || typeof icao !== 'string' || icao.length < 2) {
      return res.status(400).json({ error: 'Invalid ICAO code' });
    }

    const airport = await getAirportCoordinates(icao);

    if (!airport) {
      return res.status(404).json({ error: 'Airport not found' });
    }

    res.json(airport);
  } catch (error) {
    console.error('Error fetching airport:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/airports/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string' || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const results = await searchAirports(q);
    res.json(results);
  } catch (error) {
    console.error('Error searching airports:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============= FINANCIAL SYNC ROUTES =============

router.use('/financial', financialRouter);

export default router;
