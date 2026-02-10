import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import { XMLParser } from 'fast-xml-parser'; 

type Bindings = {
  AISWEB_API_KEY: string;
  AISWEB_API_PASS: string;
  CACHE_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

app.use('*', cors());

const fetchAisweb = async (c: Context<{ Bindings: Bindings }>, area: string, additionalParams: Record<string, string | undefined>) => {
  const baseUrl = `https://aisweb.decea.mil.br/api/`;
  const params = new URLSearchParams({
    apiKey: c.env.AISWEB_API_KEY,
    apiPass: c.env.AISWEB_API_PASS,
    area: area,
  });

  Object.entries(additionalParams).forEach(([key, value]) => {
    if (value) params.append(key, value);
  });

  const res = await fetch(`${baseUrl}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 ShareBrasil' }
  });

  const text = await res.text();

  // 1. Tenta JSON direto
  try {
    return JSON.parse(text);
  } catch {
    // 2. Se falhar, vai para o XML
    const jsonObj = parser.parse(text);
    
    // 3. LOG DE DEPURAÇÃO (Importante):
    // Se você rodar 'wrangler tail', verá o que a AISWEB respondeu de verdade.
    console.log("Resposta bruta da AISWEB:", text);

    // 4. Remove a "casca" do XML (pega o que está dentro da tag raiz, seja ela qual for)
    const rootKey = Object.keys(jsonObj)[0];
    return rootKey ? jsonObj[rootKey] : jsonObj;
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
