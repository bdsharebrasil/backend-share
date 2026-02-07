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

      let relatedData: any = {};

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

// GET aircraft by ID with maintenance history (cached - 20 min)
router.get(
  '/aircraft/:id',
  cacheMiddleware({ 
    ttl: 20 * 60 * 1000, 
    key: (req) => `aircraft:${req.params.id}` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data: aircraft, error: aircraftError } = await supabase
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
        .eq('id', req.params.id)
        .single();

      if (aircraftError) {
        return res.status(404).json({ error: 'Aircraft not found' });
      }

      res.json({ 
        data: aircraft, 
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
  '/aircraft/availability/check',
  cacheMiddleware({ ttl: 5 * 60 * 1000, key: 'aircraft:availability' }),
  async (req: Request, res: Response) => {
    try {
      const { start_date, end_date } = req.query;

      const { data, error } = await supabase
        .from('aircraft')
        .select(`
          id,
          registration,
          model,
          status,
          flight_schedules!inner(
            flight_date,
            status
          )
        `)
        .eq('status', 'Ativa');

      if (error) {
        return res.status(500).json({ error: 'Failed to check availability' });
      }

      res.json({ 
        data, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check aircraft availability' });
    }
  }
);

// ============= MAINTENANCE ROUTES =============

// GET maintenance records (cached - 30 min)
router.get(
  '/maintenance',
  cacheMiddleware({ ttl: 30 * 60 * 1000, key: 'maintenance:all' }),
  async (req: Request, res: Response) => {
    try {
      const { aircraft_id, status } = req.query;

      let query = supabase
        .from('maintenance_records')
        .select(`
          *,
          aircraft:aircraft_id(registration, model)
        `)
        .order('maintenance_date', { ascending: false });

      if (aircraft_id) {
        query = query.eq('aircraft_id', aircraft_id as string);
      }

      if (status) {
        query = query.eq('status', status as string);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch maintenance records' });
      }

      res.json({ 
        data, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch maintenance records' });
    }
  }
);

// GET upcoming maintenance (cached - 1 hour)
router.get(
  '/maintenance/upcoming',
  cacheMiddleware({ ttl: 60 * 60 * 1000, key: 'maintenance:upcoming' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('maintenance_records')
        .select(`
          *,
          aircraft:aircraft_id(registration, model)
        `)
        .eq('status', 'scheduled')
        .gte('maintenance_date', new Date().toISOString().split('T')[0])
        .order('maintenance_date', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch upcoming maintenance' });
      }

      res.json({ 
        data, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch upcoming maintenance' });
    }
  }
);

// ============= CREW ROUTES =============

// GET all crew members (cached - 15 min)
router.get(
  '/crew',
  cacheMiddleware({ ttl: 15 * 60 * 1000, key: 'crew:all' }),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('crew_members')
        .select('*')
        .eq('status', 'active')
        .order('full_name', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch crew members' });
      }

      res.json({ 
        data, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch crew members' });
    }
  }
);

// GET crew member by ID with licenses (cached - 15 min)
router.get(
  '/crew/:id',
  cacheMiddleware({ 
    ttl: 15 * 60 * 1000, 
    key: (req) => `crew:${req.params.id}` 
  }),
  async (req: Request, res: Response) => {
    try {
      const { data: crew, error: crewError } = await supabase
        .from('crew_members')
        .select(`
          *,
          crew_licenses(
            license_type,
            license_number,
            issue_date,
            expiry_date
          )
        `)
        .eq('id', req.params.id)
        .single();

      if (crewError) {
        return res.status(404).json({ error: 'Crew member not found' });
      }

      res.json({ 
        data: crew, 
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch crew member details' });
    }
  }
);

// ============= FLIGHT CALCULATIONS ROUTES =============

// POST calculate flight distance
router.post('/calculations/distance', async (req: Request, res: Response) => {
  try {
    const { origin, destination } = req.body;

    if (!origin || !destination) {
      return res.status(400).json({ error: 'Origin and destination are required' });
    }

    const originCoords = await getAirportCoordinates(origin);
    const destCoords = await getAirportCoordinates(destination);

    if (!originCoords || !destCoords) {
      return res.status(404).json({ error: 'Airport coordinates not found' });
    }

    const distance = calculateDistanceNM(
      originCoords.latitude,
      originCoords.longitude,
      destCoords.latitude,
      destCoords.longitude
    );

    res.json({
      data: {
        origin,
        destination,
        distance_nm: distance,
        distance_km: distance * 1.852,
        origin_coordinates: originCoords,
        destination_coordinates: destCoords
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate distance' });
  }
});

// POST calculate night time
router.post('/calculations/night-time', async (req: Request, res: Response) => {
  try {
    const { origin, destination, departure_time, flight_duration } = req.body;

    if (!origin || !destination || !departure_time || !flight_duration) {
      return res.status(400).json({ 
        error: 'Origin, destination, departure_time, and flight_duration are required' 
      });
    }

    const originCoords = await getAirportCoordinates(origin);
    const destCoords = await getAirportCoordinates(destination);

    if (!originCoords || !destCoords) {
      return res.status(404).json({ error: 'Airport coordinates not found' });
    }

    const nightTime = calculateNightTime(
      originCoords.latitude,
      originCoords.longitude,
      destCoords.latitude,
      destCoords.longitude,
      new Date(departure_time),
      flight_duration
    );

    res.json({
      data: {
        night_time_hours: nightTime,
        departure_time,
        flight_duration_hours: flight_duration,
        origin,
        destination
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate night time' });
  }
});

// GET solar times for location
router.get('/calculations/solar-times', async (req: Request, res: Response) => {
  try {
    const { airport, date } = req.query;

    if (!airport) {
      return res.status(400).json({ error: 'Airport code is required' });
    }

    const coords = await getAirportCoordinates(airport as string);

    if (!coords) {
      return res.status(404).json({ error: 'Airport not found' });
    }

    const targetDate = date ? new Date(date as string) : new Date();
    const solarTimes = getSolarTimes(coords.latitude, coords.longitude, targetDate);

    res.json({
      data: {
        airport,
        date: targetDate.toISOString().split('T')[0],
        ...solarTimes,
        coordinates: coords
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get solar times' });
  }
});

// GET search airports
router.get('/airports/search', async (req: Request, res: Response) => {
  try {
    const { query } = req.query;

    if (!query || (query as string).length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const results = await searchAirports(query as string);

    res.json({
      data: results,
      count: results.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search airports' });
  }
});

// ============= STATISTICS ROUTES =============

// GET dashboard statistics (cached - 5 min)
router.get(
  '/statistics/dashboard',
  cacheMiddleware({ ttl: 5 * 60 * 1000, key: 'statistics:dashboard' }),
  async (req: Request, res: Response) => {
    try {
      // Total flights
      const { count: totalFlights } = await supabase
        .from('flight_schedules')
        .select('*', { count: 'exact', head: true });

      // Active flights
      const { count: activeFlights } = await supabase
        .from('flight_schedules')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'em_voo');

      // Total aircraft
      const { count: totalAircraft } = await supabase
        .from('aircraft')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'Ativa');

      // Total clients
      const { count: totalClients } = await supabase
        .from('clients')
        .select('*', { count: 'exact', head: true });

      // Active crew members
      const { count: activeCrew } = await supabase
        .from('crew_members')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active');

      res.json({
        data: {
          totalFlights: totalFlights || 0,
          activeFlights: activeFlights || 0,
          totalAircraft: totalAircraft || 0,
          totalClients: totalClients || 0,
          activeCrew: activeCrew || 0
        },
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
    }
  }
);

// GET flight statistics by period (cached - 10 min)
router.get(
  '/statistics/flights',
  cacheMiddleware({ ttl: 10 * 60 * 1000, key: 'statistics:flights' }),
  async (req: Request, res: Response) => {
    try {
      const { start_date, end_date } = req.query;

      let query = supabase
        .from('flight_schedules')
        .select('*');

      if (start_date) {
        query = query.gte('flight_date', start_date as string);
      }

      if (end_date) {
        query = query.lte('flight_date', end_date as string);
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch flight statistics' });
      }

      const statistics = {
        total: data.length,
        byStatus: data.reduce((acc: any, flight: any) => {
          acc[flight.status] = (acc[flight.status] || 0) + 1;
          return acc;
        }, {}),
        byAircraft: data.reduce((acc: any, flight: any) => {
          acc[flight.aircraft_id] = (acc[flight.aircraft_id] || 0) + 1;
          return acc;
        }, {})
      };

      res.json({
        data: statistics,
        period: { start_date, end_date },
        timestamp: new Date().toISOString(),
        cached: res.get('X-Cache') === 'HIT'
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch flight statistics' });
    }
  }
);

// ============= MOUNT FINANCIAL ROUTES =============
router.use('/financial', financialRouter);

// ============= HEALTH CHECK =============
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

export default index;