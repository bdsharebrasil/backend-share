import { Context, Hono } from 'hono'
import { shareBrasilUser, type Colaborador } from '../lib/auth'
import { chaveStorageDeUrl, salvarArquivoShareBrasil, shareBrasilBucket, shareBrasilFileName } from '../lib/storage'
import { nullableText, text, uuid } from '../lib/strings'
import { usuarioTemPapel } from '../financeiro/financeiroAuth'
import type { Env } from '../types/env'

type Bindings = Pick<Env, 'SHARE_DB' | 'FILES' | 'SHARE_FILES' | 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY' | 'VITE_SUPABASE_PUBLISHABLE_KEY'>
type AppContext = Context<{ Bindings: Bindings }>
type DbRow = Record<string, unknown>
type ResultadoAutorizacao = { autorizado: true; user: Colaborador } | { autorizado: false; response: Response }

export const gestorContratosRoutes = new Hono<{ Bindings: Bindings }>()

const papeisPermitidos = ['admin', 'administrador', 'gestor_master', 'gestormaster'] as const
const statusPermitidos = ['RASCUNHO', 'EM_REVISAO', 'ENVIADO', 'ASSINADO', 'EM_VIGENCIA', 'CONCLUIDO', 'RESCINDIDO', 'CANCELADO'] as const

async function exigirGestor(c: AppContext): Promise<ResultadoAutorizacao> {
  const user = await shareBrasilUser(c)
  if (!user) return { autorizado: false, response: c.json({ error: 'nao_autorizado' }, 401) }
  if (!await usuarioTemPapel(c.env.SHARE_DB, user.id, papeisPermitidos)) {
    return { autorizado: false, response: c.json({ error: 'gestor_contratos_nao_autorizado' }, 403) }
  }
  return { autorizado: true, user }
}

function parseObjeto(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return { texto_contrato: value } }
}

function parseArray(value: unknown): DbRow[] {
  if (Array.isArray(value)) return value as DbRow[]
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as DbRow[] : []
  } catch { return [] }
}

const selectContrato = `
  SELECT c.id, c.numero, c.tipo, c.titulo, c.descricao, c.status, c.valor_centavos, c.moeda,
         c.forma_pagamento, c.data_assinatura, c.data_inicio, c.data_fim, c.aeronave_id,
         c.dados_adicionais, c.documento_url, c.foro, c.observacoes, c.criado_por, c.criado_em, c.atualizado_em,
         (SELECT json_group_array(json_object(
           'id', p.id, 'papel', p.papel, 'tipo_pessoa', p.tipo_pessoa, 'nome', p.nome,
           'documento', p.documento, 'email', p.email, 'telefone', p.telefone, 'endereco', p.endereco,
           'representante_nome', p.representante_nome, 'representante_documento', p.representante_documento,
           'representante_cargo', p.representante_cargo, 'dados_adicionais', p.dados_adicionais,
           'assinou_em', p.assinou_em, 'ordem', p.ordem
         )) FROM contrato_partes p WHERE p.contrato_id = c.id) AS partes_json,
         (SELECT json_group_array(json_object(
           'id', a.id, 'nome', a.nome, 'tipo', a.tipo
         )) FROM contrato_anexos a WHERE a.contrato_id = c.id) AS anexos_json
    FROM contratos c`

function normalizarContrato(row: DbRow) {
  const id = String(row.id ?? '')
  const partes = parseArray(row.partes_json).map((parte) => ({
    ...parte,
    dados_adicionais: parseObjeto(parte.dados_adicionais),
  }))
  const anexos = parseArray(row.anexos_json).map((anexo) => ({
    id: String(anexo.id ?? ''),
    nome: String(anexo.nome ?? ''),
    tipo: anexo.tipo == null ? null : String(anexo.tipo),
    arquivo_url: `/api/gestor/contratos/${encodeURIComponent(id)}/anexos/${encodeURIComponent(String(anexo.id ?? ''))}`,
  }))
  return { ...row, dados_adicionais: parseObjeto(row.dados_adicionais), partes, anexos }
}

async function buscarContrato(db: D1Database, id: string) {
  const row = await db.prepare(`${selectContrato} WHERE c.id = ?1`).bind(id).first<DbRow>()
  return row ? normalizarContrato(row) : null
}

function prepararPartes(valor: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(valor) || valor.length < 2 || valor.length > 20) return null
  const partes = valor.map((item, index) => {
    const parte = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const tipoPessoa = text(parte.tipo_pessoa).toUpperCase() === 'JURIDICA' ? 'JURIDICA' : 'FISICA'
    const dados = parte.dados_adicionais && typeof parte.dados_adicionais === 'object' && !Array.isArray(parte.dados_adicionais)
      ? JSON.stringify(parte.dados_adicionais)
      : null
    return {
      id: nullableText(parte.id) || uuid(),
      papel: text(parte.papel) || (index === 0 ? 'CONTRATANTE' : 'CONTRATADA'),
      tipo_pessoa: tipoPessoa,
      nome: text(parte.nome),
      documento: nullableText(parte.documento),
      email: nullableText(parte.email),
      telefone: nullableText(parte.telefone),
      endereco: nullableText(parte.endereco),
      representante_nome: nullableText(parte.representante_nome),
      representante_documento: nullableText(parte.representante_documento),
      representante_cargo: nullableText(parte.representante_cargo),
      dados_adicionais: dados,
      assinou_em: nullableText(parte.assinou_em),
      ordem: Number.isSafeInteger(Number(parte.ordem)) ? Number(parte.ordem) : index,
    }
  })
  return partes.every((parte) => parte.nome) ? partes : null
}

function valoresContrato(body: Record<string, unknown>) {
  const tipo = text(body.tipo)
  const titulo = text(body.titulo)
  const status = text(body.status || 'RASCUNHO').toUpperCase()
  const moeda = text(body.moeda || 'BRL').toUpperCase()
  const valor = body.valor_centavos == null || body.valor_centavos === '' ? null : Number(body.valor_centavos)
  const partes = prepararPartes(body.partes)
  if (!tipo || tipo.length > 80 || !titulo || titulo.length > 240) return { erro: 'tipo_e_titulo_obrigatorios' as const }
  if (!statusPermitidos.includes(status as typeof statusPermitidos[number])) return { erro: 'status_contrato_invalido' as const }
  if (!/^[A-Z]{3}$/.test(moeda)) return { erro: 'moeda_invalida' as const }
  if (valor !== null && (!Number.isSafeInteger(valor) || valor < 0)) return { erro: 'valor_centavos_invalido' as const }
  if (!partes) return { erro: 'partes_obrigatorias' as const }
  const extras = body.dados_adicionais && typeof body.dados_adicionais === 'object' && !Array.isArray(body.dados_adicionais)
    ? body.dados_adicionais as Record<string, unknown>
    : {}
  return {
    tipo, titulo, status, moeda, valor, partes,
    numero: nullableText(body.numero),
    descricao: nullableText(body.descricao),
    formaPagamento: nullableText(body.forma_pagamento),
    dataAssinatura: nullableText(body.data_assinatura),
    dataInicio: nullableText(body.data_inicio),
    dataFim: nullableText(body.data_fim),
    foro: nullableText(body.foro),
    observacoes: nullableText(body.observacoes),
    dadosAdicionais: JSON.stringify(extras),
  }
}

async function salvarContrato(c: AppContext, user: Colaborador, body: Record<string, unknown>, id?: string) {
  const dados = valoresContrato(body)
  if ('erro' in dados) return c.json({ error: dados.erro }, 400)
  const db = c.env.SHARE_DB
  const contratoId = id || uuid()
  if (id) {
    const existente = await db.prepare('SELECT id FROM contratos WHERE id = ?').bind(id).first()
    if (!existente) return c.json({ error: 'contrato_nao_encontrado' }, 404)
  }
  const partes = dados.partes
  const extras = parseObjeto(dados.dadosAdicionais)
  const cotistaVinculado = String(extras.tipo_vinculo || '').toUpperCase() === 'COTISTA' ? nullableText(extras.cotista_id) : null
  const comandosPartes = [
    ...(id ? [db.prepare('DELETE FROM contrato_partes WHERE contrato_id = ?').bind(id)] : []),
    ...(id ? [db.prepare('UPDATE contrato_cotista SET cotista_id = ? WHERE id IN (SELECT id FROM contrato_anexos WHERE contrato_id = ?)').bind(cotistaVinculado, id)] : []),
    ...partes.map((parte) => db.prepare(`INSERT INTO contrato_partes (id, contrato_id, papel, tipo_pessoa, nome, documento, email, telefone, endereco, representante_nome, representante_documento, representante_cargo, dados_adicionais, assinou_em, ordem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(parte.id, contratoId, parte.papel, parte.tipo_pessoa, parte.nome, parte.documento, parte.email, parte.telefone, parte.endereco, parte.representante_nome, parte.representante_documento, parte.representante_cargo, parte.dados_adicionais, parte.assinou_em, parte.ordem)),
  ]
  const comandoContrato = id
    ? db.prepare(`UPDATE contratos SET numero = ?, tipo = ?, titulo = ?, descricao = ?, status = ?, valor_centavos = ?, moeda = ?, forma_pagamento = ?, data_assinatura = ?, data_inicio = ?, data_fim = ?, dados_adicionais = ?, foro = ?, observacoes = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(dados.numero, dados.tipo, dados.titulo, dados.descricao, dados.status, dados.valor, dados.moeda, dados.formaPagamento, dados.dataAssinatura, dados.dataInicio, dados.dataFim, dados.dadosAdicionais, dados.foro, dados.observacoes, id)
    : db.prepare(`INSERT INTO contratos (id, numero, tipo, titulo, descricao, status, valor_centavos, moeda, forma_pagamento, data_assinatura, data_inicio, data_fim, dados_adicionais, foro, observacoes, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(contratoId, dados.numero, dados.tipo, dados.titulo, dados.descricao, dados.status, dados.valor, dados.moeda, dados.formaPagamento, dados.dataAssinatura, dados.dataInicio, dados.dataFim, dados.dadosAdicionais, dados.foro, dados.observacoes, user.id)
  try {
    await db.batch([comandoContrato, ...comandosPartes])
  } catch (error) {
    if (String(error).toLowerCase().includes('unique') && dados.numero) return c.json({ error: 'numero_contrato_ja_cadastrado' }, 409)
    throw error
  }
  return c.json({ id: contratoId, success: true }, id ? 200 : 201)
}

gestorContratosRoutes.get('/opcoes', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const db = c.env.SHARE_DB
  const [empresa, colaboradores, cotistas] = await Promise.all([
    db.prepare('SELECT id, razao_social, cnpj, endereco FROM empresa ORDER BY criado_em, id LIMIT 1').first<DbRow>(),
    db.prepare(`SELECT p.id, COALESCE(p.nome_exibicao, p.nome_completo) AS nome, p.email, p.cpf, p.rg, p.canac, p.telefone, p.endereco, p.cidade, p.uf, ct.id AS contratos_trabalho_id, ct.cargo
      FROM user_profiles p
      LEFT JOIN contratos_trabalho ct ON ct.id = (
        SELECT ct2.id FROM contratos_trabalho ct2 WHERE ct2.user_id = p.id AND ct2.status IN ('ATIVO', 'SUSPENSO') ORDER BY ct2.data_inicio DESC, ct2.criado_em DESC LIMIT 1
      )
      WHERE lower(COALESCE(p.tipo_user, 'colaborador')) = 'colaborador' AND (p.status IS NULL OR lower(p.status) IN ('ativo', 'active'))
      ORDER BY COALESCE(p.nome_exibicao, p.nome_completo), p.email`).all<DbRow>(),
    db.prepare(`SELECT hs.id, hs.cotista_id, hs.nome, hs.cpf, hs.email_principal AS email, hs.telefone, hs.endereco, hs.cidade, hs.uf,
      (SELECT cl.razao_social FROM cotista_aeronave ca JOIN cliente cl ON cl.id = ca.cliente_id WHERE ca.id = hs.cotista_id LIMIT 1) AS empresa
      FROM hold_socios hs ORDER BY hs.nome`).all<DbRow>(),
  ])
  return c.json({ empresa: empresa || null, colaboradores: colaboradores.results || [], cotistas: cotistas.results || [] })
})

gestorContratosRoutes.get('/', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const result = await c.env.SHARE_DB.prepare(`${selectContrato} ORDER BY c.atualizado_em DESC, c.criado_em DESC`).all<DbRow>()
  return c.json((result.results || []).map(normalizarContrato))
})

gestorContratosRoutes.get('/:id', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const contrato = await buscarContrato(c.env.SHARE_DB, c.req.param('id'))
  if (!contrato) return c.json({ error: 'contrato_nao_encontrado' }, 404)
  return c.json(contrato)
})

gestorContratosRoutes.post('/', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  return salvarContrato(c, auth.user, body)
})

gestorContratosRoutes.put('/:id', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  return salvarContrato(c, auth.user, body, c.req.param('id'))
})

gestorContratosRoutes.post('/:id/anexos', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const contratoId = c.req.param('id')
  const db = c.env.SHARE_DB
  const contrato = await db.prepare('SELECT id, numero, titulo, dados_adicionais FROM contratos WHERE id = ?').bind(contratoId).first<DbRow>()
  if (!contrato) return c.json({ error: 'contrato_nao_encontrado' }, 404)
  const form = await c.req.parseBody()
  const arquivo = form.arquivo
  if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const extensao = arquivo.name.split('.').pop()?.toLowerCase() || ''
  if (!['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp'].includes(extensao)) return c.json({ error: 'tipo_arquivo_nao_permitido' }, 400)
  if (!arquivo.size || arquivo.size > 25 * 1024 * 1024) return c.json({ error: 'arquivo_invalido_ou_maior_que_25mb' }, 400)
  let caminho = ''
  try {
    caminho = await salvarArquivoShareBrasil(c, auth.user.id, arquivo, 'contratos')
    const anexoId = uuid()
    const tipo = nullableText(form.tipo) || 'ANEXO'
    const statements = [db.prepare('INSERT INTO contrato_anexos (id, contrato_id, nome, tipo, url) VALUES (?, ?, ?, ?, ?)').bind(anexoId, contratoId, arquivo.name.slice(0, 240), tipo, caminho)]
    const dadosAdicionais = parseObjeto(contrato.dados_adicionais)
    if (String(dadosAdicionais.tipo_vinculo || '').toUpperCase() === 'COTISTA' && text(dadosAdicionais.cotista_id)) {
      const cotistaId = text(dadosAdicionais.cotista_id)
      const urlProtegida = `/api/gestor/contratos/${encodeURIComponent(contratoId)}/anexos/${encodeURIComponent(anexoId)}`
      const descricao = `Anexo do contrato ${text(contrato.numero) || text(contrato.titulo)}`.slice(0, 240)
      statements.push(db.prepare(`INSERT INTO contrato_cotista (id, nome_arquivo, caminho_arquivo, tamanho_arquivo, descricao, url_publica, enviado_por, enviado_em, criado_em, atualizado_em, cotista_id) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`)
        .bind(anexoId, arquivo.name.slice(0, 240), caminho, arquivo.size, descricao, urlProtegida, auth.user.id, cotistaId))
    }
    await db.batch(statements)
    return c.json({ id: anexoId, nome: arquivo.name, tipo, success: true }, 201)
  } catch (error) {
    if (caminho) await shareBrasilBucket(c).delete(caminho).catch(() => undefined)
    throw error
  }
})

gestorContratosRoutes.get('/:id/anexos/:anexoId', async (c) => {
  const auth = await exigirGestor(c)
  if (!auth.autorizado) return auth.response
  const anexo = await c.env.SHARE_DB.prepare('SELECT nome, url FROM contrato_anexos WHERE id = ? AND contrato_id = ?').bind(c.req.param('anexoId'), c.req.param('id')).first<{ nome: string; url: string }>()
  if (!anexo) return c.notFound()
  const key = chaveStorageDeUrl(anexo.url)
  const objeto = key ? await shareBrasilBucket(c).get(key) : null
  if (!objeto) return c.notFound()
  const nomeArquivo = shareBrasilFileName(anexo.nome || 'anexo')
  return new Response(objeto.body, { headers: {
    'Content-Type': objeto.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } })
})
