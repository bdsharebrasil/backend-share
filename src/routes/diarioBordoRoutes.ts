import { Context, Hono } from 'hono'
import { cachedFetch } from '../lib/cache'
import { requireShareInternal, extractSupabaseUserId } from '../lib/auth'
import { fetchAisweb } from '../lib/aiswebClient'
import { validateWorkerSchema } from '../lib/schema'
import { uuid } from '../lib/strings'

type Bindings = {
  SHARE_DB: D1Database
  CACHE_KV: KVNamespace
  RATE_LIMITER: DurableObjectNamespace
  INTERNAL_TOKEN?: string
  AISWEB_API_KEY?: string
  AISWEB_API_PASS?: string
}

type Variables = Record<string, never>

export const diarioBordoRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const log = { warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) }

function diarioNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function diarioDate(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function diarioBoolean(value: unknown): number {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0
}

function diarioText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

async function garantirTabelaAbastecimentos(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  await validateWorkerSchema(c, [{
    table: 'abastecimentos',
    columns: ['id', 'cliente_id', 'socio_id', 'aeronave_id', 'data', 'tipo_combustivel', 'trecho', 'local', 'numero_comanda', 'numero_nf', 'litros', 'valor_unitario', 'valor_total', 'desconto', 'fornecedor_id', 'status', 'observacao', 'criado_por', 'lancamento_diario_id', 'voo_emprestado', 'numero_voo', 'prazo_envio_cliente', 'atualizado_em'],
  }])
}

async function normalizarLocalAbastecimento(db: D1Database, valor: unknown): Promise<string | null> {
  const local = String(valor ?? '').trim()
  if (!local) return null
  const aerodromo = await db.prepare('SELECT designativo_icao FROM aerodromo WHERE id = ?1 OR upper(trim(designativo_icao)) = upper(trim(?1)) LIMIT 1').bind(local).first<{ designativo_icao: string }>()
  return aerodromo?.designativo_icao?.trim().toUpperCase() || null
}

function normalizarHorarioJornada(data: string, valor: unknown, referencia?: string | null): string | null {
  const texto = String(valor ?? '').trim()
  if (!texto) return null
  let instante: Date | null = null
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const iso = new Date(texto)
    instante = Number.isFinite(iso.getTime()) ? iso : null
  } else if (/^\d{2}:\d{2}(?::\d{2})?$/.test(texto)) {
    const iso = new Date(`${data}T${texto.length === 5 ? `${texto}:00` : texto}Z`)
    instante = Number.isFinite(iso.getTime()) ? iso : null
  }
  if (!instante) return null
  const base = referencia ? new Date(referencia).getTime() : NaN
  if (Number.isFinite(base) && instante.getTime() < base) instante = new Date(instante.getTime() + 86_400_000)
  return instante.toISOString()
}

function dataUtc(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function normalizarDataParaComparacao(valor: unknown): string {
  const texto = String(valor ?? '').trim()
  if (!texto) return ''
  const dm = texto.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/)
  if (dm) return `${dm[3]}${dm[2]}${dm[1]}`
  return texto.replace(/\D/g, '')
}

function instanteSolarUtc(data: string, valor: unknown): number | null {
  const texto = String(valor ?? '').trim()
  if (!texto) return null
  const normalizado = texto.replace(/^(\d{4})(\d{2})(\d{2})\s+/, '$1-$2-$3T')
  const candidato = /^\d{4}-\d{2}-\d{2}T/.test(normalizado)
    ? normalizado
    : `${data}T${normalizado}${/Z$|[+-]\d{2}:?\d{2}$/.test(normalizado) ? '' : 'Z'}`
  const timestamp = Date.parse(candidato)
  return Number.isFinite(timestamp) ? timestamp : null
}

async function calcularHorasDiurnas(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  origem: string | null,
  partida: string | null,
  pouso: string | null,
): Promise<{ diurnas: number; noturnas: number }> {
  const inicio = partida ? new Date(partida).getTime() : NaN
  const fim = pouso ? new Date(pouso).getTime() : NaN
  const icao = String(origem ?? '').trim().toUpperCase()
  if (!icao || !Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) return { diurnas: 0, noturnas: 0 }

  const totalMs = fim - inicio
  const datas: string[] = []
  for (let cursor = Date.parse(`${dataUtc(inicio)}T00:00:00Z`); cursor <= fim; cursor += 86_400_000) {
    datas.push(dataUtc(cursor))
  }
  const dias = await Promise.all(datas.map(async (data) => {
    const dataDecea = data.replace(/-/g, '')
    const payload = await cachedFetch(c, `solar-${icao}-${dataDecea}`, 86_400, () => fetchAisweb(c, 'sol', { icaoCode: icao, date: dataDecea }))
    const itens = Array.isArray(payload) ? payload : (payload?.sol ?? [payload])
    const esperado = data.replace(/\D/g, '')
    const item = itens.find((dia: any) => normalizarDataParaComparacao(dia?.date ?? dia?.data) === esperado) || (itens.length === 1 ? itens[0] : null)
    const nascer = instanteSolarUtc(data, item?.nascer ?? item?.sunrise)
    const poente = instanteSolarUtc(data, item?.poente ?? item?.sunset)
    if (nascer === null || poente === null || poente <= nascer) throw new Error(`DECEA não retornou nascer/pôr do sol para ${icao} em ${data}`)
    return Math.max(0, Math.min(fim, poente) - Math.max(inicio, nascer))
  }))
  const diurnas = dias.reduce((total, valor) => total + valor, 0) / 3_600_000
  const tempoVoo = totalMs / 3_600_000
  return {
    diurnas: Number(diurnas.toFixed(2)),
    noturnas: Number(Math.max(0, tempoVoo - diurnas).toFixed(2)),
  }
}

type DadosOperacionais = {
  acionamento_utc: string | null
  decolagem_utc: string | null
  pouso_utc: string | null
  corte_utc: string | null
  tempo_voo: number
  tempo_total: number
  horas_diurnas: number
  horas_noturnas: number
  solar_status: 'calculated' | 'calculated_manual_night' | 'not_calculated'
}

async function calcularDadosOperacionais(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  body: Record<string, any>,
  data: string,
  origem: string | null = body.aerodromo_partida,
): Promise<DadosOperacionais> {
  const timestamp = (utc: unknown, legado: unknown, referencia?: string | null) => normalizarHorarioJornada(data, utc ?? legado, referencia)
  const acionamento = timestamp(body.acionamento_utc, body.tempo_ac)
  const decolagem = timestamp(body.decolagem_utc, body.tempo_dep, acionamento)
  const pouso = timestamp(body.pouso_utc, body.tempo_pou, decolagem || acionamento)
  const corte = timestamp(body.corte_utc, body.tempo_cor, pouso || decolagem || acionamento)
  const inicioVoo = decolagem ? new Date(decolagem).getTime() : NaN
  const fimVoo = pouso ? new Date(pouso).getTime() : NaN
  const inicioTotal = acionamento ? new Date(acionamento).getTime() : NaN
  const fimTotal = (corte || pouso) ? new Date(corte || pouso!).getTime() : NaN
  const tempoVoo = Number((Number.isFinite(inicioVoo) && Number.isFinite(fimVoo) && fimVoo >= inicioVoo ? (fimVoo - inicioVoo) / 3_600_000 : 0).toFixed(2))
  const tempoTotal = Number((Number.isFinite(inicioTotal) && Number.isFinite(fimTotal) && fimTotal >= inicioTotal ? (fimTotal - inicioTotal) / 3_600_000 : tempoVoo).toFixed(2))
  let calculoSolar = { diurnas: 0, noturnas: 0 }
  let solarCalculado = false
  if (decolagem && pouso) {
    try {
      calculoSolar = await calcularHorasDiurnas(c, origem, decolagem, pouso)
      solarCalculado = true
    } catch (error) {
      calculoSolar = { diurnas: tempoVoo, noturnas: 0 }
      log.warn('[diario-bordo] não foi possível calcular horas diurnas', error)
    }
  }
  const temAjusteNoturno = body.horas_noturnas !== undefined && body.horas_noturnas !== null && body.horas_noturnas !== ''
  const horasNoturnas = temAjusteNoturno
    ? Number(Math.min(tempoVoo, Math.max(0, diarioNumber(body.horas_noturnas))).toFixed(2))
    : calculoSolar.noturnas
  return {
    acionamento_utc: acionamento,
    decolagem_utc: decolagem,
    pouso_utc: pouso,
    corte_utc: corte,
    tempo_voo: tempoVoo,
    tempo_total: tempoTotal,
    horas_diurnas: temAjusteNoturno ? Number(Math.max(0, tempoVoo - horasNoturnas).toFixed(2)) : calculoSolar.diurnas,
    horas_noturnas: horasNoturnas,
    solar_status: temAjusteNoturno ? 'calculated_manual_night' : (solarCalculado ? 'calculated' : 'not_calculated'),
  }
}

async function recalcularDiarioMes(c: Context<{ Bindings: Bindings; Variables: Variables }>, diarioMesId: string): Promise<void> {
  const db = c.env.SHARE_DB
  const diario = await db.prepare('SELECT id, celula_anterior_ttotal, celula_prox_revisao_ttotal, celula_anterior_tvoo, celula_prox_revisao_tvoo FROM diario_mes WHERE id = ?1').bind(diarioMesId).first<any>()
  if (!diario) return
  const totais = await db.prepare(`SELECT COALESCE(SUM(tempo_total), 0) AS tempo_total, COALESCE(SUM(tempo_voo), 0) AS tempo_voo
    FROM lancamentos_diario_bordo WHERE diario_mes_id = ?1`).bind(diarioMesId).first<any>()
  const celulaAtualTotal = Number((Number(diario.celula_anterior_ttotal || 0) + Number(totais?.tempo_total || 0)).toFixed(2))
  const celulaAtualVoo = Number((Number(diario.celula_anterior_tvoo || 0) + Number(totais?.tempo_voo || 0)).toFixed(2))
  const disponivelTotal = Number(diario.celula_prox_revisao_ttotal || 0) > 0 ? Number((Number(diario.celula_prox_revisao_ttotal || 0) - celulaAtualTotal).toFixed(2)) : 0
  const disponivelVoo = Number(diario.celula_prox_revisao_tvoo || 0) > 0 ? Number((Number(diario.celula_prox_revisao_tvoo || 0) - celulaAtualVoo).toFixed(2)) : 0
  await db.prepare('UPDATE diario_mes SET celula_atual_ttotal = ?1, celula_disponivel_ttotal = ?2, celula_atual_tvoo = ?3, celula_disponivel_tvoo = ?4 WHERE id = ?5')
    .bind(celulaAtualTotal, disponivelTotal, celulaAtualVoo, disponivelVoo, diarioMesId).run()
}

async function nomeAerodromoDiario(c: Context<{ Bindings: Bindings; Variables: Variables }>, valor: string): Promise<string> {
  const codigo = String(valor || '').trim().toUpperCase()
  if (!codigo) return codigo
  const item = await c.env.SHARE_DB.prepare('SELECT nome FROM aerodromo WHERE upper(designativo_icao) = ?1 LIMIT 1').bind(codigo).first<{ nome: string }>()
  return item?.nome?.trim() || codigo
}

async function nomeTripulantePorCanac(c: Context<{ Bindings: Bindings; Variables: Variables }>, canac: string): Promise<string | null> {
  const codigo = String(canac || '').trim().toUpperCase()
  if (!codigo) return null
  const tripulante = await c.env.SHARE_DB.prepare('SELECT nome_completo FROM tripulacao WHERE upper(canac) = ?1 LIMIT 1').bind(codigo).first<{ nome_completo: string | null }>()
  if (tripulante?.nome_completo) return tripulante.nome_completo
  const freelancer = await c.env.SHARE_DB.prepare('SELECT nome_completo FROM tripulacao_freelancer WHERE upper(canac) = ?1 LIMIT 1').bind(codigo).first<{ nome_completo: string | null }>()
  return freelancer?.nome_completo || null
}

async function trechoAerodromosDiario(c: Context<{ Bindings: Bindings; Variables: Variables }>, partida: string, chegada: string): Promise<string> {
  const [nomePartida, nomeChegada] = await Promise.all([nomeAerodromoDiario(c, partida), nomeAerodromoDiario(c, chegada)])
  return `${nomePartida} X ${nomeChegada}`
}

function normalizarLancamentoDiario(body: Record<string, any>, aeronave: any, defaults: { diarioMesId?: string; celula?: number; sequencial?: number; criadoPor?: string | null } = {}): Record<string, unknown> {
  const partida = String(body.aerodromo_partida || '').trim().toUpperCase()
  const chegada = String(body.aerodromo_chegada || '').trim().toUpperCase()
  const data = diarioDate(body.data_registro)
  const natureza = String(body.natureza_voo || '').trim()
  const rateioIgual = natureza === 'TR - Traslado' || natureza === 'VT - Voo Teste'
  const tempoVoo = diarioNumber(body.tempo_voo)
  const tempoTotal = diarioNumber(body.tempo_total, tempoVoo)
  const consumoHora = diarioNumber(aeronave?.consumo_combustivel)
  const consumoVoo = Number((tempoVoo * consumoHora).toFixed(2))
  const consumoTotal = Number((tempoTotal * consumoHora).toFixed(2))
  const row: Record<string, unknown> = {
    numero_voo: diarioText(body.numero_voo), jornada_id: diarioText(body.jornada_id), diario_mes_id: defaults.diarioMesId || body.diario_mes_id,
    aeronave_id: body.aeronave_id, cliente_id: rateioIgual ? null : body.cliente_id || null, holding_id: rateioIgual ? null : body.holding_id || null, socio_id: rateioIgual ? null : body.socio_id || null, voo_emprestado: diarioBoolean(body.voo_emprestado), socio_tomador_emprestimo_id: body.socio_tomador_emprestimo_id || null, cliente_tomador_emprestimo_id: body.cliente_tomador_emprestimo_id || null,
    data_registro: data, aerodromo_partida: partida, aerodromo_chegada: chegada, trecho: body.trecho?.trim() || `${partida} X ${chegada}`,
    pic_canac: String(body.pic_canac || '').trim().toUpperCase(), pic_nome: body.pic_nome?.trim() || null, sic_canac: body.sic_canac?.trim()?.toUpperCase() || null, sic_nome: body.sic_nome?.trim() || null, tripulacao_checkin_hora: body.tripulacao_checkin_hora || null,
    tempo_ac: body.tempo_ac || null, tempo_dep: body.tempo_dep || null, tempo_pou: body.tempo_pou || null, tempo_cor: body.tempo_cor || null, tempo_ifr: diarioNumber(body.tempo_ifr), tempo_voo: tempoVoo, tempo_total: tempoTotal,
    horas_diurnas: diarioNumber(body.horas_diurnas, tempoVoo), horas_noturnas: diarioNumber(body.horas_noturnas), pousos_total: Math.max(0, Math.trunc(diarioNumber(body.pousos_total))), distancia_nm: diarioNumber(body.distancia_nm), diarias: body.diarias == null || body.diarias === '' ? null : String(body.diarias),
    consumo_combustivel_voo: consumoVoo, consumo_combustivel_total: consumoTotal, litros_combustivel_inicio_voo: diarioNumber(body.litros_combustivel_inicio_voo), litros_combustivel_abastecido: diarioNumber(body.litros_combustivel_abastecido), local_combustivel: body.local_combustivel?.trim() || null, abastecido: diarioBoolean(body.abastecido),
    celula: diarioNumber(body.celula, defaults.celula || 0), confirmado: diarioBoolean(body.confirmado), confirmado_em: diarioBoolean(body.confirmado) ? (body.confirmado_em || new Date().toISOString()) : null, assinado_pic: body.assinado_pic || null, data_assinatura: body.data_assinatura || null,
    passageiros: Math.max(0, Math.trunc(diarioNumber(body.passageiros))), carga_kg: body.carga_kg == null || body.carga_kg === '' ? null : String(body.carga_kg), natureza_voo: String(body.natureza_voo || '').trim(), ocorrencias: body.ocorrencias?.trim() || null, discrepancias: body.discrepancias?.trim() || null, acoes_corretivas: body.acoes_corretivas?.trim() || null,
    tipo_manutencao_ultima: body.tipo_manutencao_ultima?.trim() || null, tipo_manutencao_proxima: body.tipo_manutencao_proxima?.trim() || null, responsavel_aprovacao_manutencao: body.responsavel_aprovacao_manutencao?.trim() || null, detectado_por: body.detectado_por?.trim() || null,
  }
  if (defaults.sequencial !== undefined) row.numero_sequencial = defaults.sequencial
  if (defaults.criadoPor) row.criado_por = defaults.criadoPor
  return row
}

diarioBordoRoutes.get('/api/interno/diario-bordo/opcoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = c.env.SHARE_DB
  const [clientes, holdings, socios, tripulacao, freelancers, aerodromos] = await Promise.all([
    db.prepare("SELECT id, razao_social AS nome, codigo_cliente, proprietario FROM cliente WHERE lower(COALESCE(status, 'ativo')) NOT IN ('inativo', 'cancelado') ORDER BY razao_social").all(),
    db.prepare("SELECT id, nome, proprietario FROM holdings WHERE COALESCE(ativo, 1) = 1 ORDER BY nome").all(),
    db.prepare('SELECT id, nome, cotista_id, holding_id FROM hold_socios ORDER BY nome').all(),
    db.prepare("SELECT id, canac, nome_completo, status, 'tripulacao' AS origem FROM tripulacao WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare("SELECT id, canac, nome_completo, status, 'freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo").all(),
    db.prepare('SELECT id, designativo_icao AS designativo, nome FROM aerodromo ORDER BY designativo_icao').all(),
  ])
  return c.json({ clientes: clientes.results, holdings: holdings.results, socios: socios.results, tripulantes: [...tripulacao.results, ...freelancers.results], aerodromos: aerodromos.results })
})

diarioBordoRoutes.get('/api/interno/diario-bordo/resumo', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const ano = Number(c.req.query('ano') || new Date().getFullYear())
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return c.json({ error: 'ano_invalido' }, 400)
  const rows = await c.env.SHARE_DB.prepare(`SELECT a.id, a.matricula_registro, a.fabricante, a.modelo, a.status, a.consumo_combustivel,
      COALESCE((SELECT SUM(l.tempo_total) FROM lancamentos_diario_bordo l WHERE l.aeronave_id = a.id AND strftime('%Y', l.data_registro) = ?1), 0) AS horas_ano,
      COALESCE(dm.celula_atual_ttotal, 0) AS celula_atual_ttotal,
      COALESCE(dm.celula_prox_revisao_ttotal, 0) AS celula_prox_revisao_ttotal,
      COALESCE(dm.mes, 0) AS mes_referencia,
      COALESCE(dm.fechado, 0) AS fechado
    FROM aeronave a
    LEFT JOIN diario_mes dm ON dm.id = (SELECT dm2.id FROM diario_mes dm2 WHERE dm2.aeronave_id = a.id AND dm2.ano = ?1 ORDER BY dm2.mes DESC LIMIT 1)
    WHERE lower(COALESCE(a.status, 'ativa')) LIKE 'ativ%'
    ORDER BY a.matricula_registro`).bind(String(ano)).all<any>()
  return c.json({ ano, aeronaves: rows.results.map((row: any) => ({ ...row, horas_ano: Number(row.horas_ano || 0), celula_atual_ttotal: Number(row.celula_atual_ttotal || 0), celula_prox_revisao_ttotal: Number(row.celula_prox_revisao_ttotal || 0), fechado: Number(row.fechado || 0) })) })
})

diarioBordoRoutes.get('/api/interno/diario-bordo/detalhes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const aeronaveId = (c.req.query('aeronave_id') || '').trim()
  const ano = Number(c.req.query('ano') || new Date().getFullYear())
  const mes = Number(c.req.query('mes') || new Date().getMonth() + 1)
  if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria' }, 400)
  if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) return c.json({ error: 'periodo_invalido' }, 400)
  const db = c.env.SHARE_DB
  await garantirTabelaAbastecimentos(c)
  const aeronave = await db.prepare('SELECT id, matricula_registro, fabricante, modelo, status, consumo_combustivel, base FROM aeronave WHERE id = ?1').bind(aeronaveId).first<any>()
  if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  const diarioMes = await db.prepare('SELECT * FROM diario_mes WHERE aeronave_id = ?1 AND ano = ?2 AND mes = ?3 LIMIT 1').bind(aeronaveId, ano, mes).first<any>()
  const meses = await db.prepare('SELECT id, ano, mes, fechado, celula_atual_ttotal, celula_prox_revisao_ttotal FROM diario_mes WHERE aeronave_id = ?1 ORDER BY ano DESC, mes DESC').bind(aeronaveId).all<any>()
  if (!diarioMes) return c.json({ aeronave, diario_mes: null, lancamentos: [], meses_disponiveis: meses.results })
  const lancamentos = await db.prepare(`SELECT l.*, (SELECT matricula_registro FROM aeronave WHERE id = l.aeronave_id) AS matricula_registro, c.razao_social AS cliente_nome, c.codigo_cliente AS cliente_codigo, c.proprietario AS cliente_proprietario, h.nome AS holding_nome, s.nome AS socio_nome,
      ct.razao_social AS cliente_tomador_nome, ct.codigo_cliente AS cliente_tomador_codigo, st.nome AS socio_tomador_nome,
      COALESCE(adp.designativo_icao, l.aerodromo_partida) AS aerodromo_partida_icao, COALESCE(adp.nome, l.aerodromo_partida) AS aerodromo_partida_nome,
      COALESCE(adg.designativo_icao, l.aerodromo_chegada) AS aerodromo_chegada_icao, COALESCE(adg.nome, l.aerodromo_chegada) AS aerodromo_chegada_nome,
      COALESCE(NULLIF(l.pic_nome, ''), (SELECT t.nome_completo FROM tripulacao t WHERE upper(t.canac) = upper(l.pic_canac) LIMIT 1), (SELECT f.nome_completo FROM tripulacao_freelancer f WHERE upper(f.canac) = upper(l.pic_canac) LIMIT 1)) AS pic_nome_exibicao,
      COALESCE(NULLIF(l.sic_nome, ''), (SELECT t.nome_completo FROM tripulacao t WHERE upper(t.canac) = upper(l.sic_canac) LIMIT 1), (SELECT f.nome_completo FROM tripulacao_freelancer f WHERE upper(f.canac) = upper(l.sic_canac) LIMIT 1)) AS sic_nome_exibicao,
      COALESCE((SELECT SUM(ab.litros) FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id), 0) AS abastecimento_litros,
      (SELECT ab.data FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_data,
      (SELECT COALESCE(ca.razao_social, so.nome) FROM abastecimentos ab LEFT JOIN cliente ca ON ca.id = ab.cliente_id LEFT JOIN hold_socios so ON so.id = ab.socio_id WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_pagador_nome,
      (SELECT ab.numero_comanda FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_comanda,
      (SELECT ab.numero_nf FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_nota,
      (SELECT ab.id FROM abastecimentos ab WHERE ab.lancamento_diario_id = l.id ORDER BY date(ab.data) DESC, ab.id DESC LIMIT 1) AS abastecimento_id,
      (SELECT p.id FROM pernas_jornada_voo p WHERE p.lancamento_diario_id = l.id LIMIT 1) AS perna_jornada_id
    FROM lancamentos_diario_bordo l
    LEFT JOIN cliente c ON c.id = l.cliente_id
    LEFT JOIN holdings h ON h.id = l.holding_id
    LEFT JOIN hold_socios s ON s.id = l.socio_id
    LEFT JOIN cliente ct ON ct.id = l.cliente_tomador_emprestimo_id
    LEFT JOIN hold_socios st ON st.id = l.socio_tomador_emprestimo_id
    LEFT JOIN aerodromo adp ON upper(adp.designativo_icao) = upper(l.aerodromo_partida)
    LEFT JOIN aerodromo adg ON upper(adg.designativo_icao) = upper(l.aerodromo_chegada)
    WHERE l.diario_mes_id = ?1
    ORDER BY date(l.data_registro), l.numero_sequencial, l.id`).bind(diarioMes.id).all<any>()
  const horasCotistas = await db.prepare(`SELECT
      CASE WHEN l.natureza_voo IN ('TR - Traslado', 'VT - Voo Teste') THEN l.natureza_voo ELSE COALESCE(l.socio_id, l.cliente_id, l.holding_id) END AS cotista_id,
      CASE WHEN l.natureza_voo IN ('TR - Traslado', 'VT - Voo Teste') THEN l.natureza_voo ELSE COALESCE(s.nome, h.nome, c.razao_social, c.proprietario, 'Cotista não identificado') END AS cotista_nome,
      COALESCE(SUM(l.tempo_voo), 0) AS horas_voo
    FROM lancamentos_diario_bordo l
    LEFT JOIN cliente c ON c.id = l.cliente_id
    LEFT JOIN holdings h ON h.id = l.holding_id
    LEFT JOIN hold_socios s ON s.id = l.socio_id
    WHERE l.diario_mes_id = ?1
    GROUP BY CASE WHEN l.natureza_voo IN ('TR - Traslado', 'VT - Voo Teste') THEN l.natureza_voo ELSE COALESCE(l.socio_id, l.cliente_id, l.holding_id) END,
      CASE WHEN l.natureza_voo IN ('TR - Traslado', 'VT - Voo Teste') THEN l.natureza_voo ELSE COALESCE(s.nome, h.nome, c.razao_social, c.proprietario, 'Cotista não identificado') END
    ORDER BY horas_voo DESC`).bind(diarioMes.id).all()
  const horasEmprestadas = await db.prepare(`SELECT COALESCE(SUM(e.horas_emprestadas - COALESCE(e.horas_devolvidas, 0)), 0) AS horas_total, COUNT(*) AS quantidade FROM emprestimos_aeronave e LEFT JOIN lancamentos_diario_bordo l ON l.id = e.lancamento_diario_id WHERE l.diario_mes_id = ?1`).bind(diarioMes.id).first<any>()
  return c.json({ aeronave, diario_mes: diarioMes, lancamentos: lancamentos.results, meses_disponiveis: meses.results, horas_cotistas: horasCotistas.results, horas_emprestadas: { horas_total: Number(horasEmprestadas?.horas_total || 0), quantidade: Number(horasEmprestadas?.quantidade || 0) } })
})

diarioBordoRoutes.post('/api/interno/diario-bordo/mes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const aeronaveId = String(body.aeronave_id || '').trim()
  const ano = diarioNumber(body.ano, 0)
  const mes = diarioNumber(body.mes, 0)
  const modoCelula = body.modo_celula === 'tvoo' ? 'tvoo' : body.modo_celula === 'tempo_total' ? 'tempo_total' : null
  if (!aeronaveId || !Number.isInteger(ano) || ano < 2000 || ano > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) return c.json({ error: 'aeronave_e_periodo_obrigatorios' }, 400)
  if (!modoCelula) return c.json({ error: 'modo_celula_invalido' }, 400)
  const db = c.env.SHARE_DB
  const aeronave = await db.prepare('SELECT id FROM aeronave WHERE id = ?1').bind(aeronaveId).first()
  if (!aeronave) return c.json({ error: 'aeronave_nao_encontrada' }, 404)
  const existing = await db.prepare('SELECT id FROM diario_mes WHERE aeronave_id = ?1 AND ano = ?2 AND mes = ?3 LIMIT 1').bind(aeronaveId, ano, mes).first<{ id: string }>()
  if (existing) return c.json({ error: 'diario_mes_ja_existe', id: existing.id }, 409)
  const anterior = await db.prepare('SELECT celula_atual_ttotal, celula_atual_tvoo FROM diario_mes WHERE aeronave_id = ?1 AND (ano < ?2 OR (ano = ?2 AND mes < ?3)) ORDER BY ano DESC, mes DESC LIMIT 1').bind(aeronaveId, ano, mes).first<any>()
  const anteriorTotal = diarioNumber(body.celula_anterior_ttotal, diarioNumber(anterior?.celula_atual_ttotal))
  const anteriorVoo = diarioNumber(body.celula_anterior_tvoo, diarioNumber(anterior?.celula_atual_tvoo))
  const id = uuid()
  await db.prepare(`INSERT INTO diario_mes (id, aeronave_id, ano, mes, celula_anterior_ttotal, celula_atual_ttotal, celula_prox_revisao_ttotal, celula_disponivel_ttotal, horimetro_inicio, horimetro_final, horimetro_ativo, fechado, aerodromo_base, tarifa_diaria, consumo_combustivel, tem_tarifa_diaria, celula_atual_tvoo, celula_disponivel_tvoo, celula_anterior_tvoo, celula_prox_revisao_tvoo, modo_celula)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id, aeronaveId, ano, mes, anteriorTotal, anteriorTotal, diarioNumber(body.celula_prox_revisao_ttotal), 0,
    diarioNumber(body.horimetro_inicio), diarioNumber(body.horimetro_final), diarioNumber(body.horimetro_ativo), 0,
    body.aerodromo_base?.trim() || null, diarioNumber(body.tarifa_diaria), body.consumo_combustivel?.trim() || null, diarioBoolean(body.tem_tarifa_diaria ?? true),
    anteriorVoo, 0, anteriorVoo, diarioNumber(body.celula_prox_revisao_tvoo), modoCelula,
  ).run()
  return c.json({ id, aeronave_id: aeronaveId, ano, mes, celula_anterior_ttotal: anteriorTotal, celula_anterior_tvoo: anteriorVoo }, 201)
})

diarioBordoRoutes.patch('/api/interno/diario-bordo/mes/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const allowed: Record<string, (value: unknown) => unknown> = {
    celula_anterior_ttotal: value => diarioNumber(value), celula_atual_ttotal: value => diarioNumber(value), celula_prox_revisao_ttotal: value => diarioNumber(value), celula_disponivel_ttotal: value => diarioNumber(value),
    horimetro_inicio: value => diarioNumber(value), horimetro_final: value => diarioNumber(value), horimetro_ativo: value => diarioNumber(value), fechado: value => diarioBoolean(value),
    aerodromo_base: value => typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null, tarifa_diaria: value => diarioNumber(value), consumo_combustivel: value => typeof value === 'string' && value.trim() ? value.trim() : null, tem_tarifa_diaria: value => diarioBoolean(value),
    celula_atual_tvoo: value => diarioNumber(value), celula_disponivel_tvoo: value => diarioNumber(value), celula_anterior_tvoo: value => diarioNumber(value), celula_prox_revisao_tvoo: value => diarioNumber(value),
  }
  const updates = Object.keys(allowed).filter(field => body[field] !== undefined)
  if (updates.length === 0) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const result = await c.env.SHARE_DB.prepare(`UPDATE diario_mes SET ${updates.map(field => `${field} = ?`).join(', ')} WHERE id = ?`).bind(...updates.map(field => allowed[field](body[field])), id).run()
  if (!result.meta.changes) return c.notFound()
  await recalcularDiarioMes(c, id)
  const updated = await c.env.SHARE_DB.prepare('SELECT * FROM diario_mes WHERE id = ?1').bind(id).first()
  return c.json(updated)
})

const DIARIO_LANCAMENTO_FIELDS = [
  'numero_voo', 'jornada_id', 'cliente_id', 'holding_id', 'socio_id', 'voo_emprestado', 'socio_tomador_emprestimo_id', 'cliente_tomador_emprestimo_id', 'data_registro', 'aerodromo_partida', 'aerodromo_chegada', 'trecho', 'pic_canac', 'pic_nome', 'sic_canac', 'sic_nome', 'tripulacao_checkin_hora', 'tempo_ac', 'tempo_dep', 'tempo_pou', 'tempo_cor', 'tempo_ifr', 'tempo_voo', 'tempo_total', 'horas_diurnas', 'horas_noturnas', 'pousos_total', 'distancia_nm', 'diarias', 'consumo_combustivel_voo', 'consumo_combustivel_total', 'litros_combustivel_inicio_voo', 'litros_combustivel_abastecido', 'local_combustivel', 'abastecido', 'celula', 'confirmado', 'confirmado_em', 'assinado_pic', 'data_assinatura', 'passageiros', 'carga_kg', 'natureza_voo', 'ocorrencias', 'discrepancias', 'acoes_corretivas', 'tipo_manutencao_ultima', 'tipo_manutencao_proxima', 'responsavel_aprovacao_manutencao', 'detectado_por',
]

diarioBordoRoutes.post('/api/interno/diario-bordo/lancamentos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const aeronaveId = String(body.aeronave_id || '').trim()
  const diarioMesId = String(body.diario_mes_id || '').trim()
  const data = diarioDate(body.data_registro)
  if (!aeronaveId || !diarioMesId || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !body.aerodromo_partida?.trim() || !body.aerodromo_chegada?.trim() || !body.pic_canac?.trim() || !body.natureza_voo?.trim()) return c.json({ error: 'campos_obrigatorios_ausentes' }, 400)
  const db = c.env.SHARE_DB
  const [aeronave, diario] = await Promise.all([
    db.prepare('SELECT id, consumo_combustivel FROM aeronave WHERE id = ?1').bind(aeronaveId).first<any>(),
    db.prepare('SELECT id, aeronave_id, ano, mes, fechado, celula_atual_ttotal, celula_atual_tvoo FROM diario_mes WHERE id = ?1').bind(diarioMesId).first<any>(),
  ])
  if (!aeronave || !diario || diario.aeronave_id !== aeronaveId) return c.json({ error: 'diario_ou_aeronave_invalido' }, 409)
  if (Number(diario.fechado)) return c.json({ error: 'diario_fechado' }, 409)
  if (data.slice(0, 7) !== `${diario.ano}-${String(diario.mes).padStart(2, '0')}`) return c.json({ error: 'data_fora_do_mes' }, 400)
  const pernaId = String(body.perna_jornada_id || '').trim()
  let pernaVinculada: any = null
  if (pernaId) {
    pernaVinculada = await db.prepare(`SELECT p.id, p.lancamento_diario_id, p.jornada_id, p.origem, p.destino, p.horario_ac, p.horario_dep, p.horario_pouso, p.horario_corte, j.aeronave_id FROM pernas_jornada_voo p JOIN jornadas_voo j ON j.id = p.jornada_id WHERE p.id = ?1`).bind(pernaId).first<any>()
    if (!pernaVinculada) return c.json({ error: 'perna_nao_encontrada' }, 404)
    if (pernaVinculada.aeronave_id !== aeronaveId || (body.jornada_id && String(body.jornada_id) !== String(pernaVinculada.jornada_id))) return c.json({ error: 'perna_nao_corresponde_a_jornada_ou_aeronave' }, 409)
    if (pernaVinculada.lancamento_diario_id) return c.json({ error: 'perna_ja_lancada_no_diario' }, 409)
  }
  const last = await db.prepare('SELECT COALESCE(MAX(numero_sequencial), 0) AS sequencial FROM lancamentos_diario_bordo WHERE diario_mes_id = ?1').bind(diarioMesId).first<{ sequencial: number }>()
  const id = uuid()
  const perfilPic = await db.prepare('SELECT nome_completo FROM user_profiles WHERE id = ?1').bind(extractSupabaseUserId(c)).first<{ nome_completo: string | null }>()
  const [nomePic, nomeSic, trecho] = await Promise.all([nomeTripulantePorCanac(c, body.pic_canac), nomeTripulantePorCanac(c, body.sic_canac), trechoAerodromosDiario(c, body.aerodromo_partida, body.aerodromo_chegada)])
  const horario = (valor: string | null) => valor ? String(valor).slice(11, 16) : null
  const dadosOperacionais = await calcularDadosOperacionais(c, pernaVinculada ? {
    ...body,
    acionamento_utc: body.acionamento_utc ?? body.tempo_ac ?? pernaVinculada.horario_ac,
    decolagem_utc: body.decolagem_utc ?? body.tempo_dep ?? pernaVinculada.horario_dep,
    pouso_utc: body.pouso_utc ?? body.tempo_pou ?? pernaVinculada.horario_pouso,
    corte_utc: body.corte_utc ?? body.tempo_cor ?? pernaVinculada.horario_corte,
  } : body, data, body.aerodromo_partida || pernaVinculada?.origem || body.aerodromo_partida)
  const dadosDaPerna = pernaVinculada ? {
    ...body,
    numero_voo: body.numero_voo || null,
    jornada_id: pernaVinculada.jornada_id,
    aerodromo_partida: body.aerodromo_partida || pernaVinculada.origem,
    aerodromo_chegada: body.aerodromo_chegada || pernaVinculada.destino,
    tempo_ac: horario(dadosOperacionais.acionamento_utc),
    tempo_dep: horario(dadosOperacionais.decolagem_utc),
    tempo_pou: horario(dadosOperacionais.pouso_utc),
    tempo_cor: horario(dadosOperacionais.corte_utc),
    tempo_voo: dadosOperacionais.tempo_voo,
    tempo_total: dadosOperacionais.tempo_total,
    horas_diurnas: dadosOperacionais.horas_diurnas,
    horas_noturnas: dadosOperacionais.horas_noturnas,
    pousos_total: body.pousos_total ?? (pernaVinculada.horario_pouso ? 1 : 0),
  } : body
  const row = normalizarLancamentoDiario({ ...dadosDaPerna, ...dadosOperacionais, tempo_ac: horario(dadosOperacionais.acionamento_utc), tempo_dep: horario(dadosOperacionais.decolagem_utc), tempo_pou: horario(dadosOperacionais.pouso_utc), tempo_cor: horario(dadosOperacionais.corte_utc), cliente_id: String(body.cliente_id || '').trim() || null, socio_id: String(body.socio_id || '').trim() || null, pic_nome: nomePic || body.pic_nome || perfilPic?.nome_completo || null, sic_nome: nomeSic || body.sic_nome || null, trecho, aeronave_id: aeronaveId, diario_mes_id: diarioMesId }, aeronave, { diarioMesId, sequencial: Number(last?.sequencial || 0) + 1, celula: diarioNumber(body.celula, diarioNumber(diario.celula_atual_ttotal) + diarioNumber(dadosOperacionais.tempo_total)), criadoPor: extractSupabaseUserId(c) })
  const columns = ['id', ...Object.keys(row)]
  await db.prepare(`INSERT INTO lancamentos_diario_bordo (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).bind(id, ...columns.slice(1).map(column => row[column])).run()
  const abastecimento = body.abastecimento && typeof body.abastecimento === 'object' ? body.abastecimento : null
  if (abastecimento && diarioNumber(abastecimento.litros) > 0) {
    await garantirTabelaAbastecimentos(c)
    const titularAbastecimentoCliente = diarioBoolean(body.voo_emprestado) ? (body.cliente_tomador_emprestimo_id || abastecimento.cliente_id || null) : (abastecimento.cliente_id || null)
    const titularAbastecimentoSocio = diarioBoolean(body.voo_emprestado) ? (body.socio_tomador_emprestimo_id || abastecimento.socio_id || null) : (abastecimento.socio_id || null)
    const abastecimentoLocal = await normalizarLocalAbastecimento(db, abastecimento.local || row.local_combustivel || String(body.aerodromo_partida || ''))
    if (!abastecimentoLocal) return c.json({ error: 'local_abastecimento_invalido' }, 400)
    await db.prepare(`INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, status, observacao, criado_por, lancamento_diario_id, voo_emprestado, numero_voo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), titularAbastecimentoCliente, titularAbastecimentoSocio, aeronaveId, abastecimento.data || data, abastecimento.tipo_combustivel || null, abastecimento.trecho || row.trecho, abastecimentoLocal, abastecimento.numero_comanda || null, abastecimento.numero_nf || null, diarioNumber(abastecimento.litros), diarioNumber(abastecimento.valor_unitario), diarioNumber(abastecimento.valor_total), abastecimento.status || 'pendente', abastecimento.observacao || 'Criado no Diário de Bordo', extractSupabaseUserId(c), id, diarioBoolean(body.voo_emprestado), row.numero_voo || null).run()
  }
  await recalcularDiarioMes(c, diarioMesId)
  const inserted = await db.prepare('SELECT * FROM lancamentos_diario_bordo WHERE id = ?1').bind(id).first()
  return c.json({ ...inserted, acionamento_utc: dadosOperacionais.acionamento_utc, decolagem_utc: dadosOperacionais.decolagem_utc, pouso_utc: dadosOperacionais.pouso_utc, corte_utc: dadosOperacionais.corte_utc, solar_status: dadosOperacionais.solar_status }, 201)
})

diarioBordoRoutes.patch('/api/interno/diario-bordo/lancamentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as Record<string, any>))
  const db = c.env.SHARE_DB
  const current = await db.prepare(`SELECT l.*, dm.fechado, dm.ano AS diario_ano, dm.mes AS diario_mes FROM lancamentos_diario_bordo l LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id WHERE l.id = ?1`).bind(id).first<any>()
  if (!current) return c.notFound()
  if (Number(current.fechado)) return c.json({ error: 'diario_fechado' }, 409)
  const aeronave = await db.prepare('SELECT id, consumo_combustivel FROM aeronave WHERE id = ?1').bind(current.aeronave_id).first<any>()
  const merged = { ...current, ...body, aeronave_id: current.aeronave_id, diario_mes_id: current.diario_mes_id }
  const operacionalInput: Record<string, any> = { ...merged }
  if (body.horas_noturnas === undefined) delete operacionalInput.horas_noturnas
  const dadosOperacionais = await calcularDadosOperacionais(c, operacionalInput, String(current.data_registro || '').slice(0, 10), current.aerodromo_partida)
  const perfilPic = await db.prepare('SELECT nome_completo FROM user_profiles WHERE id = ?1').bind(extractSupabaseUserId(c)).first<{ nome_completo: string | null }>()
  const [nomePic, nomeSic, trecho] = await Promise.all([nomeTripulantePorCanac(c, body.pic_canac || current.pic_canac), nomeTripulantePorCanac(c, body.sic_canac || current.sic_canac), body.aerodromo_partida || body.aerodromo_chegada ? trechoAerodromosDiario(c, body.aerodromo_partida || current.aerodromo_partida, body.aerodromo_chegada || current.aerodromo_chegada) : Promise.resolve(current.trecho)])
  const row = normalizarLancamentoDiario({ ...merged, ...dadosOperacionais, tempo_ac: dadosOperacionais.acionamento_utc?.slice(11, 16) || null, tempo_dep: dadosOperacionais.decolagem_utc?.slice(11, 16) || null, tempo_pou: dadosOperacionais.pouso_utc?.slice(11, 16) || null, tempo_cor: dadosOperacionais.corte_utc?.slice(11, 16) || null, cliente_id: body.cliente_id !== undefined ? String(body.cliente_id || '').trim() || null : current.cliente_id, socio_id: body.socio_id !== undefined ? String(body.socio_id || '').trim() || null : current.socio_id, trecho, pic_nome: nomePic || body.pic_nome || current.pic_nome || perfilPic?.nome_completo || null, sic_nome: nomeSic || body.sic_nome || current.sic_nome || null }, aeronave, { diarioMesId: current.diario_mes_id, sequencial: current.numero_sequencial, criadoPor: current.criado_por })
  const timestampsInformados = ['acionamento_utc', 'decolagem_utc', 'pouso_utc', 'corte_utc'].some(field => body[field] !== undefined)
  const camposOperacionais = ['tempo_ac', 'tempo_dep', 'tempo_pou', 'tempo_cor', 'tempo_voo', 'tempo_total', 'horas_diurnas', 'horas_noturnas', 'consumo_combustivel_voo', 'consumo_combustivel_total']
  const recalcularOperacionais = timestampsInformados || body.horas_noturnas !== undefined
  const updates = DIARIO_LANCAMENTO_FIELDS.filter(field => body[field] !== undefined || recalcularOperacionais && camposOperacionais.includes(field)).map(field => [field, row[field]] as const)
  if (body.data_registro !== undefined) updates.push(['data_registro', row.data_registro])
  if (updates.length === 0) return c.json({ error: 'nenhum_campo_informado' }, 400)
  if (body.data_registro !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.data_registro)) || String(row.data_registro).slice(0, 7) !== `${current.diario_ano || ''}-${String(current.diario_mes || '').padStart(2, '0')}`)) return c.json({ error: 'data_fora_do_mes' }, 400)
  const assignments = updates.filter(([field], index, list) => list.findIndex(([candidate]) => candidate === field) === index)
  await db.prepare(`UPDATE lancamentos_diario_bordo SET ${assignments.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`).bind(...assignments.map(([, value]) => value), id).run()
  if (body.abastecido === false || (body.abastecimento && diarioNumber(body.abastecimento.litros) <= 0)) {
    await db.prepare('DELETE FROM abastecimentos WHERE lancamento_diario_id = ?1').bind(id).run()
  } else if (body.abastecimento && diarioNumber(body.abastecimento.litros) > 0) {
    await garantirTabelaAbastecimentos(c)
    const abastecimento = body.abastecimento
    const vooEmprestadoAtual = diarioBoolean(body.voo_emprestado ?? current.voo_emprestado)
    const titularAbastecimentoCliente = vooEmprestadoAtual ? (current.cliente_tomador_emprestimo_id || abastecimento.cliente_id || null) : (abastecimento.cliente_id || null)
    const titularAbastecimentoSocio = vooEmprestadoAtual ? (current.socio_tomador_emprestimo_id || abastecimento.socio_id || null) : (abastecimento.socio_id || null)
    const existente = await db.prepare('SELECT id FROM abastecimentos WHERE lancamento_diario_id = ?1 ORDER BY date(data) DESC, id DESC LIMIT 1').bind(id).first<{ id: string }>()
    const abastecimentoLocal = await normalizarLocalAbastecimento(db, abastecimento.local || row.local_combustivel || row.aerodromo_partida)
    if (!abastecimentoLocal) return c.json({ error: 'local_abastecimento_invalido' }, 400)
    const valores = [titularAbastecimentoCliente, titularAbastecimentoSocio, current.aeronave_id, abastecimento.data || row.data_registro, abastecimento.tipo_combustivel || null, abastecimento.trecho || row.trecho, abastecimentoLocal, abastecimento.numero_comanda || null, abastecimento.numero_nf || null, diarioNumber(abastecimento.litros), diarioNumber(abastecimento.valor_unitario), diarioNumber(abastecimento.valor_total), abastecimento.status || 'pendente', abastecimento.observacao || 'Atualizado no Diário de Bordo', extractSupabaseUserId(c), diarioBoolean(body.voo_emprestado ?? current.voo_emprestado), row.numero_voo || current.numero_voo || null]
    if (existente) {
      await db.prepare('UPDATE abastecimentos SET cliente_id=?, socio_id=?, aeronave_id=?, data=?, tipo_combustivel=?, trecho=?, local=?, numero_comanda=?, numero_nf=?, litros=?, valor_unitario=?, valor_total=?, status=?, observacao=?, criado_por=?, voo_emprestado=?, numero_voo=? WHERE id=?').bind(...valores, existente.id).run()
    } else {
      await db.prepare('INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, status, observacao, criado_por, lancamento_diario_id, voo_emprestado, numero_voo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(uuid(), ...valores.slice(0, 15), id, ...valores.slice(15)).run()
    }
  }
  await recalcularDiarioMes(c, current.diario_mes_id)
  const updated = await db.prepare('SELECT * FROM lancamentos_diario_bordo WHERE id = ?1').bind(id).first()
  return c.json({ ...updated, acionamento_utc: dadosOperacionais.acionamento_utc, decolagem_utc: dadosOperacionais.decolagem_utc, pouso_utc: dadosOperacionais.pouso_utc, corte_utc: dadosOperacionais.corte_utc, solar_status: dadosOperacionais.solar_status })
})

diarioBordoRoutes.delete('/api/interno/diario-bordo/lancamentos/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id')
  const current = await c.env.SHARE_DB.prepare('SELECT l.diario_mes_id, dm.fechado FROM lancamentos_diario_bordo l LEFT JOIN diario_mes dm ON dm.id = l.diario_mes_id WHERE l.id = ?1').bind(id).first<{ diario_mes_id: string; fechado: number }>()
  if (!current) return c.notFound()
  if (Number(current.fechado)) return c.json({ error: 'diario_fechado' }, 409)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM lancamentos_diario_bordo WHERE id = ?1').bind(id).run()
  if (!result.meta.changes) return c.notFound()
  await c.env.SHARE_DB.prepare('UPDATE pernas_jornada_voo SET lancamento_diario_id = NULL WHERE lancamento_diario_id = ?1').bind(id).run()
  await recalcularDiarioMes(c, current.diario_mes_id)
  return c.json({ success: true })
})

export default diarioBordoRoutes
