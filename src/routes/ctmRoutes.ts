import { coordenacao, ativo, podeEditar } from './ctmCoordenacao'
import { calcularPesoBalanceamento, erroConfiguracaoPeso, parseEnvelope, parseNomesPassageiros, validarNomesPassageiros } from '../lib/pesoBalanceamento'
import { Context, Hono } from 'hono'
import { extractSupabaseUserId, requireFlightCrewOrOperationsWriteAccess, requireFlightOperationAccess, requireShareInternal, shareBrasilUser } from '../lib/auth'
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

ctmRoutes.route('/api/ctm/coordenacao', coordenacao)

const STATUS_EDITAVEIS_FICHA_PESO = new Set([
  'aprovada', 'acionado', 'decolado', 'em_voo', 'em voo', 'em_rota', 'em rota', 'em_solo', 'pousado', 'encerrada', 'concluida',
])

export function statusPermiteEdicaoFichaPeso(status: unknown) {
  return STATUS_EDITAVEIS_FICHA_PESO.has(String(status || '').trim().toLowerCase())
}

export function statusPermiteRascunhoFichaPeso(status: unknown) {
  return String(status || '').trim().toLowerCase() === 'pendente' || statusPermiteEdicaoFichaPeso(status)
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
    throw error
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
  if (aeronaveId && !aeronave.results.some(r=>String(r.id)===aeronaveId)) return c.json({error:'Matrícula não encontrada.'},404)
  const selecionada = (aeronave.results || []).find((item: any) => String(item.id) === aeronaveId) || (aeronave.results || [])[0] || null
  const id = selecionada?.id
  const filtro = id ? ' WHERE aeronave_id = ?' : ' WHERE 1 = 0'
  const falhas:string[]=[]
  const [programa,diretrizes,componentes,oas,orcamentos,ras,carregamentos]=await Promise.all(['programa','diretrizes','componentes','oas','orcamentos','ras','carregamentos'].map(async modulo=>{
    const tabela=CTM_READ_TABLES[modulo].table
    try {
      return await ctmRead(c,tabela,`${filtro} AND ${ativo(modulo,tabela)} ORDER BY id`,id?[id]:[])
    } catch {
      falhas.push(modulo)
      return {results:[]}
    }
  }))
  const totalOrcamento = (orcamentos.results || []).reduce((total: number, item: any) => total + Number(item.total || item.valor_total || 0), 0)
  return c.json({ data: { falhas, aeronaves: aeronave.results, aeronave: selecionada, programa: programa.results, diretrizes: diretrizes.results, componentes: componentes.results, oas: oas.results, orcamentos: orcamentos.results, ras: ras.results, carregamentos: carregamentos.results, resumo: { itens_manutencao: programa.results.length, proximos_vencimentos: programa.results.filter((item: any) => String(item.status || '').toLowerCase() !== 'concluido').length, diretrizes_pendentes: diretrizes.results.filter((item: any) => !['complied','not_applicable', 'concluido', 'conforme'].includes(String(item.status || '').toLowerCase())).length, componentes_atencao: componentes.results.filter((item: any) => !['ok', 'regular'].includes(String(item.status || '').toLowerCase())).length, ordens_abertas: oas.results.filter((item: any) => !item.data_saida && isActiveCTMServiceOrder(item.status)).length, orcamento_total: totalOrcamento } } })
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
    ctmRead(c, 'ctm_ordem_acompanhamento_servico', ` WHERE ${ativo('oas','ctm_ordem_acompanhamento_servico')} AND aeronave_id IN (SELECT id FROM aeronave WHERE lower(COALESCE(status, 'ativa')) LIKE 'ativ%') ORDER BY data_entrada DESC`),
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
    const where = ` WHERE ${ativo(slug,config.table)}${aeronaveId ? ' AND aeronave_id = ?' : ''} ORDER BY id`
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
  return c.json({ configuracoes: (rows.results || []).map((config: any) => ({ ...config, envelope_pontos: parseEnvelope(config.envelope_pontos_json) || [], cg_unidade: 'estação (m conforme AFM/manual aprovado da matrícula)' })) })
})

ctmRoutes.post('/api/ctm/peso-balanceamento', async c => {
  const user = await shareBrasilUser(c)
  if (user && !podeEditar(user)) return c.json({error:'Acesso restrito ao CTM.'},403)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const aeronaveId = String(body.aeronave_id || '').trim()
  if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  const atual = await c.env.SHARE_DB.prepare('SELECT * FROM ctm_peso_balanceamento WHERE aeronave_id = ?1').bind(aeronaveId).first<any>()
  const id = atual?.id || crypto.randomUUID()
  const numero = (value: unknown, fallback: number | null = null) => value === '' || value === undefined || value === null ? fallback : Number(value)
  const envelopeRecebido = body.envelope_pontos_json ?? body.envelope_pontos ?? atual?.envelope_pontos_json ?? '[]'
  const envelope = parseEnvelope(envelopeRecebido)
  if (envelopeRecebido && String(envelopeRecebido) !== '[]' && !envelope) return c.json({ error: 'envelope_pontos_invalidos' }, 400)
  const envelopeJson = JSON.stringify(envelope || [])
  const valores = [
    numero(body.peso_vazio_padrao, Number(atual?.peso_vazio_padrao) || 0), numero(body.braco_cg_padrao, Number(atual?.braco_cg_padrao) || 0), numero(body.momento_padrao, atual?.momento_padrao == null ? null : Number(atual.momento_padrao)),
    numero(body.peso_maximo_decolagem, Number(atual?.peso_maximo_decolagem) || 0), numero(body.peso_maximo_pouso, Number(atual?.peso_maximo_pouso) || 0), numero(body.peso_maximo_sem_combustivel, atual?.peso_maximo_sem_combustivel == null ? null : Number(atual.peso_maximo_sem_combustivel)),
    numero(body.cg_limite_dianteiro, atual?.cg_limite_dianteiro == null ? 0 : Number(atual.cg_limite_dianteiro)), numero(body.cg_limite_traseiro, atual?.cg_limite_traseiro == null ? 0 : Number(atual.cg_limite_traseiro)), numero(body.mac_comprimento, atual?.mac_comprimento == null ? 0 : Number(atual.mac_comprimento)), numero(body.lemac_distancia, atual?.lemac_distancia == null ? 0 : Number(atual.lemac_distancia)),
    numero(body.capacidade_combustivel_total, atual?.capacidade_combustivel_total == null ? null : Number(atual.capacidade_combustivel_total)), numero(body.capacidade_combustivel_util, atual?.capacidade_combustivel_util == null ? null : Number(atual.capacidade_combustivel_util)), body.validado === undefined ? Number(atual?.validado || 0) : body.validado ? 1 : 0,
    body.notas === undefined ? atual?.notas || null : body.notas?.toString().trim() || null,
    body.data_ultima_pesagem === undefined ? atual?.data_ultima_pesagem || null : body.data_ultima_pesagem || null,
    body.numero_relatorio_pesagem === undefined ? atual?.numero_relatorio_pesagem || null : body.numero_relatorio_pesagem?.toString().trim() || null,
    body.responsavel_tecnico === undefined ? atual?.responsavel_tecnico || null : body.responsavel_tecnico?.toString().trim() || null,
    numero(body.limite_bagagem_diant_kg, atual?.limite_bagagem_diant_kg == null ? null : Number(atual.limite_bagagem_diant_kg)), numero(body.limite_bagagem_tras_kg, atual?.limite_bagagem_tras_kg == null ? null : Number(atual.limite_bagagem_tras_kg)), envelopeJson, user.id,
  ]
  const candidata = {
    validado: valores[12], peso_vazio_padrao: valores[0], braco_cg_padrao: valores[1],
    peso_maximo_decolagem: valores[3], peso_maximo_pouso: valores[4], peso_maximo_sem_combustivel: valores[5],
    envelope_pontos_json: envelopeJson, data_ultima_pesagem: valores[14], numero_relatorio_pesagem: valores[15], responsavel_tecnico: valores[16],
  }
  if (Number(candidata.validado) === 1) {
    const erro = erroConfiguracaoPeso(candidata)
    if (erro) return c.json({ error: erro, detail: 'A configuração validada exige limites positivos, envelope AFM/manual com pelo menos três pontos e evidências de pesagem, relatório e responsável técnico.' }, 400)
  }
  if (atual) {
    await c.env.SHARE_DB.prepare(`UPDATE ctm_peso_balanceamento SET peso_vazio_padrao=?, braco_cg_padrao=?, momento_padrao=?, peso_maximo_decolagem=?, peso_maximo_pouso=?, peso_maximo_sem_combustivel=?, cg_limite_dianteiro=?, cg_limite_traseiro=?, mac_comprimento=?, lemac_distancia=?, capacidade_combustivel_total=?, capacidade_combustivel_util=?, validado=?, notas=?, data_ultima_pesagem=?, numero_relatorio_pesagem=?, responsavel_tecnico=?, limite_bagagem_diant_kg=?, limite_bagagem_tras_kg=?, envelope_pontos_json=?, atualizado_em=CURRENT_TIMESTAMP, criado_por=? WHERE id=?`).bind(...valores, id).run()
  } else {
    await c.env.SHARE_DB.prepare(`INSERT INTO ctm_peso_balanceamento (peso_vazio_padrao, braco_cg_padrao, momento_padrao, peso_maximo_decolagem, peso_maximo_pouso, peso_maximo_sem_combustivel, cg_limite_dianteiro, cg_limite_traseiro, mac_comprimento, lemac_distancia, capacidade_combustivel_total, capacidade_combustivel_util, validado, notas, data_ultima_pesagem, numero_relatorio_pesagem, responsavel_tecnico, limite_bagagem_diant_kg, limite_bagagem_tras_kg, envelope_pontos_json, criado_por, aeronave_id, id) VALUES (${new Array(23).fill('?').join(', ')})`).bind(...valores, aeronaveId, id).run()
  }
  const configuracao = await c.env.SHARE_DB.prepare('SELECT p.*, a.matricula_registro, a.fabricante, a.modelo, a.numero_serie FROM ctm_peso_balanceamento p LEFT JOIN aeronave a ON a.id=p.aeronave_id WHERE p.id=?1').bind(id).first<any>()
  return c.json({ configuracao: configuracao ? { ...configuracao, envelope_pontos: parseEnvelope(configuracao.envelope_pontos_json) || [], cg_unidade: 'estação (m conforme AFM/manual aprovado da matrícula)' } : null }, atual ? 200 : 201)
})

ctmRoutes.get('/api/ctm/fichas-peso-balanceamento', async c => {
  const user = await shareBrasilUser(c)
  if (!user) return c.json({ error: 'nao_autorizado' }, 401)
  const rows = await c.env.SHARE_DB.prepare(`SELECT f.*, a.matricula_registro, a.modelo, s.origem, s.destino, s.data_agendada, s.passageiros_json
    FROM ctm_ficha_peso_balanceamento f LEFT JOIN aeronave a ON a.id=f.aeronave_id
    LEFT JOIN solicitacoes_reserva_voo s ON s.id=f.solicitacao_id ORDER BY COALESCE(f.data_voo, f.criado_em) DESC`).all<any>()
  return c.json({ fichas: (rows.results || []).map((f: any) => ({ ...f, passageiros: parseNomesPassageiros(f.passageiros_json), itens_carregamento: parseJsonOr(f.itens_carregamento, []), snapshot_limites: parseJsonOr(f.snapshot_limites, {}) })) })
})

ctmRoutes.get('/api/interno/agendamento/:id/peso-balanceamento', async c => {
  if (!(await requireFlightOperationAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaFichaPeso(c)
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const reserva = await db.prepare(`SELECT s.id, s.aeronave_id, s.numero_voo, s.data_agendada, s.origem, s.destino, s.numero_passageiros, s.passageiros_json, s.piloto_id, s.copiloto_id,
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
    solicitacao: { ...reserva, passageiros: parseNomesPassageiros(reserva.passageiros_json) },
    piloto: piloto ? { id: piloto.id, nome: piloto.nome_completo, canac: (piloto as any).canac ?? null } : null,
    copiloto: copiloto ? { id: copiloto.id, nome: copiloto.nome_completo, canac: (copiloto as any).canac ?? null } : null,
    configuracao: config ? { ...config, envelope_pontos: parseEnvelope(config.envelope_pontos_json) || [], cg_unidade: 'estação (m conforme AFM/manual aprovado da matrícula)' } : null,
    ficha: ficha ? { ...ficha, itens_carregamento: parseJsonOr(ficha.itens_carregamento, []), snapshot_limites: parseJsonOr(ficha.snapshot_limites, {}) } : null,
  })
})

ctmRoutes.post('/api/interno/agendamento/:id/peso-balanceamento', async c => {
  if (!(await requireFlightCrewOrOperationsWriteAccess(c, c.req.param('id')))) return c.json({ error: 'flight_operation_forbidden' }, 403)
  await garantirTabelaFichaPeso(c)
  const db = c.env.SHARE_DB
  const solicitacaoId = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  if (!body) return c.json({ error: 'payload_invalido' }, 400)
  const reserva = await db.prepare('SELECT id, aeronave_id, numero_voo, data_agendada, status, numero_passageiros, passageiros_json FROM solicitacoes_reserva_voo WHERE id = ?1').bind(solicitacaoId).first<any>()
  if (!reserva) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  const status = body.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO'
  if (status === 'FINALIZADA' ? !statusPermiteEdicaoFichaPeso(reserva.status) : !statusPermiteRascunhoFichaPeso(reserva.status)) {
    return c.json({ error: 'ficha_fora_da_preparacao', detail: status === 'FINALIZADA' ? 'A finalização exige solicitação aprovada ou em operação.' : 'A ficha pode ser salva como rascunho somente em solicitação pendente, aprovada ou em operação.' }, 409)
  }
  const piloto = String(body.piloto_responsavel || '').trim()
  if (!piloto) return c.json({ error: 'piloto_responsavel_obrigatorio' }, 400)
  const itens = Array.isArray(body.itens_carregamento) ? body.itens_carregamento : []
  const num = (valor: unknown) => (valor === null || valor === undefined || valor === '' ? null : Number(valor))
  const existente = await db.prepare('SELECT id, status FROM ctm_ficha_peso_balanceamento WHERE solicitacao_id = ?1 ORDER BY criado_em DESC LIMIT 1').bind(solicitacaoId).first<any>()
  if (existente?.status === 'FINALIZADA') return c.json({ error: 'ficha_ja_finalizada', id: existente.id }, 409)

  const configuracao = await db.prepare('SELECT * FROM ctm_peso_balanceamento WHERE aeronave_id = ?1 ORDER BY atualizado_em DESC LIMIT 1').bind(reserva.aeronave_id).first<any>()
  let finalizacao: { configuracao: any; pesoVazio: number; momentoVazio: number; fuelKg: number; fuelLitros: number | null; fuelArm: number; fuelMomento: number; resultado: any; itens: any[] } | null = null
  if (status === 'FINALIZADA') {
    const passageirosResultado = validarNomesPassageiros(parseNomesPassageiros(reserva.passageiros_json), Number(reserva.numero_passageiros || 0))
    if (!passageirosResultado.ok) return c.json({ error: 'passageiros_solicitacao_invalidos', detail: 'A solicitação deve conter exatamente um nome não vazio para cada passageiro.' }, 409)
    const erroConfig = erroConfiguracaoPeso(configuracao)
    if (erroConfig) return c.json({ error: erroConfig, detail: 'A aeronave precisa de configuração validada com limites positivos, envelope AFM/manual de ao menos três pontos e evidências de pesagem, relatório e responsável técnico.' }, 409)
    if (body.peso_balanceamento_id && body.peso_balanceamento_id !== configuracao.id) return c.json({ error: 'configuracao_aeronave_invalida' }, 400)
    const rawPlannedFuelBurn = body.snapshot_limites?.consumo_estimado_combustivel_kg
    if (rawPlannedFuelBurn === null || rawPlannedFuelBurn === undefined || String(rawPlannedFuelBurn).trim() === '') return c.json({ error: 'consumo_previsto_obrigatorio', detail: 'Informe o consumo estimado de combustível até o pouso.' }, 400)
    const calculation = calcularPesoBalanceamento(configuracao, {
      passageiros: passageirosResultado.nomes,
      itens_carregamento: itens,
      fuel_kg: body.fuel_kg,
      fuel_litros: body.fuel_litros,
      fuel_braco: body.fuel_braco,
      consumo_estimado_combustivel_kg: rawPlannedFuelBurn,
    })
    if (!calculation.ok) return c.json({ error: calculation.error, detail: calculation.detail }, calculation.error === 'ficha_fora_dos_limites' ? 422 : 400)
    const pesoVazio = Number(configuracao.peso_vazio_padrao)
    const bracoVazio = Number(configuracao.braco_cg_padrao)
    const fuelKg = Number(body.fuel_kg)
    const fuelLitros = num(body.fuel_litros)
    const fuelArm = Number(body.fuel_braco)
    const fuelMomento = fuelKg * fuelArm
    finalizacao = { configuracao, pesoVazio, momentoVazio: pesoVazio * bracoVazio, fuelKg, fuelLitros, fuelArm, fuelMomento, resultado: calculation.resultado, itens: calculation.itens }
  }

  const id = existente?.id || crypto.randomUUID()
  const config = finalizacao?.configuracao || configuracao
  const envelopeSnapshot = config ? parseEnvelope(config.envelope_pontos_json) || [] : []
  const configuracaoSnapshot = config ? {
    id: config.id, aeronave_id: config.aeronave_id, validado: Number(config.validado) === 1,
    peso_vazio_kg: config.peso_vazio_padrao, cg_vazio_estacao: config.braco_cg_padrao,
    momento_vazio: Number(config.peso_vazio_padrao) * Number(config.braco_cg_padrao),
    peso_maximo_decolagem: config.peso_maximo_decolagem, peso_maximo_pouso: config.peso_maximo_pouso,
    peso_maximo_sem_combustivel: config.peso_maximo_sem_combustivel,
    data_ultima_pesagem: config.data_ultima_pesagem, numero_relatorio_pesagem: config.numero_relatorio_pesagem,
    responsavel_tecnico: config.responsavel_tecnico, capacidade_combustivel_util_kg: config.capacidade_combustivel_util, envelope_pontos: envelopeSnapshot,
    unidade_cg: 'estação (m conforme AFM/manual aprovado da matrícula)',
  } : null
  const snapshotRecebido = body.snapshot_limites && typeof body.snapshot_limites === 'object' && !Array.isArray(body.snapshot_limites) ? { ...body.snapshot_limites } : {}
  for (const chave of ['resultado_calculo', 'resultado_peso_balanceamento', 'cg_previsto_pouso', 'cg_previsto_decolagem', 'cg_decolagem_estacao', 'cg_pouso_estacao', 'pouso_previsto_kg', 'peso_decolagem_kg', 'peso_pouso_kg', 'peso_sem_combustivel_kg', 'cg_zero_combustivel_estacao', 'envelope_zero_combustivel_ok', 'envelope_decolagem_ok', 'envelope_pouso_ok', 'momento_decolagem', 'momento_pouso', 'dentro_dos_limites', 'peso_maximo_decolagem', 'peso_maximo_pouso', 'peso_maximo_sem_combustivel', 'cg_limite_dianteiro', 'cg_limite_traseiro']) delete snapshotRecebido[chave]
  const consumoEstimado = finalizacao ? Number(snapshotRecebido.consumo_estimado_combustivel_kg) : snapshotRecebido.consumo_estimado_combustivel_kg
  const snapshotLimites = {
    ...snapshotRecebido,
    unidade_cg: 'estação (m conforme AFM/manual aprovado da matrícula)',
    configuracao_peso_snapshot: configuracaoSnapshot,
    envelope_pontos_json: envelopeSnapshot,
    ...(finalizacao ? {
      consumo_estimado_combustivel_kg: consumoEstimado,
      peso_decolagem_kg: finalizacao.resultado.peso_decolagem_kg,
      cg_decolagem_estacao: finalizacao.resultado.cg_decolagem_estacao,
      momento_decolagem: finalizacao.resultado.momento_decolagem,
      peso_pouso_kg: finalizacao.resultado.peso_pouso_kg,
      cg_pouso_estacao: finalizacao.resultado.cg_pouso_estacao,
      momento_pouso: finalizacao.resultado.momento_pouso,
      peso_sem_combustivel_kg: finalizacao.resultado.peso_sem_combustivel_kg,
      cg_zero_combustivel_estacao: finalizacao.resultado.cg_zero_combustivel_estacao,
      envelope_decolagem_ok: finalizacao.resultado.envelope_decolagem_ok,
      envelope_pouso_ok: finalizacao.resultado.envelope_pouso_ok,
      envelope_zero_combustivel_ok: finalizacao.resultado.envelope_zero_combustivel_ok,
    } : {}),
  }
  const itensPersistidos = finalizacao
    ? [...finalizacao.itens.map((item: any) => ({ ...item, peso_kg: Number(item.peso_kg ?? item.peso), braco: Number(item.braco), momento: Number(item.peso_kg ?? item.peso) * Number(item.braco) })), { descricao: 'Combustível', categoria: 'combustivel', peso_kg: finalizacao.fuelKg, braco: finalizacao.fuelArm, momento: finalizacao.fuelMomento, litros: finalizacao.fuelLitros }]
    : itens.map((item: any) => { const { momento: _momentoCalculado, ...valoresEntrada } = item || {}; return valoresEntrada })
  const pesoVazioRascunho = config ? num(config.peso_vazio_padrao) : null
  const bracoVazioRascunho = config ? num(config.braco_cg_padrao) : null
  const valores = [
    reserva.aeronave_id, String(config?.id || body.peso_balanceamento_id || ''), String(body.data_voo || reserva.data_agendada),
    body.numero_voo ?? reserva.numero_voo ?? null, piloto, finalizacao?.pesoVazio ?? pesoVazioRascunho, finalizacao ? Number(config.braco_cg_padrao) : bracoVazioRascunho, finalizacao?.momentoVazio ?? (pesoVazioRascunho !== null && bracoVazioRascunho !== null ? pesoVazioRascunho * bracoVazioRascunho : null),
    JSON.stringify(itensPersistidos), finalizacao?.fuelLitros ?? num(body.fuel_litros), finalizacao?.fuelKg ?? num(body.fuel_kg), finalizacao?.fuelArm ?? num(body.fuel_braco), finalizacao?.fuelMomento ?? (num(body.fuel_kg) !== null && num(body.fuel_braco) !== null ? Number(body.fuel_kg) * Number(body.fuel_braco) : null),
    finalizacao?.resultado.peso_decolagem_kg ?? null, finalizacao?.resultado.momento_decolagem ?? null, finalizacao?.resultado.cg_decolagem_estacao ?? null,
    config ? config.peso_maximo_decolagem : null, config ? config.peso_maximo_pouso : null, config ? config.peso_maximo_sem_combustivel : null,
    config ? config.cg_limite_dianteiro : null, config ? config.cg_limite_traseiro : null,
    finalizacao ? 1 : 0, status, JSON.stringify(snapshotLimites), body.observacoes?.toString().trim() || null,
    solicitacaoId, body.assinatura_nome?.toString().trim() || piloto, status === 'FINALIZADA' ? new Date().toISOString() : null,
  ]
  if (existente) {
    const atualizado = await db.prepare(`UPDATE ctm_ficha_peso_balanceamento SET aeronave_id = ?, peso_balanceamento_id = ?, data_voo = ?, numero_voo = ?, piloto_responsavel = ?,
      peso_vazio_kg = ?, braco_vazio = ?, momento_vazio = ?, itens_carregamento = ?, fuel_litros = ?, fuel_kg = ?, fuel_braco = ?, fuel_momento = ?,
      peso_total_kg = ?, momento_total = ?, cg_calculado = ?, peso_maximo_decolagem = ?, peso_maximo_pouso = ?, peso_maximo_sem_combustivel = ?,
      cg_limite_dianteiro = ?, cg_limite_traseiro = ?, dentro_dos_limites = ?, status = ?, snapshot_limites = ?, observacoes = ?, solicitacao_id = ?,
      assinatura_nome = ?, finalizado_em = ? WHERE id = ? AND COALESCE(upper(status),'') <> 'FINALIZADA'`).bind(...valores, id).run()
    if (!atualizado.meta.changes) return c.json({error:'ficha_ja_finalizada'},409)
  } else {
    const inserido = await db.prepare(`INSERT INTO ctm_ficha_peso_balanceamento (aeronave_id, peso_balanceamento_id, data_voo, numero_voo, piloto_responsavel,
      peso_vazio_kg, braco_vazio, momento_vazio, itens_carregamento, fuel_litros, fuel_kg, fuel_braco, fuel_momento,
      peso_total_kg, momento_total, cg_calculado, peso_maximo_decolagem, peso_maximo_pouso, peso_maximo_sem_combustivel,
      cg_limite_dianteiro, cg_limite_traseiro, dentro_dos_limites, status, snapshot_limites, observacoes, solicitacao_id,
      assinatura_nome, finalizado_em, id) SELECT ${new Array(29).fill('?').join(', ')} WHERE NOT EXISTS (SELECT 1 FROM ctm_ficha_peso_balanceamento WHERE solicitacao_id=?)`).bind(...valores, id,solicitacaoId).run()
    if (!inserido.meta.changes) return c.json({error:'ficha_alterada_recarregue'},409)
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
     , NOT ${ativo('documentos','documentos_aeronave')} AS arquivado FROM documentos_aeronave WHERE aeronave_id = ?1
    ORDER BY CASE WHEN data_validade IS NULL OR trim(data_validade) = '' THEN 1 ELSE 0 END, date(data_validade), lower(nome)`).bind(aeronaveId).all()
  return c.json({ documentos: rows.results.map((row: any) => ({ ...row, arquivo_url: `/api/ctm/aeronaves/${encodeURIComponent(aeronaveId)}/documentos/${encodeURIComponent(String(row.id))}/arquivo` })) })
})

ctmRoutes.post('/api/ctm/aeronaves/:aeronaveId/documentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const usuario=await shareBrasilUser(c)
  if (!usuario || !podeEditar(usuario)) return c.json({error:'Edição restrita à coordenação.'},403)
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
  const usuario=await shareBrasilUser(c)
  if (!usuario || !podeEditar(usuario)) return c.json({error:'Edição restrita à coordenação.'},403)
  const aeronaveId = c.req.param('aeronaveId')
  const id = c.req.param('id')
  const db = c.env.SHARE_DB
  const atual = await db.prepare(`SELECT id, nome, descricao, tipo_documento, data_validade, dias_alerta FROM documentos_aeronave WHERE id = ?1 AND aeronave_id = ?2 AND ${ativo('documentos','documentos_aeronave')}`).bind(id, aeronaveId).first<any>()
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
  const user=await shareBrasilUser(c)
  if (!user || !podeEditar(user)) return c.json({error:'Arquivamento restrito à coordenação.'},403)
  const atual=await db.prepare('SELECT * FROM documentos_aeronave WHERE id=? AND aeronave_id=?').bind(id,aeronaveId).first()
  if(!atual) return c.notFound()
  await db.prepare("INSERT OR IGNORE INTO ctm_historico(modulo,registro_id,aeronave_id,versao,acao,autor,anterior) VALUES ('documentos',?,?,1,'ARQUIVAR',?,?)").bind(id,aeronaveId,user.id,JSON.stringify(atual)).run()
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
