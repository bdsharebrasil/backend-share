import { Hono } from 'hono'
import { lerHistorico, registrarSinal, LIMITE_SINAL_S } from '../lib/rastreioHistorico'
import { requireShareInternal } from '../lib/auth'
import { checkRateLimit, clientIp } from '../lib/cache'
import { buscarPosicoes, configurarProvedor, provedorIndisponivel, type PosicaoAeronave } from '../lib/adsbProvider'
import { jornadaOperacionalDisponivel, statusAgendamentoComJornadaSql } from '../lib/flightStatus'

export type RastreioBindings = { SHARE_DB: D1Database; CACHE_KV: KVNamespace; RATE_LIMITER: DurableObjectNamespace; INTERNAL_TOKEN?: string; ADSB_PROVIDER?: string }
type Variables = Record<string, never>
export const rastreioRoutes = new Hono<{ Bindings: RastreioBindings; Variables: Variables }>()

type Coord = { lat: number; lon: number }
type PernaOperacao = {
  id: string; numero: number; jornada_numero: number
  origem: string; destino: string; status: string
  horario_ac: string | null; horario_dep: string | null; horario_pouso: string | null; horario_corte: string | null
  horario_ac_user_id: string | null; horario_dep_user_id: string | null
  horario_pouso_user_id: string | null; horario_corte_user_id: string | null
  horario_ac_usuario_nome: string | null; horario_dep_usuario_nome: string | null
  horario_pouso_usuario_nome: string | null; horario_corte_usuario_nome: string | null
  origem_coord: Coord | null; destino_coord: Coord | null
}

const STATUS_EM_SOLO = ['em_solo', 'em solo', 'pousado']

/** O corte da última perna encerra a exibição no painel, mas não apaga o histórico do agendamento. */
export function vooFinalizadoPorCorte(pernas: Array<Pick<PernaOperacao, 'horario_corte' | 'status'>>): boolean {
  const ultimaPerna = pernas[pernas.length - 1]
  return Boolean(ultimaPerna && (ultimaPerna.horario_corte || String(ultimaPerna.status || '').trim().toLowerCase() === 'cortado'))
}

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
  if (!posicao || posicao.visto_ha_s === null || posicao.visto_ha_s > LIMITE_SINAL_S) return 'sem_sinal'
  if (posicao.visto_ha_s > 30) return 'atrasado'
  return 'ao_vivo'
}

export function statusOperacaoRastreio(statusBruto: string, rastreio: PosicaoAeronave | null): 'acionado' | 'em_voo' | 'em_solo' | 'aguardando' | 'encerrada' {
  const normalizado = String(statusBruto || '').trim().toLowerCase()
  if (['encerrada', 'concluida'].includes(normalizado)) return 'encerrada'
  // O sinal atual também vale quando a tripulação ainda não preencheu AC/DEP/POU.
  if (rastreio && rastreio.visto_ha_s !== null && rastreio.visto_ha_s <= 30) {
    if (!rastreio.no_solo) return 'em_voo'
    return normalizado === 'aprovada' ? 'aguardando' : 'em_solo'
  }
  if (STATUS_EM_SOLO.includes(normalizado)) return 'em_solo'
  if (normalizado === 'acionado') return 'acionado'
  return ['decolado', 'em_voo'].includes(normalizado) ? 'em_voo' : 'aguardando'
}

/** Uma aeronave não pode alimentar dois agendamentos simultaneamente. Prioriza o horário mais próximo. */
export function selecionarAgendamentosParaRastreio<T extends { id: string; aeronave_id: string | null; horario_previsto_agendamento: string | null; data_agendada: string }>(itens: T[], agora = Date.now()): T[] {
  const escolhidos = new Map<string, T>()
  const distancia = (item: T) => Math.abs(Date.parse(item.horario_previsto_agendamento || `${item.data_agendada.slice(0, 10)}T12:00:00Z`) - agora)
  for (const item of itens) {
    const chave = item.aeronave_id || item.id
    const anterior = escolhidos.get(chave)
    if (!anterior || distancia(item) < distancia(anterior)) escolhidos.set(chave, item)
  }
  return [...escolhidos.values()]
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
      p.horario_ac, p.horario_dep, p.horario_pouso, p.horario_corte,
      p.horario_ac_user_id, p.horario_dep_user_id, p.horario_pouso_user_id, p.horario_corte_user_id,
      COALESCE(NULLIF(trim(u_ac.nome_exibicao), ''), NULLIF(trim(u_ac.nome_completo), '')) AS horario_ac_usuario_nome,
      COALESCE(NULLIF(trim(u_dep.nome_exibicao), ''), NULLIF(trim(u_dep.nome_completo), '')) AS horario_dep_usuario_nome,
      COALESCE(NULLIF(trim(u_pou.nome_exibicao), ''), NULLIF(trim(u_pou.nome_completo), '')) AS horario_pouso_usuario_nome,
      COALESCE(NULLIF(trim(u_cor.nome_exibicao), ''), NULLIF(trim(u_cor.nome_completo), '')) AS horario_corte_usuario_nome
    FROM jornadas_voo j
    JOIN pernas_jornada_voo p ON p.jornada_id = j.id
    LEFT JOIN user_profiles u_ac ON u_ac.id = p.horario_ac_user_id
    LEFT JOIN user_profiles u_dep ON u_dep.id = p.horario_dep_user_id
    LEFT JOIN user_profiles u_pou ON u_pou.id = p.horario_pouso_user_id
    LEFT JOIN user_profiles u_cor ON u_cor.id = p.horario_corte_user_id
    WHERE j.jornada_principal_id IS NULL AND j.solicitacao_id IN (${solicitacaoIds.map(() => '?').join(', ')})
    ORDER BY j.solicitacao_id, j.numero_jornada, p.numero`).bind(...solicitacaoIds).all<any>()
  for (const row of rows.results || []) {
    const lista = porSolicitacao.get(row.solicitacao_id) || []
    lista.push({
      id: row.id, numero: row.numero, jornada_numero: row.numero_jornada,
      origem: icao(row.origem), destino: icao(row.destino), status: String(row.status || 'programada'),
      horario_ac: row.horario_ac || null, horario_dep: row.horario_dep || null,
      horario_pouso: row.horario_pouso || null, horario_corte: row.horario_corte || null,
      horario_ac_user_id: row.horario_ac_user_id || null, horario_dep_user_id: row.horario_dep_user_id || null,
      horario_pouso_user_id: row.horario_pouso_user_id || null, horario_corte_user_id: row.horario_corte_user_id || null,
      horario_ac_usuario_nome: row.horario_ac_usuario_nome || null, horario_dep_usuario_nome: row.horario_dep_usuario_nome || null,
      horario_pouso_usuario_nome: row.horario_pouso_usuario_nome || null, horario_corte_usuario_nome: row.horario_corte_usuario_nome || null,
    })
    porSolicitacao.set(row.solicitacao_id, lista)
  }
  return porSolicitacao
}

export async function carregarVoosRastreio(env: RastreioBindings, solicitacaoId?: string) {
  configurarProvedor(env.ADSB_PROVIDER)
  const db = env.SHARE_DB
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
      s.origem, s.destino, s.data_agendada, s.horario_previsto_agendamento, a.matricula_registro, a.modelo, ${colunaIcaoHex},
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
    WHERE ${solicitacaoId ? 's.id = ?' : `
      s.excluida_em IS NULL
      AND s.status_calc IN ('aprovada', 'decolado', 'acionado', 'em_solo', 'em solo', 'pousado')
      AND date(s.data_agendada) <= date('now')
      AND date(s.data_agendada, '+' || max(COALESCE(s.dias_duracao, 1), 1) || ' days') >= date('now')`}
    ORDER BY s.criado_em DESC`).bind(...(solicitacaoId ? [solicitacaoId] : [])).all<any>()

  const itens = rows.results || []

  // Pernas reais de cada operação: a perna é a referência de rota, não a solicitação
  const pernasPorSolicitacao = jornadaDisponivel
    ? await buscarPernas(db, itens.map((item) => item.id))
    : new Map<string, Omit<PernaOperacao, 'origem_coord' | 'destino_coord'>[]>()
  // Uma perna anterior cortada não encerra um voo com outra perna ainda aberta.
  // O acesso por ID continua retornando todas as pernas, mesmo após o último corte.
  const itensParaRastreio = solicitacaoId
    ? itens
    : itens.filter((item) => !vooFinalizadoPorCorte(pernasPorSolicitacao.get(item.id) || []))
  const coordenadas = await coordenadasPorIcao(db, [
    ...itensParaRastreio.flatMap((item) => [icao(item.origem), icao(item.destino)]),
    ...itensParaRastreio.flatMap((item) => (pernasPorSolicitacao.get(item.id) || []).flatMap((perna) => [perna.origem, perna.destino])),
  ])

  const emVoo = solicitacaoId ? [] : selecionarAgendamentosParaRastreio(itensParaRastreio)
  const posicoes = await buscarPosicoes({
    hex: emVoo.map((item) => item.icao_hex).filter(Boolean),
    matriculas: emVoo.map((item) => item.matricula_registro).filter(Boolean),
  })
  const porChave = new Map<string, PosicaoAeronave>()
  posicoes.forEach((item) => {
    porChave.set(item.hex.toUpperCase(), item)
    if (item.matricula) porChave.set(item.matricula.replace(/-/g, '').toUpperCase(), item)
  })
  const indisponivel = provedorIndisponivel()

  const selecionados = new Set(emVoo.map((item) => item.id))
  const voos = itensParaRastreio.map((item) => {
    const identificador = String(item.icao_hex || '').trim().toUpperCase()
    const matricula = String(item.matricula_registro || '').trim().toUpperCase()
    const rastreio = selecionados.has(item.id) ? (porChave.get(identificador) || porChave.get(matricula.replace(/-/g, '')) || null) : null
    const status = statusOperacaoRastreio(item.status_bruto, rastreio)
    const semIdentificador = !/^[0-9A-F]{6}$/.test(identificador) && !matricula

    const pernas: PernaOperacao[] = (pernasPorSolicitacao.get(item.id) || []).map((perna) => ({
      ...perna,
      origem_coord: coordenadas.get(perna.origem) ?? null,
      destino_coord: coordenadas.get(perna.destino) ?? null,
    }))
    const pernaAtual = pernas.find((perna) => !perna.horario_corte && !['cortado', 'cancelada'].includes(perna.status)) ?? pernas[pernas.length - 1] ?? null
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
  })

  const completos = []
  for (const voo of voos) {
    const anterior = await lerHistorico(db, voo.id)
    const apenasEstacionado = voo.status === 'aguardando' && voo.rastreio?.no_solo && !anterior.trilha.length
    if (!solicitacaoId && selecionados.has(voo.id) && !apenasEstacionado) {
      try {
        await registrarSinal(db, voo.id, voo.perna_atual?.id ?? voo.id, voo.rastreio, indisponivel)
      } catch (erro) {
        console.warn('[rastreio] falha ao registrar sinal', erro instanceof Error ? erro.message : erro)
      }
    }
    const historico = !solicitacaoId && selecionados.has(voo.id) && !apenasEstacionado ? await lerHistorico(db, voo.id) : anterior
    completos.push({ ...voo, trilha: historico.trilha, eventos_rastreio: historico.eventos, historico_disponivel: historico.disponivel })
  }
  return completos
}

/** Coleta independente de páginas abertas. O cron usa a mesma seleção do painel. */
export async function coletarRastreioAgendado(env: RastreioBindings) {
  await carregarVoosRastreio(env)
}

rastreioRoutes.get('/api/interno/voos-em-operacao', async (c) => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  if (!(await checkRateLimit(c, `rastreio:${clientIp(c)}`, 120))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  c.header('Cache-Control', 'private, no-store')
  const voos = await carregarVoosRastreio(c.env)
  // Reservas sem sinal nem histórico aguardam no cronograma. Perder o sinal não remove o voo acompanhado.
  return c.json({ atualizado_em: new Date().toISOString(), voos: voos.filter((voo) => voo.status !== 'aguardando' || (voo.rastreio_status === 'ao_vivo' && !voo.rastreio?.no_solo) || voo.trilha.length > 0) })
})

rastreioRoutes.get('/api/interno/solicitacoes/:id/rastreio', async (c) => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  if (!(await checkRateLimit(c, `rastreio-historico:${clientIp(c)}`, 120))) return c.json({ error: 'Limite de requisições atingido, tente novamente em instantes' }, 429)
  c.header('Cache-Control', 'private, no-store')
  const voos = await carregarVoosRastreio(c.env, c.req.param('id'))
  if (!voos.length) return c.json({ error: 'agendamento_nao_encontrado' }, 404)
  return c.json(voos[0])
})
