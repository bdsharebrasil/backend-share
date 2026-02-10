import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  AISWEB_API_KEY: string;
  AISWEB_API_PASS: string;
  CACHE_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// ============= HELPER DE COMUNICAÇÃO =============
const fetchAisweb = async (c: Context<{ Bindings: Bindings }>, area: string, additionalParams: Record<string, string | undefined>) => {
  // Mudamos para o domínio principal da documentação que você passou
  const baseUrl = `https://aisweb.decea.mil.br/api/`;
  
  const params = new URLSearchParams({
    apiKey: c.env.AISWEB_API_KEY,
    apiPass: c.env.AISWEB_API_PASS,
    area: area,
  });

  Object.entries(additionalParams).forEach(([key, value]) => {
    if (value) params.append(key, value);
  });

  const finalUrl = `${baseUrl}?${params.toString()}`;

  const res = await fetch(finalUrl, {
    method: 'GET',
    headers: {
      // O "pulo do gato": fingir que é um navegador para evitar o erro 530
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  
  // Se o erro 530 persistir, a AISWEB pode estar offline ou bloqueando o IP do Cloudflare
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "Sem detalhes");
    throw new Error(`AISWEB Indisponível (Status ${res.status}). Detalhes: ${errorBody.substring(0, 100)}`);
  }

  const text = await res.text();
  
  try {
    return JSON.parse(text);
  } catch (e) {
    // Se não for JSON, pode ser que ela tenha retornado XML (padrão deles)
    throw new Error(`A AISWEB retornou XML em vez de JSON. Verifique se o parâmetro display=json é suportado nesta área.`);
  }
};

// ============= ROTAS =============

app.get('/', (c) => c.text('ShareBrasil API - Central DECEA Ativa 🚀'));

// 1. Meteorologia (METAR/TAF)
app.get('/api/weather/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'met', { icaoCode: c.req.param('icao') });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 2. Cartas (Especie, Tipo, Icao)
app.get('/api/charts/:icao', async (c) => {
  try {
    const params = {
      icaoCode: c.req.param('icao'),
      especie: c.req.query('especie') || 'IFR',
      tipo: c.req.query('tipo'),
      useAll: '1'
    };
    const data = await fetchAisweb(c, 'cartas', params);
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 3. NOTAM
app.get('/api/notam/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'notam', { icaocode: c.req.param('icao') });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 4. InfoTemp (ROTAER)
app.get('/api/infotemp/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'infotemp', { icaoCode: c.req.param('icao') });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 5. Nascer/Pôr do Sol
app.get('/api/solar/:icao', async (c) => {
  try {
    const data = await fetchAisweb(c, 'sol', { 
        icaoCode: c.req.param('icao'),
        dt_i: c.req.query('date') 
    });
    return c.json(data);
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

// 6. Rotas Preferenciais
app.get('/api/routes', async (c) => {
  try {
    const data = await fetchAisweb(c, 'routesp', { 
      adep: c.req.query('adep'), 
      ades: c.req.query('ades') 
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

export default { fetch: app.fetch };
