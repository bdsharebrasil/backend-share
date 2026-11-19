// Verificar termos de uso e limites dos provedores para uso comercial em produção.

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

const CACHE_TTL_MS = 10_000
// A API anônima do adsb.lol tem cota diária. Não insistir a cada atualização do painel.
const FALLBACK_TTL_MS = 180_000
const cache = new Map<string, { expiraEm: number; posicoes: PosicaoAeronave[]; disponivel: boolean }>()
const cacheFallback = new Map<string, { consultadoEm: number; resultado: ResultadoConsulta }>()
const pendentes = new Map<string, Promise<ResultadoConsulta>>()
let ultimoProvedorIndisponivel = false
let provedorConfigurado = ''

export function configurarProvedor(valor: string | undefined): void {
  provedorConfigurado = String(valor || '').trim().toLowerCase()
}

export function normalizarMatricula(valor: string): string {
  return String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Os provedores podem indexar PT-WSR ou PTWSR; consultar ambas sem duplicar a aeronave. */
export function variantesMatricula(valor: string): string[] {
  const simples = normalizarMatricula(valor)
  if (!simples) return []
  const prefixoBrasil = simples.match(/^(PP|PR|PS|PT)([A-Z0-9]{3})$/)
  return [...new Set(prefixoBrasil ? [`${prefixoBrasil[1]}-${prefixoBrasil[2]}`, simples] : [simples])]
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
  if (!/^[0-9A-F]{6}$/.test(hex) || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const altitude = item.alt_baro === 'ground' ? null : numero(item.alt_baro)
  const visto = numero(item.seen_pos) ?? numero(item.seen)
  return {
    hex,
    matricula: String(item.r || '').trim().toUpperCase() || null,
    callsign: String(item.flight || '').trim().toUpperCase() || null,
    lat,
    lon,
    alt_ft: altitude,
    no_solo: item.alt_baro === 'ground' || item.ground === true,
    gs_kt: numero(item.gs),
    rumo_graus: numero(item.track),
    vs_fpm: numero(item.baro_rate),
    visto_ha_s: visto,
    squawk: String(item.squawk || '').trim() || null,
    fonte,
  }
}

function endpoint(provedor: string, tipo: 'hex' | 'reg', identificadores: string[]): string {
  const base = provedor === 'airplanes_live' ? 'https://api.airplanes.live' : 'https://api.adsb.lol'
  return `${base}/v2/${tipo}/${encodeURIComponent(identificadores.join(','))}`
}

/** Faz uma consulta em lote, sem transformar 1 erro HTTP em falha de todas as aeronaves. */
async function consultar(provedor: string, hex: string[], matriculas: string[]): Promise<ResultadoConsulta> {
  const alternativas = [...new Set(matriculas.flatMap(variantesMatricula))]
  const consultas: Array<{ tipo: 'hex' | 'reg'; ids: string[] }> = []
  // A matrícula é prioritária porque o HEX informado no cadastro pode estar desatualizado.
  if (alternativas.length) consultas.push({ tipo: 'reg', ids: alternativas })
  if (hex.length) consultas.push({ tipo: 'hex', ids: hex })
  if (!consultas.length) return { posicoes: [], disponivel: true }

  let respondeu = false
  const unicas = new Map<string, PosicaoAeronave>()
  for (const { tipo, ids } of consultas) {
    const controlador = new AbortController()
    const timer = setTimeout(() => controlador.abort(), 6_000)
    try {
      const resposta = await fetch(endpoint(provedor, tipo, ids), {
        signal: controlador.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ShareBrasil/1.0 (contato@sharebrasil.com.br)',
        },
        cf: { cacheTtl: 0 },
      })
      if (!resposta.ok) throw new Error(`adsb_${provedor}_${resposta.status}`)
      const corpo = await resposta.json() as { ac?: ReadsbAircraft[] }
      respondeu = true
      for (const bruto of Array.isArray(corpo.ac) ? corpo.ac : []) {
        const item = normalizar(bruto, provedor)
        if (!item) continue
        const atual = unicas.get(item.hex)
        if (!atual || (item.visto_ha_s ?? Infinity) < (atual.visto_ha_s ?? Infinity)) unicas.set(item.hex, item)
      }
      // Nenhuma necessidade de consultar HEX se a matrícula já identificou a aeronave.
      if (unicas.size >= Math.max(hex.length, matriculas.length)) break
    } catch (erro) {
      console.warn('[rastreio/provedor] consulta falhou', provedor, tipo, erro instanceof Error ? erro.message : erro)
    } finally {
      clearTimeout(timer)
    }
  }
  return { posicoes: [...unicas.values()], disponivel: respondeu }
}

/** Não reciclar um ponto de 3 minutos atrás como se tivesse sido visto agora. */
function envelhecer(resultado: ResultadoConsulta, consultadoEm: number): ResultadoConsulta {
  const segundos = Math.max(0, (Date.now() - consultadoEm) / 1000)
  return {
    disponivel: resultado.disponivel,
    posicoes: resultado.posicoes.map((posicao) => ({
      ...posicao,
      visto_ha_s: posicao.visto_ha_s === null ? null : posicao.visto_ha_s + segundos,
    })),
  }
}

function combinar(resultados: ResultadoConsulta[]): ResultadoConsulta {
  const posicoes = new Map<string, PosicaoAeronave>()
  for (const resultado of resultados) {
    for (const posicao of resultado.posicoes) {
      const atual = posicoes.get(posicao.hex)
      if (!atual || (posicao.visto_ha_s ?? Infinity) < (atual.visto_ha_s ?? Infinity)) posicoes.set(posicao.hex, posicao)
    }
  }
  return { posicoes: [...posicoes.values()], disponivel: resultados.some((resultado) => resultado.disponivel) }
}

async function buscarSemCache(hex: string[], matriculas: string[]): Promise<ResultadoConsulta> {
  const primario = provedorConfigurado === 'adsb_lol' ? 'adsb_lol' : 'airplanes_live'
  const secundario = primario === 'airplanes_live' ? 'adsb_lol' : 'airplanes_live'
  const principal = await consultar(primario, hex, matriculas)
  const esperado = Math.max(hex.length, matriculas.length)
  const recentes = principal.posicoes.filter((item) => item.visto_ha_s !== null && item.visto_ha_s <= 120).length
  // Uma aeronave visível em outra rede pode faltar na primeira, mesmo com resposta HTTP 200.
  if (principal.disponivel && recentes >= esperado) return principal

  const chave = `${secundario}:${hex.join(',')}:${matriculas.join(',')}`
  const anterior = cacheFallback.get(chave)
  let outraFonte: ResultadoConsulta
  if (anterior && Date.now() - anterior.consultadoEm < FALLBACK_TTL_MS) {
    outraFonte = envelhecer(anterior.resultado, anterior.consultadoEm)
  } else {
    outraFonte = await consultar(secundario, hex, matriculas)
    // Evita esgotar a cota anônima, inclusive quando a fonte retorna vazio/429.
    if (cacheFallback.size > 300) cacheFallback.clear()
    cacheFallback.set(chave, { consultadoEm: Date.now(), resultado: outraFonte })
  }
  return combinar([principal, outraFonte])
}

export async function buscarPosicoes(opts: { hex: string[]; matriculas: string[] }): Promise<PosicaoAeronave[]> {
  const hex = [...new Set(opts.hex.map((item) => item.trim().toUpperCase()).filter((item) => /^[0-9A-F]{6}$/.test(item)))].sort()
  const matriculas = [...new Set(opts.matriculas.map(normalizarMatricula).filter(Boolean))].sort()
  const chave = `${provedorConfigurado}:${hex.join(',')}|${matriculas.join(',')}`
  if (!hex.length && !matriculas.length) {
    ultimoProvedorIndisponivel = false
    return []
  }
  const armazenado = cache.get(chave)
  if (armazenado && armazenado.expiraEm > Date.now()) {
    ultimoProvedorIndisponivel = !armazenado.disponivel
    return envelhecer(
      { posicoes: armazenado.posicoes, disponivel: armazenado.disponivel },
      armazenado.expiraEm - CACHE_TTL_MS,
    ).posicoes
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
    cache.set(chave, {
      expiraEm: Date.now() + CACHE_TTL_MS,
      posicoes: resultado.posicoes,
      disponivel: resultado.disponivel,
    })
    return resultado.posicoes
  } finally {
    pendentes.delete(chave)
  }
}

export function provedorIndisponivel(): boolean {
  return ultimoProvedorIndisponivel
}
