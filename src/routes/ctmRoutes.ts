import { Context, Hono } from 'hono'
import { extractSupabaseUserId, requireFlightOperationAccess, requireShareInternal, shareBrasilUser } from '../lib/auth'
import { validateWorkerSchema } from '../lib/schema'
import { shareBrasilFileName } from '../lib/storage'
import { uuid } from '../lib/strings'
import { getAircraftIdsInMaintenance, isActiveCTMServiceOrder } from '../lib/ctmMaintenanceStatus'
import { buscarTripulante } from './tripulacaoRoutes'

type Bindings = {
  SHARE_DB: D1Database
  SHARE_FILES?: R2Bucket
  FILES?: R2Bucket
  CACHE_KV?: KVNamespace
  RATE_LIMITER?: DurableObjectNamespace
  INTERNAL_TOKEN?: string
}

type Variables = Record<string, never>

export const ctmRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const STATUS_EDITAVEIS_FICHA_PESO = new Set([
  'aprovada', 'acionado', 'decolado', 'em_voo', 'em voo', 'em_rota', 'em rota', 'em_solo', 'pousado', 'encerrada', 'concluida',
])

export function statusPermiteEdicaoFichaPeso(status: unknown) {
  return STATUS_EDITAVEIS_FICHA_PESO.has(String(status || '').trim().toLowerCase())
}

function bucketShareBrasil(c: Context<{ Bindings: Bindings; Variables: Variables }>): R2Bucket {
  return c.env.SHARE_FILES || c.env.FILES || ({} as R2Bucket)
}

async function salvarArquivoCtm(c: Context<{ Bindings: Bindings; Variables: Variables }>, userId: string, file: File, pasta: string): Promise<string> {
  if (!file.size) throw new Error('arquivo_vazio')
  if (file.size > 25 * 1024 * 1024) throw new Error('arquivo_excede_25mb')
  const pastaNormalizada = pasta.replace(/^\/+/, '').replace(/^share\/+/, '')
  const key = `share/${pastaNormalizada}/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${shareBrasilFileName(file.name)}`
  await bucketShareBrasil(c).put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  })
  return key
}

const parseJsonOr = (value: unknown, fallback: unknown) => {
  try { return JSON.parse(String(value ?? '')) } catch { return fallback }
}

async function garantirTabelaFichaPeso(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  await validateWorkerSchema(c, [{ table: 'ctm_ficha_peso_balanceamento', columns: ['id', 'solicitacao_id', 'assinatura_nome'] }])
}

const CTM_READ_TABLES: Record<string, { table: string; order?: string }> = {
  programa: { table: 'ctm_programa_manutencao', order: 'categoria, item' },
  oas: { table: 'ctm_ordem_acompanhamento_servico', order: 'data_entrada DESC' },
  orcamentos: { table: 'ctm_orcamentos', order: 'criado_em DESC' },
  componentes: { table: 'ctm_mapa_componente', order: 'nome' },
  diretrizes: { table: 'ctm_diretrizes', order: 'data_vencimento' },
  ras: { table: 'ctm_ras', order: 'data_entrada DESC' },
  carregamentos: { table: 'ctm_carregamentos', order: 'data_voo DESC, criado_em DESC' },
}

async function ctmRead(c: Context<{ Bindings: Bindings; Variables: Variables }>, table: string, where = '', params: unknown[] = []) {
  try {
    return await c.env.SHARE_DB.prepare(`SELECT * FROM ${table}${where}`).bind(...params).all<any>()
  } catch (error) {
    console.error(`[ctm] leitura falhou em ${table}`, error)
    return { results: [] as any[] }
  }
}

ctmRoutes.get('/api/ctm/aeronave', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const rows = await ctmRead(c, 'aeronave', " WHERE lower(COALESCE(status,'ativa')) NOT IN ('inativa','cancelada') ORDER BY matricula_registro")
  return c.json({ data: rows.results })
})

ctmRoutes.get('/api/ctm/dashboard', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = String(c.req.query('aeronave_id') || '').trim()
  const aeronave = await ctmRead(c, 'aeronave', " WHERE lower(COALESCE(status,'ativa')) NOT IN ('inativa','cancelada') ORDER BY matricula_registro")
  const selecionada = (aeronave.results || []).find((item: any) => String(item.id) === aeronaveId) || (aeronave.results || [])[0] || null
  const id = selecionada?.id
  const filtro = id ? ' WHERE aeronave_id = ?' : ' WHERE 1 = 0'
  const [programa, diretrizes, componentes, oas, orcamentos, ras, carregamentos] = await Promise.all([
    ctmRead(c, 'ctm_programa_manutencao', `${filtro} ORDER BY categoria, item`, id ? [id] : []),
    ctmRead(c, 'ctm_diretrizes', `${filtro} ORDER BY data_vencimento`, id ? [id] : []),
    ctmRead(c, 'ctm_mapa_componente', `${filtro} ORDER BY nome`, id ? [id] : []),
    ctmRead(c, 'ctm_ordem_acompanhamento_servico', `${filtro} ORDER BY data_entrada DESC`, id ? [id] : []),
    ctmRead(c, 'ctm_orcamentos', `${filtro} ORDER BY criado_em DESC`, id ? [id] : []),
    ctmRead(c, 'ctm_ras', `${filtro} ORDER BY data_entrada DESC`, id ? [id] : []),
    ctmRead(c, 'ctm_carregamentos', `${filtro} ORDER BY data_voo DESC`, id ? [id] : []),
  ])
  const totalOrcamento = (orcamentos.results || []).reduce((total: number, item: any) => total + Number(item.total || item.valor_total || 0), 0)
  return c.json({ data: { aeronaves: aeronave.results, aeronave: selecionada, programa: programa.results, diretrizes: diretrizes.results, componentes: componentes.results, oas: oas.results, orcamentos: orcamentos.results, ras: ras.results, carregamentos: carregamentos.results, resumo: { itens_manutencao: programa.results.length, proximos_vencimentos: programa.results.filter((item: any) => String(item.status || '').toLowerCase() !== 'concluido').length, diretrizes_pendentes: diretrizes.results.filter((item: any) => !['complied', 'concluido', 'conforme'].includes(String(item.status || '').toLowerCase())).length, componentes_atencao: componentes.results.filter((item: any) => !['ok', 'regular'].includes(String(item.status || '').toLowerCase())).length, ordens_abertas: oas.results.filter((item: any) => isActiveCTMServiceOrder(item.status)).length, orcamento_total: totalOrcamento } } })
})

ctmRoutes.get('/api/ctm/relatorios-manutencao', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = String(c.req.query('aeronave_id') || '').trim()
  const filtro = aeronaveId
    ? " WHERE r.aeronave_id = ? AND r.aeronave_id IN (SELECT id FROM aeronave WHERE lower(COALESCE(status, 'ativa')) LIKE 'ativ%')"
    : " WHERE r.aeronave_id IN (SELECT id FROM aeronave WHERE lower(COALESCE(status, 'ativa')) LIKE 'ativ%')"
  const params = aeronaveId ? [aeronaveId] : []
  const [reports, mobileReports, aircraft, orders] = await Promise.all([
    ctmRead(c, 'relatorios_manutencao r', `${filtro} ORDER BY date(r.data_relatorio) DESC, r.id DESC`, params),
    ctmRead(c, 'ctm_reports_mobile r', `${filtro} ORDER BY date(r.data_relatorio) DESC, r.id DESC`, params),
    ctmRead(c, 'aeronave', " WHERE lower(COALESCE(status, 'ativa')) LIKE 'ativ%' ORDER BY matricula_registro"),
    ctmRead(c, 'ctm_ordem_acompanhamento_servico', " WHERE aeronave_id IN (SELECT id FROM aeronave WHERE lower(COALESCE(status, 'ativa')) LIKE 'ativ%') ORDER BY data_entrada DESC"),
  ])
  const aircraftInMaintenance = getAircraftIdsInMaintenance(orders.results || [])
  const aeronaves = aircraft.results.map((item: any) => ({
    id: item.id,
    registration: item.matricula_registro,
    model: item.modelo,
    image_url: item.url_imagem || null,
    in_maintenance: aircraftInMaintenance.has(String(item.id)),
  }))
  const aeronavesPorId = new Map(aeronaves.map((item: any) => [String(item.id), item]))
  const data = [...(reports.results || []), ...(mobileReports.results || [])].map((report: any) => ({
    ...report,
    aircraft: aeronavesPorId.get(String(report.aeronave_id)),
    aircraft_id: report.aeronave_id,
    report_date: report.data_relatorio,
    description: report.descricao || report.observacoes || report.description || '',
    reported_by: report.criado_por || report.mecanico_responsavel || report.responsavel_tecnico || null,
    reporter: report.criado_por_nome ? { full_name: report.criado_por_nome } : undefined,
    severity: report.severidade || report.severity || 'medium',
    status: report.status || 'open',
    corrective_action: report.acao_corretiva || report.corrective_action || null,
  })).sort((a: any, b: any) => String(b.report_date).localeCompare(String(a.report_date)))
  return c.json({ data, aeronaves })
})

ctmRoutes.post('/api/ctm/relatorios-manutencao', async c => {
  // Criação vinculada à identidade autenticada, nunca ao "reported_by" enviado pelo cliente.
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)

  let payload: Record<string, unknown>
  try {
    payload = await c.req.json<Record<string, unknown>>()
  } catch {
    return c.json({ error: 'json_invalido' }, 400)
  }
  const aeronaveId = String(payload?.aeronave_id || '').trim()
  const descricao = String(payload?.descricao || '').trim()
  const severidade = String(payload?.severidade || 'medium').trim().toLowerCase()
  const dataRelatorio = String(payload?.data_relatorio || new Date().toISOString().slice(0, 10)).trim()
  if (!aeronaveId || !descricao || descricao.length > 5000) return c.json({ error: 'Informe aeronave e descrição (máximo de 5000 caracteres).' }, 400)
  if (!['low', 'medium', 'high', 'critical'].includes(severidade)) return c.json({ error: 'severidade_invalida' }, 400)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataRelatorio) || Number.isNaN(Date.parse(dataRelatorio)) ||
      new Date(dataRelatorio + 'T12:00:00Z').toISOString().slice(0, 10) !== dataRelatorio) {
    return c.json({ error: 'data_relatorio_invalida' }, 400)
  }

  const aeronave = await c.env.SHARE_DB.prepare(
    "SELECT id FROM aeronave WHERE id = ? AND lower(COALESCE(status, 'ativa')) LIKE 'ativ%' LIMIT 1",
  ).bind(aeronaveId).first<{ id: string }>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada_ou_inativa' }, 404)

  const id = uuid()
  const nome = user.nome_completo || user.nome_exibicao || user.email || 'Colaborador'
  try {
    await c.env.SHARE_DB.prepare(
      'INSERT INTO ctm_reports_mobile (id, aeronave_id, data_relatorio, descricao, severidade, status, criado_por, criado_por_nome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, aeronaveId, dataRelatorio, descricao, severidade, 'open', user.id, nome).run()
  } catch (error) {
    console.error('[ctm] falha ao gravar report no D1', error)
    return c.json({ error: 'falha_ao_salvar_report_verifique_migracao_d1' }, 503)
  }
  return c.json({
    data: {
      id, aircraft_id: aeronaveId, report_date: dataRelatorio,
      description: descricao, severity: severidade, status: 'open',
      reported_by: user.id, reporter: { full_name: nome },
    },
  }, 201)
})

for (const [slug, config] of Object.entries(CTM_READ_TABLES)) {
  ctmRoutes.get(`/api/ctm/${slug}`, async c => {
    if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
    const aeronaveId = String(c.req.query('aeronave_id') || '').trim()
    const where = aeronaveId ? ` WHERE aeronave_id = ? ORDER BY ${config.order || 'id'}` : ` ORDER BY ${config.order || 'id'}`
    const rows = await ctmRead(c, config.table, where, aeronaveId ? [aeronaveId] : [])
    return c.json({ data: rows.results })
  })
}

ctmRoutes.get('/api/ctm/peso-balanceamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const aeronaveId = c.req.query('aeronave_id')
  const query = aeronaveId
    ? `SELECT p.*, a.matricula_registro, a.fabricante, a.modelo, a.numero_serie
       FROM ctm_peso_balanceamento p LEFT JOIN aeronave a ON a.id = p.aeronave_id
       WHERE p.aeronave_id = ?1 ORDER BY p.atualizado_em DESC`
    : `SELECT p.*, a.matricula_registro, a.fabricante, a.modelo, a.numero_serie
       FROM ctm_peso_balanceamento p LEFT JOIN aeronave a ON a.id = p.aeronave_id
       ORDER BY p.atualizado_em DESC`
  const rows = await c.env.SHARE_DB.prepare(query).bind(...(aeronaveId ? [aeronaveId] : [])).all<any>()
  return c.json({ configuracoes: rows.results || [] })
})

ctmRoutes.post('/api/ctm/peso-balanceamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const aeronaveId = String(body.aeronave_id || '').trim()
  if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  const numero = (value: unknown, fallback: number | null = null) => value === '' || value === undefined || value === null ? fallback : Number(value)
  const atual = await c.env.SHARE_DB.prepare('SELECT id FROM ctm_peso_balanceamento WHERE aeronave_id = ?1').bind(aeronaveId).first<any>()
  const id = atual?.id || crypto.randomUUID()
  const valores = [
    numero(body.peso_vazio_padrao, 0), numero(body.braco_cg_padrao, 0), numero(body.momento_padrao),
    numero(body.peso_maximo_decolagem, 0), numero(body.peso_maximo_pouso, 0), numero(body.peso_maximo_sem_combustivel),
    numero(body.cg_limite_dianteiro, 0), numero(body.cg_limite_traseiro, 0), numero(body.mac_comprimento, 0), numero(body.lemac_distancia, 0),
    numero(body.capacidade_combustivel_total), numero(body.capacidade_combustivel_util), body.validado ? 1 : 0,
    body.notas?.toString().trim() || null, body.data_ultima_pesagem || null, body.numero_relatorio_pesagem?.toString().trim() || null,
    body.responsavel_tecnico?.toString().trim() || null, numero(body.limite_bagagem_diant_kg), numero(body.limite_bagagem_tras_kg), user.id,
  ]
  if (atual) {
    await c.env.SHARE_DB.prepare(`UPDATE ctm_peso_balanceamento SET peso_vazio_padrao=?, braco_cg_padrao=?, momento_padrao=?, peso_maximo_decolagem=?, peso_maximo_pouso=?, peso_maximo_sem_combustivel=?, cg_limite_dianteiro=?, cg_limite_traseiro=?, mac_comprimento=?, lemac_distancia=?, capacidade_combustivel_total=?, capacidade_combustivel_util=?, validado=?, notas=?, data_ultima_pesagem=?, numero_relatorio_pesagem=?, responsavel_tecnico=?, limite_bagagem_diant_kg=?, limite_bagagem_tras_kg=?, atualizado_em=CURRENT_TIMESTAMP, criado_por=? WHERE id=?`).bind(...valores, id).run()
  } else {
    await c.env.SHARE_DB.prepare(`INSERT INTO ctm_peso_balanceamento (peso_vazio_padrao, braco_cg_padrao, momento_padrao, peso_maximo_decolagem, peso_maximo_pouso, peso_maximo_sem_combustivel, cg_limite_dianteiro, cg_limite_traseiro, mac_comprimento, lemac_distancia, capacidade_combustivel_total, capacidade_combustivel_util, validado, notas, data_ultima_pesagem, numero_relatorio_pesagem, responsavel_tecnico, limite_bagagem_diant_kg, limite_bagagem_tras_kg, criado_por, aeronave_id, id) VALUES (${new Array(22).fill('?').join(', ')})`).bind(...valores, aeronaveId, id).run()
  }
  const configuracao = await c.env.SHARE_DB.prepare('SELECT p.*, a.matricula_registro, a.fabricante, a.modelo, a.numero_serie FROM ctm_peso_balanceamento p LEFT JOIN aeronave a ON a.id=p.aeronave_id WHERE p.id=?1').bind(id).first<any>()
  return c.json({ configuracao }, atual ? 200 : 201)
})

ctmRoutes.get('/api/ctm/fichas-peso-balanceamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const rows = await c.env.SHARE_DB.prepare(`SELECT f.*, a.matricula_registro, a.modelo, s.origem, s.destino, s.data_agendada
    FROM ctm_ficha_peso_balanceamento f LEFT JOIN aeronave a ON a.id=f.aeronave_id
    LEFT JOIN solicitacoes_reserva_voo s ON s.id=f.solicitacao_id ORDER BY COALESCE(f.data_voo, f.criado_em) DESC`).all<any>()
  return c.json({ fichas: (rows.results || []).map((f: any) => ({ ...f, itens_carregamento: parseJsonOr(f.itens_carregamento, []), snapshot_limites: parseJsonOr(f.snapshot_limites, {}) })) })
})

ctmRoutes.get('/api/interno/agendamento/:id/peso-balanceamento', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaFichaPeso(c)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const reserva = await db.prepare(`SELECT s.id, s.aeronave_id, s.numero_voo, s.data_agendada, s.origem, s.destino, s.numero_passageiros, s.piloto_id, s.copiloto_id,
      a.matricula_registro, a.modelo, a.fabricante
    FROM solicitacoes_reserva_voo s LEFT JOIN aeronave a ON a.id = s.aeronave_id WHERE s.id = ?1`).bind(id).first<any>()
  if (!reserva) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  const [piloto, copiloto, config, ficha] = await Promise.all([
    reserva.piloto_id ? buscarTripulante(c, reserva.piloto_id) : null,
    reserva.copiloto_id ? buscarTripulante(c, reserva.copiloto_id) : null,
    db.prepare('SELECT * FROM ctm_peso_balanceamento WHERE aeronave_id = ?1 ORDER BY atualizado_em DESC LIMIT 1').bind(reserva.aeronave_id).first<any>().catch(() => null),
    db.prepare('SELECT * FROM ctm_ficha_peso_balanceamento WHERE solicitacao_id = ?1 ORDER BY criado_em DESC LIMIT 1').bind(id).first<any>(),
  ])
  return c.json({
    solicitacao: reserva,
    piloto: piloto ? { id: piloto.id, nome: piloto.nome_completo, canac: (piloto as any).canac ?? null } : null,
    copiloto: copiloto ? { id: copiloto.id, nome: copiloto.nome_completo, canac: (copiloto as any).canac ?? null } : null,
    configuracao: config || null,
    ficha: ficha ? { ...ficha, itens_carregamento: parseJsonOr(ficha.itens_carregamento, []), snapshot_limites: parseJsonOr(ficha.snapshot_limites, {}) } : null,
  })
})

ctmRoutes.post('/api/interno/agendamento/:id/peso-balanceamento', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaFichaPeso(c)
  const db = c.env.SHARE_DB
  const solicitacaoId = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  if (!body) return c.json({ error: 'payload_invalido' }, 400)
  const reserva = await db.prepare('SELECT id, aeronave_id, numero_voo, data_agendada, status FROM solicitacoes_reserva_voo WHERE id = ?1').bind(solicitacaoId).first<any>()
  if (!reserva) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (!statusPermiteEdicaoFichaPeso(reserva.status)) return c.json({ error: 'ficha_fora_da_preparacao', detail: 'A ficha pode ser preenchida somente para voos aprovados, em operação ou encerrados.' }, 409)
  const piloto = String(body.piloto_responsavel || '').trim()
  if (!piloto) return c.json({ error: 'piloto_responsavel_obrigatorio' }, 400)
  const itens = Array.isArray(body.itens_carregamento) ? body.itens_carregamento : []
  const num = (valor: unknown) => (valor === null || valor === undefined || valor === '' ? null : Number(valor))
  const status = body.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO'
  const existente = await db.prepare('SELECT id, status FROM ctm_ficha_peso_balanceamento WHERE solicitacao_id = ?1 ORDER BY criado_em DESC LIMIT 1').bind(solicitacaoId).first<any>()
  if (existente?.status === 'FINALIZADA') return c.json({ error: 'ficha_ja_finalizada', id: existente.id }, 409)
  let finalizacao: { configuracao: any; pesoVazio: number; momentoVazio: number; fuelKg: number; fuelArm: number; fuelMomento: number; pesoTotal: number; momentoTotal: number; cg: number; pousoPrevisto: number; cgPouso: number } | null = null
  let loadItemsForSave: any[] = []
  if (status === 'FINALIZADA') {
    const configuracao = await db.prepare('SELECT * FROM ctm_peso_balanceamento WHERE aeronave_id = ?1 ORDER BY atualizado_em DESC LIMIT 1').bind(reserva.aeronave_id).first<any>()
    if (!configuracao || !(configuracao.validado === true || Number(configuracao.validado) === 1)) return c.json({ error: 'configuracao_peso_nao_validada', detail: 'A aeronave precisa ter uma configuração técnica de peso e balanceamento validada.' }, 409)
    if (body.peso_balanceamento_id && body.peso_balanceamento_id !== configuracao.id) return c.json({ error: 'configuracao_aeronave_invalida' }, 400)
    const loadItems = itens.filter((item: any) => String(item?.categoria || '').toLowerCase() !== 'combustivel' && String(item?.descricao || '').trim().toLowerCase() !== 'combustível')
    if (!loadItems.length || loadItems.some((item: any) => !String(item?.descricao || '').trim() || !Number.isFinite(Number(item?.peso_kg ?? item?.peso)) || Number(item?.peso_kg ?? item?.peso) <= 0 || !Number.isFinite(Number(item?.braco)) || Number(item?.braco) === 0)) return c.json({ error: 'itens_carregamento_invalidos', detail: 'Informe descrição, peso positivo e braço válido para cada passageiro ou item carregado.' }, 400)
    const pesoVazio = Number(configuracao.peso_vazio_padrao)
    const momentoVazio = Number(configuracao.momento_padrao) || pesoVazio * Number(configuracao.braco_cg_padrao)
    const fuelKg = Number(body.fuel_kg)
    const fuelLitros = Number(body.fuel_litros)
    const fuelArm = Number(body.fuel_braco)
    const rawPlannedFuelBurn = body.snapshot_limites?.consumo_estimado_combustivel_kg
    if (rawPlannedFuelBurn === null || rawPlannedFuelBurn === undefined || String(rawPlannedFuelBurn).trim() === '') return c.json({ error: 'consumo_previsto_obrigatorio', detail: 'Informe o consumo estimado de combustível até o pouso.' }, 400)
    const plannedFuelBurn = Number(rawPlannedFuelBurn)
    if (![pesoVazio, momentoVazio, fuelKg, fuelLitros, fuelArm, plannedFuelBurn].every(Number.isFinite) || pesoVazio <= 0 || fuelKg <= 0 || fuelLitros <= 0 || fuelArm === 0 || plannedFuelBurn < 0 || plannedFuelBurn > fuelKg) return c.json({ error: 'dados_peso_combustivel_invalidos', detail: 'Revise peso vazio, combustível, braço e consumo previsto até o pouso.' }, 400)
    const cargaPeso = loadItems.reduce((total: number, item: any) => total + Number(item.peso_kg ?? item.peso), 0)
    const cargaMomento = loadItems.reduce((total: number, item: any) => total + Number(item.peso_kg ?? item.peso) * Number(item.braco), 0)
    const fuelMomento = fuelKg * fuelArm
    const pesoTotal = pesoVazio + cargaPeso + fuelKg
    const momentoTotal = momentoVazio + cargaMomento + fuelMomento
    const mac = Number(configuracao.mac_comprimento)
    const cg = mac > 0 ? ((momentoTotal / pesoTotal - Number(configuracao.lemac_distancia)) / mac) * 100 : Number.NaN
    const pousoPrevisto = pesoTotal - plannedFuelBurn
    const cgPouso = pousoPrevisto > 0 && mac > 0 ? (((momentoTotal - plannedFuelBurn * fuelArm) / pousoPrevisto - Number(configuracao.lemac_distancia)) / mac) * 100 : Number.NaN
    const limitesValidos = [configuracao.peso_maximo_decolagem, configuracao.peso_maximo_pouso, configuracao.peso_maximo_sem_combustivel, configuracao.cg_limite_dianteiro, configuracao.cg_limite_traseiro, mac, configuracao.lemac_distancia].every((value) => Number.isFinite(Number(value))) && Number(configuracao.peso_maximo_decolagem) > 0 && Number(configuracao.peso_maximo_pouso) > 0 && Number(configuracao.peso_maximo_sem_combustivel) > 0 && mac > 0 && Number(configuracao.cg_limite_traseiro) > Number(configuracao.cg_limite_dianteiro)
    if (!limitesValidos) return c.json({ error: 'limites_peso_nao_configurados', detail: 'A configuração aprovada não contém todos os limites necessários para finalizar a ficha.' }, 409)
    const cgDentroDosLimites = cg >= Number(configuracao.cg_limite_dianteiro) && cg <= Number(configuracao.cg_limite_traseiro) && cgPouso >= Number(configuracao.cg_limite_dianteiro) && cgPouso <= Number(configuracao.cg_limite_traseiro)
    const dentroDosLimites = pesoTotal <= Number(configuracao.peso_maximo_decolagem) && pousoPrevisto <= Number(configuracao.peso_maximo_pouso) && pousoPrevisto >= 0 && pesoTotal - fuelKg <= Number(configuracao.peso_maximo_sem_combustivel) && cgDentroDosLimites
    if (!Number.isFinite(cg) || !Number.isFinite(cgPouso) || !dentroDosLimites) return c.json({ error: 'ficha_fora_dos_limites', detail: 'O peso de decolagem/pouso, peso sem combustível ou CG previsto na decolagem/pouso excede os limites técnicos aprovados.' }, 422)
    loadItemsForSave = loadItems
    finalizacao = { configuracao, pesoVazio, momentoVazio, fuelKg, fuelArm, fuelMomento, pesoTotal, momentoTotal, cg, pousoPrevisto, cgPouso }
  }
  const id = existente?.id || crypto.randomUUID()
  const config = finalizacao?.configuracao
  const snapshotLimites = finalizacao ? { ...body.snapshot_limites, pouso_previsto_kg: finalizacao.pousoPrevisto, cg_previsto_pouso: finalizacao.cgPouso, consumo_estimado_combustivel_kg: Number(body.snapshot_limites?.consumo_estimado_combustivel_kg ?? 0), peso_maximo_decolagem: config.peso_maximo_decolagem, peso_maximo_pouso: config.peso_maximo_pouso, peso_maximo_sem_combustivel: config.peso_maximo_sem_combustivel, cg_limite_dianteiro: config.cg_limite_dianteiro, cg_limite_traseiro: config.cg_limite_traseiro } : body.snapshot_limites || {}
  const itensPersistidos = finalizacao ? [...loadItemsForSave, { descricao: 'Combustível', categoria: 'combustivel', peso_kg: finalizacao.fuelKg, braco: finalizacao.fuelArm, momento: finalizacao.fuelMomento, litros: Number(body.fuel_litros) }] : itens
  const valores = [
    reserva.aeronave_id, String(config?.id || body.peso_balanceamento_id || ''), String(body.data_voo || reserva.data_agendada),
    body.numero_voo ?? reserva.numero_voo ?? null, piloto, finalizacao?.pesoVazio ?? Number(body.peso_vazio_kg || 0), finalizacao ? Number(config.braco_cg_padrao) : num(body.braco_vazio), finalizacao?.momentoVazio ?? num(body.momento_vazio),
    JSON.stringify(itensPersistidos), num(body.fuel_litros), finalizacao?.fuelKg ?? num(body.fuel_kg), finalizacao?.fuelArm ?? num(body.fuel_braco), finalizacao?.fuelMomento ?? num(body.fuel_momento), finalizacao?.pesoTotal ?? num(body.peso_total_kg), finalizacao?.momentoTotal ?? num(body.momento_total), finalizacao?.cg ?? num(body.cg_calculado),
    finalizacao ? config.peso_maximo_decolagem : num(body.peso_maximo_decolagem), finalizacao ? config.peso_maximo_pouso : num(body.peso_maximo_pouso), finalizacao ? config.peso_maximo_sem_combustivel : num(body.peso_maximo_sem_combustivel), finalizacao ? config.cg_limite_dianteiro : num(body.cg_limite_dianteiro), finalizacao ? config.cg_limite_traseiro : num(body.cg_limite_traseiro),
    finalizacao ? 1 : body.dentro_dos_limites ? 1 : 0, status, JSON.stringify(snapshotLimites), body.observacoes?.toString().trim() || null,
    solicitacaoId, body.assinatura_nome?.toString().trim() || piloto, status === 'FINALIZADA' ? new Date().toISOString() : null,
  ]
  if (existente) {
    await db.prepare(`UPDATE ctm_ficha_peso_balanceamento SET aeronave_id = ?, peso_balanceamento_id = ?, data_voo = ?, numero_voo = ?, piloto_responsavel = ?,
      peso_vazio_kg = ?, braco_vazio = ?, momento_vazio = ?, itens_carregamento = ?, fuel_litros = ?, fuel_kg = ?, fuel_braco = ?, fuel_momento = ?,
      peso_total_kg = ?, momento_total = ?, cg_calculado = ?, peso_maximo_decolagem = ?, peso_maximo_pouso = ?, peso_maximo_sem_combustivel = ?,
      cg_limite_dianteiro = ?, cg_limite_traseiro = ?, dentro_dos_limites = ?, status = ?, snapshot_limites = ?, observacoes = ?, solicitacao_id = ?,
      assinatura_nome = ?, finalizado_em = ? WHERE id = ?`).bind(...valores, id).run()
  } else {
    await db.prepare(`INSERT INTO ctm_ficha_peso_balanceamento (aeronave_id, peso_balanceamento_id, data_voo, numero_voo, piloto_responsavel,
      peso_vazio_kg, braco_vazio, momento_vazio, itens_carregamento, fuel_litros, fuel_kg, fuel_braco, fuel_momento,
      peso_total_kg, momento_total, cg_calculado, peso_maximo_decolagem, peso_maximo_pouso, peso_maximo_sem_combustivel,
      cg_limite_dianteiro, cg_limite_traseiro, dentro_dos_limites, status, snapshot_limites, observacoes, solicitacao_id,
      assinatura_nome, finalizado_em, id) VALUES (${new Array(29).fill('?').join(', ')})`).bind(...valores, id).run()
  }
  const ficha = await db.prepare('SELECT * FROM ctm_ficha_peso_balanceamento WHERE id = ?1').bind(id).first<any>()
  return c.json({ success: true, ficha: { ...ficha, itens_carregamento: parseJsonOr(ficha?.itens_carregamento, []), snapshot_limites: parseJsonOr(ficha?.snapshot_limites, {}) } }, existente ? 200 : 201)
})

const CTM_MIMES_DOCUMENTOS = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function ctmTipoArquivoDocumento(file: File): string | null {
  const type = String(file.type || '').toLowerCase()
  if (CTM_MIMES_DOCUMENTOS.has(type)) return type
  const extensao = file.name.toLowerCase().split('.').pop()
  const porExtensao: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
  return porExtensao[extensao || ''] || null
}

function ctmDataDocumento(value: unknown): string | null | undefined {
  const raw = String(value ?? '').trim().slice(0, 10)
  if (!raw) return null
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!partes) return undefined
  const [ano, mes, dia] = partes.slice(1).map(Number)
  const data = new Date(Date.UTC(ano, mes - 1, dia))
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return undefined
  return raw
}

function ctmDiasAlerta(value: unknown): number | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const dias = Number(raw)
  return Number.isInteger(dias) && dias >= 0 && dias <= 3650 ? dias : null
}

function ctmNomeDocumento(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim().slice(0, 180)
}

ctmRoutes.get('/api/ctm/aeronaves/:aeronaveId/documentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = c.req.param('aeronaveId')
  const existe = await c.env.SHARE_DB.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first()
  if (!existe) return c.notFound()
  const rows = await c.env.SHARE_DB.prepare(`SELECT id, nome, descricao, tipo_arquivo, tamanho_arquivo, enviado_por, criado_em, aeronave_id, tipo_documento, data_validade, atualizado_em, dias_alerta
    FROM documentos_aeronave WHERE aeronave_id = ?1
    ORDER BY CASE WHEN data_validade IS NULL OR trim(data_validade) = '' THEN 1 ELSE 0 END, date(data_validade), lower(nome)`).bind(aeronaveId).all()
  return c.json({ documentos: rows.results.map((row: any) => ({ ...row, arquivo_url: `/api/ctm/aeronaves/${encodeURIComponent(aeronaveId)}/documentos/${encodeURIComponent(String(row.id))}/arquivo` })) })
})

ctmRoutes.post('/api/ctm/aeronaves/:aeronaveId/documentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = c.req.param('aeronaveId')
  const existe = await c.env.SHARE_DB.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first()
  if (!existe) return c.notFound()
  const form = await c.req.formData().catch((): FormData | null => null)
  if (!form) return c.json({ error: 'formulario_invalido' }, 400)
  const arquivoValor = form.get('arquivo') as unknown
  if (!arquivoValor || typeof arquivoValor !== 'object' || !('size' in arquivoValor) || Number(arquivoValor.size) <= 0) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const arquivo = arquivoValor as File
  if (arquivo.size > 25 * 1024 * 1024) return c.json({ error: 'arquivo_excede_25mb' }, 413)
  const tipoArquivo = ctmTipoArquivoDocumento(arquivo)
  if (!tipoArquivo) return c.json({ error: 'somente_pdf_ou_imagem_jpg_png_webp_gif_permitidos' }, 415)
  const nome = ctmNomeDocumento(form.get('nome'), arquivo.name.replace(/\.[^.]+$/, ''))
  if (!nome) return c.json({ error: 'nome_obrigatorio' }, 400)
  const descricao = String(form.get('descricao') || '').trim()
  if (descricao.length > 2000) return c.json({ error: 'descricao_excede_limite' }, 400)
  const tipoDocumento = String(form.get('tipo_documento') || 'outro').trim().slice(0, 100) || 'outro'
  const dataValidade = ctmDataDocumento(form.get('data_validade'))
  if (dataValidade === undefined) return c.json({ error: 'data_validade_invalida' }, 400)
  const diasAlerta = form.has('dias_alerta') ? ctmDiasAlerta(form.get('dias_alerta')) : 30
  if (diasAlerta === null) return c.json({ error: 'dias_alerta_invalido' }, 400)
  const userId = extractSupabaseUserId(c) || 'interno'
  const arquivoComTipo = new File([arquivo], arquivo.name, { type: tipoArquivo })
  let caminho: string | null = null
  try {
    caminho = await salvarArquivoCtm(c, userId, arquivoComTipo, `ctm/documentos_aeronaves/${aeronaveId}`)
    const id = uuid()
    await c.env.SHARE_DB.prepare(`INSERT INTO documentos_aeronave
      (id, nome, descricao, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, aeronave_id, tipo_documento, data_validade, dias_alerta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, nome, descricao || null, caminho, tipoArquivo, arquivo.size, userId, aeronaveId, tipoDocumento, dataValidade, diasAlerta).run()
    const row = await c.env.SHARE_DB.prepare(`SELECT id, nome, descricao, tipo_arquivo, tamanho_arquivo, enviado_por, criado_em, aeronave_id, tipo_documento, data_validade, atualizado_em, dias_alerta
      FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2`).bind(id, aeronaveId).first<any>()
    return c.json({ documento: { ...row, arquivo_url: `/api/ctm/aeronaves/${encodeURIComponent(aeronaveId)}/documentos/${encodeURIComponent(id)}/arquivo` } }, 201)
  } catch (error) {
    if (caminho) await bucketShareBrasil(c).delete(caminho).catch(() => undefined)
    console.error('[ctm/documentos-aeronave] upload falhou', error)
    return c.json({ error: 'falha_ao_salvar_documento_aeronave' }, 500)
  }
})

ctmRoutes.patch('/api/ctm/aeronaves/:aeronaveId/documentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = c.req.param('aeronaveId')
  const id = c.req.param('id')
  const db = c.env.SHARE_DB
  const atual = await db.prepare('SELECT id, nome, descricao, tipo_documento, data_validade, dias_alerta FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2').bind(id, aeronaveId).first<any>()
  if (!atual) return c.notFound()
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const nome = body.nome === undefined ? String(atual.nome || '') : ctmNomeDocumento(body.nome)
  if (!nome) return c.json({ error: 'nome_obrigatorio' }, 400)
  const descricao = body.descricao === undefined ? atual.descricao : String(body.descricao || '').trim() || null
  if (descricao && String(descricao).length > 2000) return c.json({ error: 'descricao_excede_limite' }, 400)
  const tipoDocumento = body.tipo_documento === undefined ? atual.tipo_documento : String(body.tipo_documento || 'outro').trim().slice(0, 100) || 'outro'
  const dataValidade = ctmDataDocumento(body.data_validade === undefined ? atual.data_validade : body.data_validade)
  if (dataValidade === undefined) return c.json({ error: 'data_validade_invalida' }, 400)
  const diasAlerta = body.dias_alerta === undefined ? Number(atual.dias_alerta ?? 30) : ctmDiasAlerta(body.dias_alerta)
  if (!Number.isInteger(diasAlerta) || Number(diasAlerta) < 0 || Number(diasAlerta) > 3650) return c.json({ error: 'dias_alerta_invalido' }, 400)
  await db.prepare(`UPDATE documentos_aeronave SET nome = ?, descricao = ?, tipo_documento = ?, data_validade = ?, dias_alerta = ?, atualizado_em = datetime('now')
    WHERE id = ? AND aeronave_id = ?`).bind(nome, descricao, tipoDocumento, dataValidade, diasAlerta, id, aeronaveId).run()
  const documento = await db.prepare(`SELECT id, nome, descricao, tipo_arquivo, tamanho_arquivo, enviado_por, criado_em, aeronave_id, tipo_documento, data_validade, atualizado_em, dias_alerta
    FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2`).bind(id, aeronaveId).first<any>()
  return c.json({ documento: { ...documento, arquivo_url: `/api/ctm/aeronaves/${encodeURIComponent(aeronaveId)}/documentos/${encodeURIComponent(id)}/arquivo` }, success: true })
})

ctmRoutes.delete('/api/ctm/aeronaves/:aeronaveId/documentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = c.req.param('aeronaveId')
  const id = c.req.param('id')
  const db = c.env.SHARE_DB
  const atual = await db.prepare('SELECT caminho_arquivo FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2').bind(id, aeronaveId).first<{ caminho_arquivo: string }>()
  if (!atual) return c.notFound()
  await db.prepare('DELETE FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2').bind(id, aeronaveId).run()
  await bucketShareBrasil(c).delete(atual.caminho_arquivo).catch(() => undefined)
  return c.json({ success: true })
})

ctmRoutes.get('/api/ctm/aeronaves/:aeronaveId/documentos/:id/arquivo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, nome, tipo_arquivo FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2').bind(c.req.param('id'), c.req.param('aeronaveId')).first<{ caminho_arquivo: string; nome: string; tipo_arquivo: string | null }>()
  if (!row) return c.notFound()
  const bucket = bucketShareBrasil(c)
  const object = await bucket.get(row.caminho_arquivo)
  if (!object) return c.notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', row.tipo_arquivo || object.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('Content-Disposition', `inline; filename="${shareBrasilFileName(row.nome)}"`)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(object.body, { headers })
})
