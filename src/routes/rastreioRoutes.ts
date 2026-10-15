import { Hono } from 'hono'
import { requireShareInternal } from '../lib/auth'
import { checkRateLimit, clientIp } from '../lib/cache'
import { buscarPosicoes, configurarProvedor, provedorIndisponivel, type PosicaoAeronave } from '../lib/adsbProvider'

type Bindings = { SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; INTERNAL_TOKEN?: string; ADSB_PROVIDER?: string }
type Variables = Record<string, never>
export const rastreioRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function coordenada(valor: unknown): { lat: number; lon: number } | null {
  const partes = String(valor || '').split(',').map((item) => Number(item.trim()))
  if (partes.length !== 2 || !partes.every(Number.isFinite) || Math.abs(partes[0]!) > 90 || Math.abs(partes[1]!) > 180) return null
  return { lat: partes[0]!, lon: partes[1]! }
}

function statusRastreio(posicao: PosicaoAeronave | null, semIdentificador: boolean, indisponivel: boolean): string {
  if (semIdentificador) return 'sem_identificador'
  if (indisponivel) return 'indisponivel'
  if (!posicao || posicao.visto_ha_s === null || posicao.visto_ha_s > 300) return 'sem_sinal'
  if (posicao.visto_ha_s > 30) return 'atrasado'
  return 'ao_vivo'
}

rastreioRoutes.get('/api/interno/voos-em-operacao', async (c) => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  if (!(await checkRateLimit(c, `rastreio:${clientIp(c)}`, 120))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  configurarProvedor(c.env.ADSB_PROVIDER)
  const rows = await c.env.SHARE_DB.prepare(`
    SELECT s.id, s.numero_voo, lower(trim(s.status)) AS status_bruto, s.aeronave_id,
      s.origem, s.destino, s.horario_previsto_agendamento, a.matricula_registro, a.modelo, a.icao_hex,
      COALESCE(hs.nome, cl.razao_social) AS cotista_nome,
      COALESCE(tp.nome_completo, fp.nome_completo) AS piloto_nome,
      COALESCE(tc.nome_completo, fc.nome_completo) AS copiloto_nome,
      ao.coordenadas AS origem_coordenadas, ad.coordenadas AS destino_coordenadas
    FROM solicitacoes_reserva_voo s
    LEFT JOIN aeronave a ON a.id = s.aeronave_id
    LEFT JOIN hold_socios hs ON hs.id = s.socio_id
    LEFT JOIN cliente cl ON cl.id = s.cliente_id
    LEFT JOIN tripulacao tp ON tp.id = s.piloto_id
    LEFT JOIN tripulacao_freelancer fp ON fp.id = s.piloto_id
    LEFT JOIN tripulacao tc ON tc.id = s.copiloto_id
    LEFT JOIN tripulacao_freelancer fc ON fc.id = s.copiloto_id
    LEFT JOIN aerodromo ao ON upper(trim(ao.designativo_icao)) = upper(trim(s.origem))
    LEFT JOIN aerodromo ad ON upper(trim(ad.designativo_icao)) = upper(trim(s.destino))
    WHERE lower(trim(COALESCE(s.status, ''))) IN ('em_voo', 'em voo', 'em_rota', 'em rota', 'em_solo')
    ORDER BY s.criado_em DESC`).all<any>()
  const itens = rows.results || []
  const emVoo = itens.filter((item) => !['em_solo', 'em solo'].includes(item.status_bruto))
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
    const status = ['em_solo', 'em solo'].includes(item.status_bruto) ? 'em_solo' : 'em_voo'
    const identificador = String(item.icao_hex || '').trim().toUpperCase()
    const matricula = String(item.matricula_registro || '').trim().toUpperCase()
    const rastreio = status === 'em_voo' ? (porChave.get(identificador) || porChave.get(matricula) || null) : null
    const semIdentificador = !/^[0-9A-F]{6}$/.test(identificador) && !matricula
    return {
      id: item.id, numero_voo: item.numero_voo || null, status, aeronave_id: item.aeronave_id || null,
      matricula_registro: item.matricula_registro || null, modelo: item.modelo || null, icao_hex: item.icao_hex || null,
      origem: item.origem || null, destino: item.destino || null,
      origem_coord: coordenada(item.origem_coordenadas), destino_coord: coordenada(item.destino_coordenadas),
      horario_previsto_agendamento: item.horario_previsto_agendamento || null,
      cotista_nome: item.cotista_nome || null, piloto_nome: item.piloto_nome || null, copiloto_nome: item.copiloto_nome || null,
      rastreio, rastreio_status: statusRastreio(rastreio, semIdentificador, indisponivel),
    }
  })
  return c.json({ atualizado_em: new Date().toISOString(), voos })
})
