import { Hono } from 'hono'
import { requireShareInternal } from '../lib/auth'
import { checkRateLimit, clientIp } from '../lib/cache'
import { buscarPosicoes, configurarProvedor, provedorIndisponivel, type PosicaoAeronave } from '../lib/adsbProvider'
import { jornadaOperacionalDisponivel, statusAgendamentoComJornadaSql } from '../lib/flightStatus'

type Bindings = { SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; INTERNAL_TOKEN?: string; ADSB_PROVIDER?: string }
type Variables = Record<string, never>
export const rastreioRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type Coord = { lat: number; lon: number }
type PontoTrilha = { lat: number; lon: number; alt_ft: number }
type PernaOperacao = {
  id: string; numero: number; jornada_numero: number
  origem: string; destino: string; status: string
  horario_ac: string | null; horario_dep: string | null; horario_pouso: string | null; horario_corte: string | null
  origem_coord: Coord | null; destino_coord: Coord | null
}

const INTERVALO_MIN_TRILHA_S = 15
const MAX_PONTOS_TRILHA = 1500
const RETENCAO_TRILHA_DIAS = 3
// acionado e pousado contam como "em solo"; só decolado é "em voo"
const STATUS_EM_SOLO = ['acionado', 'em_solo', 'em solo', 'pousado']

rastreioRoutes.get('/api/rastreio/aeronave/matricula/:matricula', async (c) => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  if (!(await checkRateLimit(c, `rastreio-matricula:${clientIp(c)}`, 120))) {
    return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  }

  c.header('Cache-Control', 'private, no-store, no-cache, must-revalidate')
  const identificador = c.req.param('matricula').replace(/-/g, '').trim().toUpperCase()
  if (!/^(?:[0-9A-F]{6}|[A-Z0-9]{3,10})$/.test(identificador)) {
    return c.json({ error: 'matricula_ou_hex_invalido' }, 400)
  }

  configurarProvedor(c.env.ADSB_PROVIDER)
  try {
    const porHex = /^[0-9A-F]{6}$/.test(identificador)
    const posicoes = await buscarPosicoes({
      hex: porHex ? [identificador] : [],
      matriculas: porHex ? [] : [identificador],
    })
    if (provedorIndisponivel()) return c.json({ error: 'provedor_adsb_indisponivel' }, 503)

    const correspondentes = posicoes.filter((posicao) => porHex
      ? posicao.hex === identificador
      : posicao.matricula?.replace(/-/g, '').toUpperCase() === identificador)
    return c.json({ ac: correspondentes.map((posicao) => ({
      hex: posicao.hex,
      r: posicao.matricula,
      flight: posicao.callsign,
      lat: posicao.lat,
      lon: posicao.lon,
      alt_baro: posicao.no_solo ? 'ground' : posicao.alt_ft,
      gs: posicao.gs_kt,
      track: posicao.rumo_graus,
      nav_heading: posicao.rumo_graus,
      baro_rate: posicao.vs_fpm,
      squawk: posicao.squawk,
      seen_pos: posicao.visto_ha_s,
    })) })
  } catch {
    return c.json({ error: 'erro_ao_buscar_dados_adsb' }, 502)
  }
})

function coordenada(valor: unknown): Coord | null {
  const partes = String(valor || '').split(',').map((item) => Number(item.trim()))
  if (partes.length !== 2 || !partes.every(Number.isFinite) || Math.abs(partes[0]!) > 90 || Math.abs(partes[1]!) > 180) return null
  return { lat: partes[0]!, lon: partes[1]! }
}

function icao(valor: unknown): string {
  return String(valor || '').trim().toUpperCase()
}

function statusRastreio(posicao: PosicaoAeronave | null, semIdentificador: boolean, indisponivel: boolean): string {
  if (semIdentificador) return 'sem_identificador'
  if (indisponivel) return 'indisponivel'
  if (!posicao || posicao.visto_ha_s === null || posicao.visto_ha_s > 300) return 'sem_sinal'
  if (posicao.visto_ha_s > 30) return 'atrasado'
  return 'ao_vivo'
}

/** Busca as coordenadas dos aeródromos em lotes (limite de parâmetros do D1). */
async function coordenadasPorIcao(db: D1Database, icaos: string[]): Promise<Map<string, Coord | null>> {
  const unicos = [...new Set(icaos.filter(Boolean))]
  const resultado = new Map<string, Coord | null>()
  for (let i = 0; i < unicos.length; i += 50) {
    const lote = unicos.slice(i, i + 50)
    const rows = await db.prepare(`SELECT upper(trim(designativo_icao)) AS icao, coordenadas FROM aerodromo
      WHERE upper(trim(designativo_icao)) IN (${lote.map(() => '?').join(', ')})`).bind(...lote).all<{ icao: string; coordenadas: string | null }>()
    for (const row of rows.results || []) resultado.set(row.icao, coordenada(row.coordenadas))
  }
  return resultado
}

/** Todas as pernas (da jornada principal) de cada solicitação, em ordem: jornada, depois número da perna. */
async function buscarPernas(db: D1Database, solicitacaoIds: string[]): Promise<Map<string, Omit<PernaOperacao, 'origem_coord' | 'destino_coord'>[]>> {
  const porSolicitacao = new Map<string, Omit<PernaOperacao, 'origem_coord' | 'destino_coord'>[]>()
  if (!solicitacaoIds.length) return porSolicitacao
  const rows = await db.prepare(`
    SELECT j.solicitacao_id, j.numero_jornada, p.id, p.numero, p.origem, p.destino, p.status,
      p.horario_ac, p.horario_dep, p.horario_pouso, p.horario_corte
    FROM jornadas_voo j
    JOIN pernas_jornada_voo p ON p.jornada_id = j.id
    WHERE j.jornada_principal_id IS NULL AND j.solicitacao_id IN (${solicitacaoIds.map(() => '?').join(', ')})
    ORDER BY j.solicitacao_id, j.numero_jornada, p.numero`).bind(...solicitacaoIds).all<any>()
  for (const row of rows.results || []) {
    const lista = porSolicitacao.get(row.solicitacao_id) || []
    lista.push({
      id: row.id, numero: row.numero, jornada_numero: row.numero_jornada,
      origem: icao(row.origem), destino: icao(row.destino), status: String(row.status || 'programada'),
      horario_ac: row.horario_ac || null, horario_dep: row.horario_dep || null,
      horario_pouso: row.horario_pouso || null, horario_corte: row.horario_corte || null,
    })
    porSolicitacao.set(row.solicitacao_id, lista)
  }
  return porSolicitacao
}

/**
 * Grava a posição atual de cada perna em voo (no máximo 1 ponto a cada 15 s por perna,
 * e só se a posição mudou) e devolve a trilha acumulada de cada uma.
 * Falhas aqui (ex.: tabela ainda não migrada) não derrubam o endpoint: a trilha vem vazia.
 */
async function registrarELerTrilhas(
  db: D1Database,
  alvos: Array<{ solicitacaoId: string; chave: string; rastreio: PosicaoAeronave | null }>,
): Promise<Map<string, PontoTrilha[]>> {
  const trilhas = new Map<string, PontoTrilha[]>()
  if (!alvos.length) return trilhas
  try {
    const gravaveis = alvos.filter(({ rastreio }) =>
      rastreio && rastreio.lat != null && rastreio.lon != null
      && rastreio.visto_ha_s !== null && rastreio.visto_ha_s <= 30)
    if (gravaveis.length) {
      await db.batch(gravaveis.map(({ chave, solicitacaoId, rastreio }) => db.prepare(`
        INSERT INTO rastreio_posicoes (trilha_id, solicitacao_id, lat, lon, alt_ft, rumo_graus)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE NOT EXISTS (
          SELECT 1 FROM rastreio_posicoes
          WHERE trilha_id = ?1 AND registrado_em > datetime('now', '-${INTERVALO_MIN_TRILHA_S} seconds')
        )
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT lat, lon FROM rastreio_posicoes WHERE trilha_id = ?1 ORDER BY id DESC LIMIT 1) u
          WHERE u.lat = ?3 AND u.lon = ?4
        )`).bind(chave, solicitacaoId, rastreio!.lat, rastreio!.lon, rastreio!.no_solo ? 0 : (rastreio!.alt_ft ?? 0), rastreio!.rumo_graus ?? null)))
    }

    const chaves = [...new Set(alvos.map(({ chave }) => chave))]
    const pontos = await db.prepare(`
      SELECT trilha_id, lat, lon, alt_ft FROM (
        SELECT trilha_id, lat, lon, alt_ft, id,
          ROW_NUMBER() OVER (PARTITION BY trilha_id ORDER BY id DESC) AS rn
        FROM rastreio_posicoes WHERE trilha_id IN (${chaves.map(() => '?').join(', ')})
      ) WHERE rn <= ${MAX_PONTOS_TRILHA}
      ORDER BY trilha_id, id ASC`).bind(...chaves).all<{ trilha_id: string; lat: number; lon: number; alt_ft: number | null }>()
    for (const ponto of pontos.results || []) {
      const lista = trilhas.get(ponto.trilha_id) || []
      lista.push({ lat: ponto.lat, lon: ponto.lon, alt_ft: ponto.alt_ft ?? 0 })
      trilhas.set(ponto.trilha_id, lista)
    }

    if (Math.random() < 0.02) {
      await db.prepare(`DELETE FROM rastreio_posicoes WHERE registrado_em < datetime('now', '-${RETENCAO_TRILHA_DIAS} days')`).run()
    }
  } catch (error) {
    console.warn('[rastreio] trilha indisponível', error instanceof Error ? error.message : error)
  }
  return trilhas
}

rastreioRoutes.get('/api/interno/voos-em-operacao', async (c) => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  if (!(await checkRateLimit(c, `rastreio:${clientIp(c)}`, 120))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  configurarProvedor(c.env.ADSB_PROVIDER)
  const db = c.env.SHARE_DB

  const aeronaveSchema = await db.prepare("SELECT name FROM pragma_table_info('aeronave')").all<{ name: string }>()
  const colunaIcaoHex = (aeronaveSchema.results || []).some((column) => column.name === 'icao_hex')
    ? 'a.icao_hex'
    : 'NULL AS icao_hex'

  // Status operacional vem da ÚLTIMA PERNA da jornada mais recente (decolado / acionado / em_solo / aprovada ...)
  const jornadaDisponivel = await jornadaOperacionalDisponivel(db)
  const statusSql = statusAgendamentoComJornadaSql(jornadaDisponivel)

  const rows = await db.prepare(`
    WITH base AS (
      SELECT s.*, ${statusSql} AS status_calc
      FROM solicitacoes_reserva_voo s
    )
    SELECT s.id, s.numero_voo, s.status_calc AS status_bruto, s.aeronave_id,
      s.origem, s.destino, s.horario_previsto_agendamento, a.matricula_registro, a.modelo, ${colunaIcaoHex},
      COALESCE(hs.nome, cl.razao_social) AS cotista_nome,
      COALESCE(tp.nome_completo, fp.nome_completo) AS piloto_nome,
      COALESCE(tc.nome_completo, fc.nome_completo) AS copiloto_nome
    FROM base s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id
    LEFT JOIN hold_socios hs ON hs.id = s.socio_id
    LEFT JOIN cliente cl ON cl.id = s.cliente_id
    LEFT JOIN tripulacao tp ON tp.id = s.piloto_id
    LEFT JOIN tripulacao_freelancer fp ON fp.id = s.piloto_id
    LEFT JOIN tripulacao tc ON tc.id = s.copiloto_id
    LEFT JOIN tripulacao_freelancer fc ON fc.id = s.copiloto_id
    WHERE s.status_calc IN ('decolado', 'acionado', 'em_solo', 'em solo', 'pousado')
      OR (s.status_calc = 'aprovada'
        AND datetime(COALESCE(s.horario_previsto_agendamento, s.data_agendada || 'T00:00:00Z'))
          BETWEEN datetime('now', '-6 hours') AND datetime('now', '+2 hours'))
    ORDER BY s.criado_em DESC`).all<any>()

  const itens = rows.results || []
  const noSolo = (status: string) => STATUS_EM_SOLO.includes(status)

  // Pernas reais de cada operação: a perna é a referência de rota, não a solicitação
  const pernasPorSolicitacao = jornadaDisponivel
    ? await buscarPernas(db, itens.map((item) => item.id))
    : new Map<string, Omit<PernaOperacao, 'origem_coord' | 'destino_coord'>[]>()
  const coordenadas = await coordenadasPorIcao(db, [
    ...itens.flatMap((item) => [icao(item.origem), icao(item.destino)]),
    ...[...pernasPorSolicitacao.values()].flat().flatMap((perna) => [perna.origem, perna.destino]),
  ])

  const emVoo = itens.filter((item) => !noSolo(item.status_bruto))
  const posicoes = await buscarPosicoes({
    hex: emVoo.map((item) => item.icao_hex).filter(Boolean),
    matriculas: emVoo.map((item) => item.matricula_registro).filter(Boolean),
  })
  const porChave = new Map<string, PosicaoAeronave>()
  posicoes.forEach((item) => {
    porChave.set(item.hex, item)
    if (item.matricula) porChave.set(item.matricula, item)
  })
  const indisponivel = provedorIndisponivel()

  const voos = itens.map((item) => {
    const statusRegistrado = noSolo(item.status_bruto) ? 'em_solo' : 'em_voo'
    const identificador = String(item.icao_hex || '').trim().toUpperCase()
    const matricula = String(item.matricula_registro || '').trim().toUpperCase()
    const rastreio = statusRegistrado === 'em_voo' ? (porChave.get(identificador) || porChave.get(matricula) || null) : null
    // Voo só aprovado (sem jornada iniciada) só aparece se o ADS-B confirmar que está no ar
    const confirmadoNoAr = item.status_bruto === 'aprovada'
      && Boolean(rastreio && !rastreio.no_solo && rastreio.visto_ha_s !== null && rastreio.visto_ha_s <= 30)
    if (item.status_bruto === 'aprovada' && !confirmadoNoAr) return null
    const status = confirmadoNoAr ? 'em_voo' : statusRegistrado
    const semIdentificador = !/^[0-9A-F]{6}$/.test(identificador) && !matricula

    const pernas: PernaOperacao[] = (pernasPorSolicitacao.get(item.id) || []).map((perna) => ({
      ...perna,
      origem_coord: coordenadas.get(perna.origem) ?? null,
      destino_coord: coordenadas.get(perna.destino) ?? null,
    }))
    const pernaAtual = pernas[pernas.length - 1] ?? null
    const origem = pernaAtual?.origem || icao(item.origem) || null
    const destino = pernaAtual?.destino || icao(item.destino) || null

    return {
      id: item.id as string, numero_voo: item.numero_voo || null, status, aeronave_id: item.aeronave_id || null,
      matricula_registro: item.matricula_registro || null, modelo: item.modelo || null, icao_hex: item.icao_hex || null,
      // rota da PERNA ATUAL (a da solicitação só entra se ainda não há perna)
      origem, destino,
      origem_coord: origem ? coordenadas.get(origem) ?? null : null,
      destino_coord: destino ? coordenadas.get(destino) ?? null : null,
      perna_atual: pernaAtual, pernas,
      horario_previsto_agendamento: item.horario_previsto_agendamento || null,
      cotista_nome: item.cotista_nome || null, piloto_nome: item.piloto_nome || null, copiloto_nome: item.copiloto_nome || null,
      rastreio, rastreio_status: statusRastreio(rastreio, semIdentificador, indisponivel),
    }
  }).filter((voo): voo is NonNullable<typeof voo> => voo !== null)

  // Trilha por perna: cada decolagem começa um rastro novo
  const emVooAgora = voos.filter((voo) => voo.status === 'em_voo')
  const trilhas = await registrarELerTrilhas(db, emVooAgora.map((voo) => ({
    solicitacaoId: voo.id, chave: voo.perna_atual?.id ?? voo.id, rastreio: voo.rastreio,
  })))

  return c.json({
    atualizado_em: new Date().toISOString(),
    voos: voos.map((voo) => ({ ...voo, trilha: trilhas.get(voo.perna_atual?.id ?? voo.id) ?? [] })),
  })
})
