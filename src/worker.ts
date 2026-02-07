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

export default app;
