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

app.get('/api/weather/:icao',async(c)=>{

  const icao = c.req.param('icao').toUpperCase()

  const data = await cachedFetch(
    c,
    `metar-${icao}`,
    30,
    ()=>fetchAisweb(c,'met',{icaoCode:icao})
  )

  return c.json(data)

})

app.get('/api/nearest',async(c)=>{

  const lat = parseFloat(c.req.query('lat')||'')
  const lon = parseFloat(c.req.query('lon')||'')

  if(isNaN(lat)||isNaN(lon)){
    return c.json({error:"lat/lon inválidos"},400)
  }

  const raw = await fetchAisweb(c,'rotaer',{})

  const airports = normalizeAirportList(raw,lat,lon)

  airports.sort((a,b)=>a.distKm-b.distKm)

  return c.json({
    nearest:airports[0]
  })

})

app.get('/api/flightplan',async(c)=>{

  const adep = c.req.query('adep')?.toUpperCase()
  const ades = c.req.query('ades')?.toUpperCase()

  const speed = parseInt(c.req.query('speed') ?? '120')

  const burn = parseFloat(c.req.query('fuel_burn') ?? '32')
  const reserveMin = parseInt(c.req.query('reserve') ?? '45')

  if(!adep || !ades){
    return c.json({error:"adep e ades obrigatórios"},400)
  }

  try{

    const dep = await fetchAisweb(c,'rotaer',{icaoCode:adep})
    const des = await fetchAisweb(c,'rotaer',{icaoCode:ades})

    const depItem = dep?.item?.[0]
    const desItem = des?.item?.[0]

    const lat1 = parseCoord(depItem.latitude ?? depItem.lat)
    const lon1 = parseCoord(depItem.longitude ?? depItem.lon)

    const lat2 = parseCoord(desItem.latitude ?? desItem.lat)
    const lon2 = parseCoord(desItem.longitude ?? desItem.lon)

    if(lat1==null||lon1==null||lat2==null||lon2==null){
      return c.json({error:"coordenadas inválidas"},500)
    }

    const distanceKm = haversineKm(lat1,lon1,lat2,lon2)

    const distanceNm = distanceKm * 0.539957

    const flightHours = distanceNm / speed

    const reserveHours = reserveMin / 60

    const tripFuel = flightHours * burn
    const reserveFuel = reserveHours * burn
    const taxiFuel = burn * 0.1

    const totalFuel =
      tripFuel + reserveFuel + taxiFuel

    const route = `${adep} DCT ${ades}`

    return c.json({

      flightplan:{
        adep,
        ades,
        route,
        distance_nm:Math.round(distanceNm),
        cruise_speed:speed
      },

      fuel:{
        burn_lh:burn,
        trip_liters:Math.round(tripFuel),
        reserve_liters:Math.round(reserveFuel),
        taxi_liters:Math.round(taxiFuel),
        total_required:Math.round(totalFuel)
      }

    })

  }catch(err:any){

    return c.json({
      error:err.message
    },500)

  }

})

export default {
  fetch: app.fetch
}
