// Conferir termos de uso comercial do provedor antes de produção.

export type PosicaoAeronave = {
  hex: string
  matricula: string | null
  callsign: string | null
  lat: number
  lon: number
  alt_ft: number | null
  no_solo: boolean
  gs_kt: number | null
  rumo_graus: number | null
  vs_fpm: number | null
  visto_ha_s: number | null
  squawk: string | null
  fonte: string
}

type ReadsbAircraft = Record<string, unknown>
type ResultadoConsulta = { posicoes: PosicaoAeronave[]; disponivel: boolean }

const CACHE_TTL_MS = 5_000
const cache = new Map<string, { expiraEm: number; posicoes: PosicaoAeronave[] }>()
const pendentes = new Map<string, Promise<ResultadoConsulta>>()
let ultimoProvedorIndisponivel = false
let provedorConfigurado = ''

export function configurarProvedor(valor: string | undefined): void {
  provedorConfigurado = String(valor || '').trim().toLowerCase()
}

function numero(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizar(item: ReadsbAircraft, fonte: string): PosicaoAeronave | null {
  const lat = numero(item.lat)
  const lon = numero(item.lon)
  const hex = String(item.hex || '').trim().toUpperCase()
  if (!hex || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const altitude = item.alt_baro === 'ground' ? null : numero(item.alt_baro)
  return {
    hex,
    matricula: String(item.r || '').trim().toUpperCase() || null,
    callsign: String(item.flight || '').trim() || null,
    lat,
    lon,
    alt_ft: altitude,
    no_solo: item.alt_baro === 'ground',
    gs_kt: numero(item.gs),
    rumo_graus: numero(item.track),
    vs_fpm: numero(item.baro_rate),
    visto_ha_s: numero(item.seen_pos),
    squawk: String(item.squawk || '').trim() || null,
    fonte,
  }
}

function endpoint(provedor: string, tipo: 'hex' | 'reg', identificador: string): string {
  const base = provedor === 'airplanes_live' ? 'https://api.airplanes.live' : 'https://api.adsb.lol'
  return `${base}/v2/${tipo}/${encodeURIComponent(identificador)}`
}

async function consultar(provedor: string, hex: string[], matriculas: string[]): Promise<ResultadoConsulta> {
  const consultas = [
    ...hex.map((valor) => ({ tipo: 'hex' as const, valor })),
    ...matriculas.map((valor) => ({ tipo: 'reg' as const, valor })),
  ]
  if (!consultas.length) return { posicoes: [], disponivel: true }
  const respostas = await Promise.all(consultas.map(async ({ tipo, valor }) => {
    const controlador = new AbortController()
    const timer = setTimeout(() => controlador.abort(), 6_000)
    try {
      const resposta = await fetch(endpoint(provedor, tipo, valor), {
        signal: controlador.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ShareBrasil/1.0 (contato@sharebrasil.com.br)',
        },
        cf: { cacheTtl: 0 },
      })
      if (!resposta.ok) throw new Error(`adsb_${provedor}_${resposta.status}`)
      const corpo = await resposta.json() as { ac?: ReadsbAircraft[] }
      return (corpo.ac || []).map((item) => normalizar(item, provedor)).filter((item): item is PosicaoAeronave => Boolean(item))
    } finally {
      clearTimeout(timer)
    }
  }))
  const unicas = new Map<string, PosicaoAeronave>()
  respostas.flat().forEach((item) => unicas.set(`${item.hex}:${item.matricula || ''}`, item))
  return { posicoes: [...unicas.values()], disponivel: true }
}

async function buscarSemCache(hex: string[], matriculas: string[]): Promise<ResultadoConsulta> {
  const configurado = provedorConfigurado
  const primario = configurado === 'adsb_lol' ? 'adsb_lol' : 'airplanes_live'
  const secundario = primario === 'airplanes_live' ? 'adsb_lol' : 'airplanes_live'
  try {
    return await consultar(primario, hex, matriculas)
  } catch {
    try {
      return await consultar(secundario, hex, matriculas)
    } catch {
      return { posicoes: [], disponivel: false }
    }
  }
}

export async function buscarPosicoes(opts: { hex: string[]; matriculas: string[] }): Promise<PosicaoAeronave[]> {
  const hex = [...new Set(opts.hex.map((item) => item.trim().toUpperCase()).filter((item) => /^[0-9A-F]{6}$/.test(item)))]
  const matriculas = [...new Set(opts.matriculas.map((item) => item.trim().toUpperCase().replace(/-/g, '')).filter(Boolean))]
  const chave = `${hex.sort().join(',')}|${matriculas.sort().join(',')}`
  if (!chave || chave === '|') {
    ultimoProvedorIndisponivel = false
    return []
  }
  const agora = Date.now()
  const armazenado = cache.get(chave)
  if (armazenado && armazenado.expiraEm > agora) {
    ultimoProvedorIndisponivel = false
    return armazenado.posicoes
  }
  const existente = pendentes.get(chave)
  if (existente) {
    const resultado = await existente
    ultimoProvedorIndisponivel = !resultado.disponivel
    return resultado.posicoes
  }
  const pendente = buscarSemCache(hex, matriculas)
  pendentes.set(chave, pendente)
  try {
    const resultado = await pendente
    ultimoProvedorIndisponivel = !resultado.disponivel
    if (resultado.disponivel) cache.set(chave, { expiraEm: Date.now() + CACHE_TTL_MS, posicoes: resultado.posicoes })
    return resultado.posicoes
  } finally {
    pendentes.delete(chave)
  }
}

export function provedorIndisponivel(): boolean {
  return ultimoProvedorIndisponivel
}

