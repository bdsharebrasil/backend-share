import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { XMLParser } from 'fast-xml-parser'

type Bindings = {
  AISWEB_API_KEY: string
  AISWEB_API_PASS: string
  CACHE_KV: KVNamespace
  AI: any
}

const app = new Hono<{ Bindings: Bindings }>()

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ['item','notam','carta','sol'].includes(name),
})

app.use('*', cors())

const AISWEB_BASE_URL = 'https://api.decea.mil.br/aisweb/'

const AREA_NODE_MAP: Record<string,string> = {
  met:'met',
  cartas:'cartas',
  notam:'notam',
  infotemp:'infotemp',
  sol:'sol',
  routesp:'routesp',
  waypoints:'waypoints',
  rotaer:'rotaer',
  pub:'pub',
  suplementos:'suplementos',
  geiloc:'geiloc'
}

async function cachedFetch(
  c: Context<{ Bindings: Bindings }>,
  key:string,
  ttl:number,
  fetcher:()=>Promise<any>
){
  const cache = await c.env.CACHE_KV.get(key)

  if(cache) return JSON.parse(cache)

  const data = await fetcher()

  await c.env.CACHE_KV.put(
    key,
    JSON.stringify(data),
    { expirationTtl: ttl }
  )

  return data
}

const fetchAisweb = async(
  c:Context<{Bindings:Bindings}>,
  area:string,
  params:Record<string,string|undefined>
)=>{
  const apiKey = c.env.AISWEB_API_KEY?.trim()
  const apiPass = c.env.AISWEB_API_PASS?.trim()

  if(!apiKey || !apiPass){
    throw new Error("Credenciais AISWEB ausentes")
  }

  const parts:string[] = [
    `apiKey=${apiKey}`,
    `apiPass=${apiPass}`,
    `area=${area}`
  ]

  Object.entries(params).forEach(([k,v])=>{
    if(v) parts.push(`${k}=${v}`)
  })

  const url = `${AISWEB_BASE_URL}?${parts.join('&')}`

  const res = await fetch(url,{
    headers:{
      'User-Agent':'Mozilla/5.0',
      'Accept':'text/xml,application/xml,*/*'
    }
  })

  const text = await res.text()

  if(!res.ok) throw new Error(`HTTP ${res.status}`)
  if(!text) throw new Error("Resposta vazia")

  try{
    return JSON.parse(text)
  }catch{}

  const parsed = parser.parse(text)

  const aisweb = parsed['aisweb'] ?? parsed
  const node = AREA_NODE_MAP[area]

  return node && aisweb[node] ? aisweb[node] : aisweb
}

function haversineKm(
  lat1:number,lon1:number,
  lat2:number,lon2:number
){
  const R = 6371
  const toRad = (d:number)=>d*Math.PI/180

  const dLat = toRad(lat2-lat1)
  const dLon = toRad(lon2-lon1)

  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon/2)**2

  return R * 2 * Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
}

function parseCoord(raw:any):number|null{

  if(raw==null) return null

  if(typeof raw === 'number') return raw

  const s = String(raw).trim()

  if(/^-?\d+\.\d+$/.test(s)){
    return parseFloat(s)
  }

  const gms = s.match(/^(\d{2,3})(\d{2})(\d{2})([NSEW])$/i)

  if(gms){
    const deg = parseInt(gms[1])
    const min = parseInt(gms[2])
    const sec = parseInt(gms[3])
    const hem = gms[4].toUpperCase()

    const dec = deg + min/60 + sec/3600

    return (hem==='S'||hem==='W') ? -dec : dec
  }

  const n = parseFloat(s)
  return isNaN(n)?null:n
}

interface Airport{
  icao:string
  name:string
  lat:number
  lon:number
  distKm:number
}

function normalizeAirportList(
  data:any,
  userLat:number,
  userLon:number
):Airport[]{

  const src = data?.item ?? data
  const items = Array.isArray(src)?src:[src]

  const list:Airport[] = []

  for(const item of items){

    const icao =
      item?.icaoCode ??
      item?.icao ??
      item?.CodICAO

    if(!icao) continue

    const lat = parseCoord(item?.latitude ?? item?.lat)
    const lon = parseCoord(item?.longitude ?? item?.lon)

    if(lat==null || lon==null) continue

    const distKm = Math.round(
      haversineKm(userLat,userLon,lat,lon)
    )

    list.push({
      icao,
      name:item?.nome ?? icao,
      lat,
      lon,
      distKm
    })
  }

  return list
}

app.get('/',(c)=>
  c.text("ShareBrasil API 🚀")
)

// ==================== WEATHER (METAR) ====================
app.get('/api/weather/:icao',async(c)=>{

  const icao = c.req.param('icao').toUpperCase()

  try {
    const data = await cachedFetch(
      c,
      `metar-${icao}`,
      300, // 5 minutos
      ()=>fetchAisweb(c,'met',{icaoCode:icao})
    )

    return c.json(data)
  } catch(err:any) {
    return c.json({error:err.message},500)
  }

})

// ==================== NOTAM ====================
app.get('/api/notam/:icao',async(c)=>{

  const icao = c.req.param('icao').toUpperCase()

  try {
    const data = await cachedFetch(
      c,
      `notam-${icao}`,
      600, // 10 minutos
      ()=>fetchAisweb(c,'notam',{icaoCode:icao})
    )

    return c.json(data)
  } catch(err:any) {
    return c.json({error:err.message},500)
  }

})

// ==================== CARTAS (CHARTS) ====================
app.get('/api/charts/:icao',async(c)=>{

  const icao = c.req.param('icao').toUpperCase()
  const especie = c.req.query('especie') // Ex: "APP", "STR", "IAC"
  const tipo = c.req.query('tipo') // Ex: "PDF", "PNG"

  try {
    const params: Record<string,string|undefined> = {icaoCode:icao}
    if(especie) params.especie = especie
    if(tipo) params.tipo = tipo

    const data = await cachedFetch(
      c,
      `charts-${icao}-${especie||''}-${tipo||''}`,
      3600, // 1 hora (cartas mudam menos frequentemente)
      ()=>fetchAisweb(c,'cartas',params)
    )

    return c.json(data)
  } catch(err:any) {
    return c.json({error:err.message},500)
  }

})

// ==================== ROTAER (ROUTES) ====================
app.get('/api/rotaer',async(c)=>{
  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()

  try {
    const params: Record<string,string|undefined> = {}
    if(adep) params.adep = adep
    if(ades) params.ades = ades

    const cacheKey = adep && ades
      ? `rotaer-${adep}-${ades}`
      : 'rotaer-all'

    const data = await cachedFetch(
      c,
      cacheKey,
      1800, // 30 minutos
      ()=>fetchAisweb(c,'rotaer',params)
    )

    return c.json(data)
  } catch(err:any) {
    return c.json({error:err.message},500)
  }

})

// ==================== NEAREST AIRPORT ====================
app.get('/api/nearest',async(c)=>{

  const lat = parseFloat(c.req.query('lat')||'')
  const lon = parseFloat(c.req.query('lon')||'')

  if(isNaN(lat)||isNaN(lon)){
    return c.json({error:"lat/lon inválidos"},400)
  }

  try {
    const raw = await cachedFetch(
      c,
      'rotaer-all',
      1800,
      ()=>fetchAisweb(c,'rotaer',{})
    )

    const airports = normalizeAirportList(raw,lat,lon)

    airports.sort((a,b)=>a.distKm-b.distKm)

    return c.json({
      nearest:airports[0],
      alternates: airports.slice(0,5)
    })
  } catch(err:any) {
    return c.json({error:err.message},500)
  }

})

// ==================== GEILOC NEARBY ====================
app.get('/api/geiloc/nearby',async(c)=>{

  const lat = parseFloat(c.req.query('lat')||'')
  const lon = parseFloat(c.req.query('lon')||'')

  if(isNaN(lat)||isNaN(lon)){
    return c.json({error:"lat/lon inválidos"},400)
  }

  try {
    const raw = await cachedFetch(
      c,
      `geiloc-${Math.round(lat*10)}-${Math.round(lon*10)}`, // Arredondar para cache melhor
      1800,
      ()=>fetchAisweb(c,'rotaer',{})
    )

    const airports = normalizeAirportList(raw,lat,lon)

    airports.sort((a,b)=>a.distKm-b.distKm)

    return c.json({
      alternates: airports.filter(a=>a.distKm<200).slice(0,10)
    })
  } catch(err:any) {
    return c.json({error:err.message},500)
  }

})

// ==================== FLIGHT PLAN ====================
app.get('/api/flightplan', async (c) => {

  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()

  const speed = parseInt(c.req.query('speed') ?? '120')
  const burn = parseFloat(c.req.query('fuel_burn') ?? '32')
  const reserveMin = parseInt(c.req.query('reserve') ?? '45')

  if (!adep || !ades) {
    return c.json({ error: 'adep e ades obrigatórios' }, 400)
  }

  try {

    // origem
    const dep = await fetchAisweb(c,'rotaer',{icaoCode:adep})

    // destino
    const des = await fetchAisweb(c,'rotaer',{icaoCode:ades})

    const depItem = dep?.item?.[0]
    const desItem = des?.item?.[0]

    if(!depItem || !desItem){
      return c.json({error:"Aeródromo não encontrado"},404)
    }

    const lat1 = parseCoord(depItem.latitude ?? depItem.lat)
    const lon1 = parseCoord(depItem.longitude ?? depItem.lon)

    const lat2 = parseCoord(desItem.latitude ?? desItem.lat)
    const lon2 = parseCoord(desItem.longitude ?? desItem.lon)

    if(lat1==null||lon1==null||lat2==null||lon2==null){
      return c.json({error:"Coordenadas inválidas"},500)
    }

    // distância
    const distanceKm = haversineKm(lat1,lon1,lat2,lon2)
    const distanceNm = distanceKm * 0.539957

    // tempo
    const flightHours = distanceNm / speed
    const reserveHours = reserveMin / 60

    const hours = Math.floor(flightHours)
    const minutes = Math.round((flightHours-hours)*60)

    // combustível
    const tripFuel = flightHours * burn
    const reserveFuel = reserveHours * burn
    const taxiFuel = burn * 0.1

    const totalFuel = tripFuel + reserveFuel + taxiFuel

    // rota preferencial
    let routePref=null

    try{
      routePref = await fetchAisweb(c,'routesp',{adep,ades})
    }catch{}

    const route =
      routePref?.item?.[0]?.rota ??
      `${adep} DCT ${ades}`

    // alternados automáticos
    const rawAirports = await cachedFetch(
      c,
      `geiloc-${Math.round(lat2*10)}-${Math.round(lon2*10)}`,
      1800,
      ()=>fetchAisweb(c,'rotaer',{})
    )

    const airports = normalizeAirportList(
      rawAirports,
      lat2,
      lon2
    )

    const alternates = airports
      .filter(a => a.icao !== ades)
      .filter(a => a.distKm < 150)
      .slice(0,3)

    // NOTAM origem
    const notamDep = await fetchAisweb(c,'notam',{icaoCode:adep})

    // NOTAM destino
    const notamDes = await fetchAisweb(c,'notam',{icaoCode:ades})

    const depItems = Array.isArray(notamDep?.item)
      ? notamDep.item
      : [notamDep?.item]

    const desItems = Array.isArray(notamDes?.item)
      ? notamDes.item
      : [notamDes?.item]

    const notamAlerts = [...depItems,...desItems]
      .map(n => n?.texto ?? n?.notam)
      .filter(Boolean)
      .slice(0,5)

    // IA briefing (opcional, comentado se AI não está disponível)
    let briefing = "Briefing indisponível"
    try {
      const ai = await c.env.AI.run(
        '@cf/meta/llama-3-8b-instruct',
        {
          messages:[
            {
              role:"system",
              content:"Você é um despachante de voo."
            },
            {
              role:"user",
              content:`
Plano de voo
Origem ${adep}
Destino ${ades}
Distância ${Math.round(distanceNm)} NM
Tempo estimado: ${hours}h${minutes}m
`
            }
          ]
        }
      )
      briefing = ai.response
    } catch(aiErr) {
      console.warn("AI briefing indisponível:", aiErr)
    }

    return c.json({

      flightplan:{
        adep,
        ades,
        route,
        distance_nm:Math.round(distanceNm),
        estimated_time:`${hours}h${minutes}m`,
        cruise_speed:speed
      },

      fuel:{
        burn_lh:burn,
        trip_liters:Math.round(tripFuel),
        reserve_liters:Math.round(reserveFuel),
        taxi_liters:Math.round(taxiFuel),
        total_required:Math.round(totalFuel)
      },

      alternates:alternates.map(a=>({
        icao:a.icao,
        name:a.name,
        distance_km:a.distKm
      })),

      notam_alerts:notamAlerts,

      briefing

    })

  } catch(err:any){

    return c.json({error:err.message},500)

  }

})

export default {
  fetch: app.fetch
}
