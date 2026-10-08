import { Context, Hono } from 'hono'
import { extractSupabaseUserId, requireShareInternal } from '../lib/auth'
import { validateWorkerSchema } from '../lib/schema'
import { salvarArquivoShareBrasil, shareBrasilBucket, shareBrasilFileName } from '../lib/storage'

type Bindings = {
  SHARE_DB: D1Database
  INTERNAL_TOKEN?: string
  CACHE_KV?: KVNamespace
  RATE_LIMITER?: DurableObjectNamespace
  FILES: R2Bucket
  SHARE_FILES?: R2Bucket
}
type Variables = Record<string, never>
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

export const abastecimentosRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

async function garantirTabelaAbastecimentos(c: AppContext) {
  await validateWorkerSchema(c, [{ table: 'abastecimentos', columns: ['id', 'cliente_id', 'socio_id', 'aeronave_id', 'data', 'tipo_combustivel', 'trecho', 'local', 'numero_comanda', 'numero_nf', 'litros', 'valor_unitario', 'valor_total', 'desconto', 'fornecedor_id', 'status', 'observacao', 'criado_por', 'lancamento_diario_id', 'voo_emprestado', 'numero_voo', 'prazo_envio_cliente', 'rateio_entre_cotistas', 'atualizado_em'] }])
}

async function garantirTabelaFornecedoresCombustivel(c: AppContext) {
  await validateWorkerSchema(c, [{ table: 'fornecedores_combustivel', columns: ['id', 'nome_fornecedor', 'codigo_icao', 'preco_jet', 'preco_avgas'] }])
}

async function normalizarLocalAbastecimento(db: D1Database, valor: unknown): Promise<string | null> {
  const local = String(valor ?? '').trim()
  if (!local) return null
  const aerodromo = await db.prepare('SELECT designativo_icao FROM aerodromo WHERE id = ?1 OR upper(trim(designativo_icao)) = upper(trim(?1)) LIMIT 1').bind(local).first<{ designativo_icao: string }>()
  return aerodromo?.designativo_icao?.trim().toUpperCase() || null
}

const texto = (value: unknown) => String(value ?? '').trim() || null
const numero = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
const booleano = (value: unknown) => value === true || value === 1 || ['1', 'true', 'sim', 'yes'].includes(String(value ?? '').toLowerCase())

async function validarAcesso(c: AppContext) {
  return requireShareInternal(c)
}

abastecimentosRoutes.get('/api/interno/abastecimentos/opcoes', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  await garantirTabelaFornecedoresCombustivel(c)
  const db = c.env.SHARE_DB
  const aeronaveId = texto(c.req.query('aeronave_id'))
  const [clientes, socios, aeronaves, fornecedores, aerodromos, diarios] = await Promise.all([
    db.prepare('SELECT id, razao_social AS nome, codigo_cliente FROM cliente ORDER BY razao_social').all(),
    db.prepare('SELECT id, nome FROM hold_socios ORDER BY nome').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, status FROM aeronave ORDER BY matricula_registro').all(),
    db.prepare('SELECT id, nome_fornecedor, codigo_icao, nome_cidade, pessoa_contato, telefone, preco_avgas, preco_jet FROM fornecedores_combustivel ORDER BY nome_fornecedor').all(),
    db.prepare('SELECT id, nome, designativo_icao FROM aerodromo ORDER BY designativo_icao').all(),
    db.prepare(`SELECT id, aeronave_id, ano, mes, fechado, celula_atual_ttotal, celula_prox_revisao_ttotal FROM diario_mes WHERE (?1 IS NULL OR aeronave_id = ?1) ORDER BY ano DESC, mes DESC`).bind(aeronaveId).all(),
  ])
  return c.json({ clientes: clientes.results, socios: socios.results, aeronaves: aeronaves.results, fornecedores: fornecedores.results, aerodromos: aerodromos.results, diarios: diarios.results })
})

abastecimentosRoutes.get('/api/interno/abastecimentos', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const db = c.env.SHARE_DB
  const inicio = texto(c.req.query('inicio'))
  const fim = texto(c.req.query('fim'))
  const aeronaveId = texto(c.req.query('aeronave_id'))
  const fornecedorId = texto(c.req.query('fornecedor_id'))
  const status = texto(c.req.query('status'))
  const busca = texto(c.req.query('busca'))
  const conditions = ['1 = 1']
  const binds: unknown[] = []
  const add = (condition: string, value: unknown) => { conditions.push(condition); binds.push(value) }
  if (inicio) add('date(a.data) >= date(?)', inicio)
  if (fim) add('date(a.data) <= date(?)', fim)
  if (aeronaveId) add('a.aeronave_id = ?', aeronaveId)
  if (fornecedorId) add('a.fornecedor_id = ?', fornecedorId)
  if (status) add('lower(a.status) = lower(?)', status)
  if (busca) { const termo = `%${busca}%`; conditions.push('(lower(COALESCE(a.trecho, \'\')) LIKE lower(?) OR lower(COALESCE(a.local, \'\')) LIKE lower(?) OR lower(COALESCE(a.numero_comanda, \'\')) LIKE lower(?) OR lower(COALESCE(a.numero_nf, \'\')) LIKE lower(?))'); binds.push(termo, termo, termo, termo) }
  const query = `SELECT a.* FROM abastecimentos a WHERE ${conditions.join(' AND ')} ORDER BY date(a.data) DESC, a.id DESC`
  const result = await db.prepare(query).bind(...binds).all()
  return c.json({ abastecimentos: result.results, resumo_mensal: [] })
})

abastecimentosRoutes.post('/api/interno/abastecimentos', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>
  const db = c.env.SHARE_DB
  const local = await normalizarLocalAbastecimento(db, body.local)
  const litros = numero(body.litros)
  const valorUnitario = numero(body.valor_unitario)
  if (!body.aeronave_id || !body.data || !local || litros <= 0 || valorUnitario < 0) return c.json({ error: 'abastecimento_incompleto' }, 400)
  const id = crypto.randomUUID()
  const desconto = numero(body.desconto)
  const valorTotal = Math.max(0, numero(body.valor_total) || litros * valorUnitario - desconto)
  await db.prepare(`INSERT INTO abastecimentos (id, cliente_id, socio_id, aeronave_id, data, tipo_combustivel, trecho, local, numero_comanda, numero_nf, litros, valor_unitario, valor_total, desconto, fornecedor_id, status, observacao, criado_por, lancamento_diario_id, voo_emprestado, numero_voo, prazo_envio_cliente, rateio_entre_cotistas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, texto(body.cliente_id), texto(body.socio_id), body.aeronave_id, body.data, texto(body.tipo_combustivel), texto(body.trecho), local, texto(body.numero_comanda), texto(body.numero_nf), litros, valorUnitario, valorTotal, desconto, texto(body.fornecedor_id), texto(body.status) || 'pendente', texto(body.observacao), extractSupabaseUserId(c), texto(body.lancamento_diario_id), booleano(body.voo_emprestado) ? 1 : 0, texto(body.numero_voo), texto(body.prazo_envio_cliente), booleano(body.rateio_entre_cotistas) ? 1 : 0).run()
  return c.json({ id, success: true }, 201)
})

const camposAbastecimento = ['cliente_id', 'socio_id', 'aeronave_id', 'data', 'tipo_combustivel', 'trecho', 'local', 'numero_comanda', 'numero_nf', 'litros', 'valor_unitario', 'valor_total', 'desconto', 'fornecedor_id', 'status', 'observacao', 'lancamento_diario_id', 'voo_emprestado', 'numero_voo', 'prazo_envio_cliente', 'rateio_entre_cotistas'] as const

abastecimentosRoutes.patch('/api/interno/abastecimentos/:id', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>
  const updates: Array<[string, unknown]> = []
  for (const campo of camposAbastecimento) if (body[campo] !== undefined) updates.push([campo, campo === 'local' ? await normalizarLocalAbastecimento(c.env.SHARE_DB, body[campo]) : campo === 'voo_emprestado' || campo === 'rateio_entre_cotistas' ? (booleano(body[campo]) ? 1 : 0) : campo === 'litros' || campo === 'valor_unitario' || campo === 'valor_total' || campo === 'desconto' ? numero(body[campo]) : body[campo]])
  if (!updates.length) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const result = await c.env.SHARE_DB.prepare(`UPDATE abastecimentos SET ${updates.map(([campo]) => `${campo} = ?`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(...updates.map(([, valor]) => valor), id).run()
  if (!result.meta.changes) return c.json({ error: 'abastecimento_nao_encontrado' }, 404)
  return c.json({ id, success: true })
})

abastecimentosRoutes.delete('/api/interno/abastecimentos/:id', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const id = c.req.param('id')
  const result = await c.env.SHARE_DB.prepare('DELETE FROM abastecimentos WHERE id = ?').bind(id).run()
  if (!result.meta.changes) return c.json({ error: 'abastecimento_nao_encontrado' }, 404)
  return c.json({ success: true })
})

abastecimentosRoutes.post('/api/interno/abastecimentos/fornecedores', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaFornecedoresCombustivel(c)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>
  if (!texto(body.nome_fornecedor)) return c.json({ error: 'fornecedor_nome_obrigatorio' }, 400)
  const id = crypto.randomUUID()
  await c.env.SHARE_DB.prepare('INSERT INTO fornecedores_combustivel (id, nome_cidade, codigo_icao, nome_fornecedor, pessoa_contato, telefone, preco_avgas, preco_jet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, texto(body.nome_cidade), texto(body.codigo_icao)?.toUpperCase(), texto(body.nome_fornecedor), texto(body.pessoa_contato), texto(body.telefone), body.preco_avgas == null ? null : numero(body.preco_avgas), body.preco_jet == null ? null : numero(body.preco_jet)).run()
  return c.json({ id, success: true }, 201)
})

abastecimentosRoutes.patch('/api/interno/abastecimentos/fornecedores/:id', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaFornecedoresCombustivel(c)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>
  const fields = ['nome_cidade', 'codigo_icao', 'nome_fornecedor', 'pessoa_contato', 'telefone', 'preco_avgas', 'preco_jet'] as const
  const updates = fields.filter((field) => body[field] !== undefined).map((field) => `${field} = ?`)
  const values = fields.filter((field) => body[field] !== undefined).map((field) => field.startsWith('preco_') ? (body[field] == null ? null : numero(body[field])) : field === 'codigo_icao' ? texto(body[field])?.toUpperCase() : texto(body[field]))
  if (!updates.length) return c.json({ error: 'nenhum_campo_informado' }, 400)
  const result = await c.env.SHARE_DB.prepare(`UPDATE fornecedores_combustivel SET ${updates.join(', ')} WHERE id = ?`).bind(...values, c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'fornecedor_nao_encontrado' }, 404)
  return c.json({ id: c.req.param('id'), success: true })
})

abastecimentosRoutes.delete('/api/interno/abastecimentos/fornecedores/:id', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaFornecedoresCombustivel(c)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM fornecedores_combustivel WHERE id = ?').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'fornecedor_nao_encontrado' }, 404)
  return c.json({ success: true })
})

const tiposArquivo = { comanda: 'comanda_url', nota: 'nota_url', boleto: 'boleto_url', comprovante: 'comprovante_url' } as const

abastecimentosRoutes.post('/api/interno/abastecimentos/:id/arquivo', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const id = c.req.param('id')
  const form = await c.req.parseBody()
  const tipo = String(form.tipo || '') as keyof typeof tiposArquivo
  const arquivo = form.arquivo instanceof File ? form.arquivo : null
  if (!tiposArquivo[tipo] || !arquivo || arquivo.size <= 0) return c.json({ error: 'arquivo_invalido' }, 400)
  const existente = await c.env.SHARE_DB.prepare('SELECT id FROM abastecimentos WHERE id = ?').bind(id).first()
  if (!existente) return c.json({ error: 'abastecimento_nao_encontrado' }, 404)
  const caminho = await salvarArquivoShareBrasil(c, extractSupabaseUserId(c) || 'abastecimento', arquivo, `abastecimentos/${id}`)
  await c.env.SHARE_DB.prepare(`UPDATE abastecimentos SET ${tiposArquivo[tipo]} = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(caminho, id).run()
  return c.json({ success: true, caminho_arquivo: caminho })
})

abastecimentosRoutes.get('/api/interno/abastecimentos/:id/arquivo/:tipo', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  const tipo = c.req.param('tipo') as keyof typeof tiposArquivo
  if (!tiposArquivo[tipo]) return c.json({ error: 'tipo_arquivo_invalido' }, 400)
  const row = await c.env.SHARE_DB.prepare(`SELECT ${tiposArquivo[tipo]} AS caminho FROM abastecimentos WHERE id = ?`).bind(c.req.param('id')).first<{ caminho: string | null }>()
  if (!row?.caminho) return c.notFound()
  const object = await shareBrasilBucket(c).get(row.caminho)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': `inline; filename="${shareBrasilFileName(`${tipo}-${c.req.param('id')}`)}"`, 'Cache-Control': 'private, max-age=3600' } })
})

abastecimentosRoutes.get('/api/interno/abastecimentos/precos', async c => {
  if (!(await validarAcesso(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  await garantirTabelaFornecedoresCombustivel(c)
  const icao = String(c.req.query('icao') || '').trim().toUpperCase()
  const tipo = String(c.req.query('tipo_combustivel') || '').trim().toUpperCase()
  if (!/^[A-Z]{4}$/.test(icao)) return c.json({ error: 'icao_invalido' }, 400)
  const colunaPreco = /JET|JETA|JET_A1|JET-A1/.test(tipo) ? 'preco_jet' : 'preco_avgas'
  const db = c.env.SHARE_DB
  const [fornecedores, historico] = await Promise.all([
    db.prepare(`SELECT id, nome_fornecedor AS fornecedor, codigo_icao, ${colunaPreco} AS valor_unitario, 'fornecedor_cadastrado' AS origem FROM fornecedores_combustivel WHERE upper(COALESCE(codigo_icao, '')) = ?1 AND COALESCE(${colunaPreco}, 0) > 0 ORDER BY valor_unitario`).bind(icao).all(),
    db.prepare(`SELECT a.id, a.data, a.tipo_combustivel, a.local, a.valor_unitario, a.litros, f.nome_fornecedor AS fornecedor, 'abastecimento_historico' AS origem FROM abastecimentos a LEFT JOIN fornecedores_combustivel f ON f.id = a.fornecedor_id WHERE (upper(COALESCE(a.local, '')) = ?1 OR upper(COALESCE(a.trecho, '')) LIKE ?2) AND (?3 = '' OR upper(COALESCE(a.tipo_combustivel, '')) LIKE ?4) AND COALESCE(a.valor_unitario, 0) > 0 ORDER BY date(a.data) DESC, a.criado_em DESC LIMIT 20`).bind(icao, `%${icao}%`, tipo, `%${tipo}%`).all(),
  ])
  return c.json({ icao, tipo_combustivel: tipo || null, fornecedores: fornecedores.results, historico: historico.results, source: 'controle_abastecimento' })
})

export { normalizarLocalAbastecimento, garantirTabelaAbastecimentos, garantirTabelaFornecedoresCombustivel }
