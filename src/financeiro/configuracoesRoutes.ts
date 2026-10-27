import { Hono } from 'hono'
import { errorResponse } from './errorResponse'
import { listar } from './repositories/d1'

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }

export const configuracoesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const CONFIG_TABLES = {
  fornecedores: 'fornecedores_favoritos',
  contas_bancarias: 'contas_bancarias',
  categorias_share: 'categoria_movimentacao_share',
  categorias_cliente: 'categoria_movimentacao_cliente',
} as const

const configId = () => crypto.randomUUID()
const configText = (value: unknown, fallback = '') => String(value ?? fallback).trim()

configuracoesRoutes.get('/configuracoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [fornecedores, contas, categoriasShare, categoriasCliente] = await Promise.all([
      listar(db, 'SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo) COLLATE NOCASE'),
      listar(db, 'SELECT * FROM contas_bancarias ORDER BY banco COLLATE NOCASE, nome COLLATE NOCASE'),
      listar(db, 'SELECT * FROM categoria_movimentacao_share ORDER BY nome COLLATE NOCASE'),
      listar(db, 'SELECT * FROM categoria_movimentacao_cliente ORDER BY nome COLLATE NOCASE'),
    ])
    return c.json({ fornecedores, contas_bancarias: contas, categorias_share: categoriasShare, categorias_cliente: categoriasCliente })
  } catch (error) { return errorResponse(c, error) }
})

configuracoesRoutes.post('/configuracoes/:tipo', async (c) => {
  try {
    const table = CONFIG_TABLES[c.req.param('tipo') as keyof typeof CONFIG_TABLES]
    if (!table) return c.json({ error: 'tipo_configuracao_invalido' }, 400)
    const body = await c.req.json<Record<string, unknown>>()
    const id = configText(body.id) || configId()
    const userId = c.get('userId') || null
    let columns: string[]
    let values: unknown[]
    if (table === 'fornecedores_favoritos') {
      const nome = configText(body.nome_completo ?? body.nome)
      if (!nome) return c.json({ error: 'nome_fornecedor_obrigatorio' }, 400)
      columns = ['id', 'nome_completo', 'apelido', 'documento', 'telefone', 'endereco', 'cidade', 'uf', 'pessoa_contato', 'categoria_fornecedor']
      values = [id, nome, configText(body.apelido) || null, configText(body.documento) || null, configText(body.telefone) || null, configText(body.endereco) || null, configText(body.cidade) || null, configText(body.uf) || null, configText(body.pessoa_contato) || null, configText(body.categoria_fornecedor, 'nenhum')]
    } else if (table === 'contas_bancarias') {
      const banco = configText(body.banco)
      const nome = configText(body.nome || body.razao_social, banco)
      if (!banco || !nome) return c.json({ error: 'banco_e_nome_obrigatorios' }, 400)
      columns = ['id', 'razao_social', 'cnpj', 'chave_pix', 'nome', 'banco', 'numero_conta', 'tipo_caixa', 'cliente_id', 'holding_id', 'ativo']
      values = [id, configText(body.razao_social, nome), configText(body.cnpj, 'NAO_INFORMADO'), configText(body.chave_pix, 'NAO_INFORMADO'), nome, banco, configText(body.numero_conta) || null, configText(body.tipo_caixa, 'SHARE').toUpperCase(), configText(body.cliente_id) || null, configText(body.holding_id) || null, body.ativo === false ? 0 : 1]
    } else if (table === 'categoria_movimentacao_share') {
      const nome = configText(body.nome)
      if (!nome) return c.json({ error: 'nome_categoria_obrigatorio' }, 400)
      columns = ['id', 'nome', 'tipo', 'grupo_categoria', 'tipo_despesa', 'reembolsavel', 'categoria_cliente_id', 'criado_por']
      values = [id, nome, configText(body.tipo).toLowerCase() || null, configText(body.grupo_categoria) || null, configText(body.tipo_despesa) || null, body.reembolsavel ? 1 : 0, configText(body.categoria_cliente_id) || null, userId]
    } else {
      const nome = configText(body.nome)
      if (!nome) return c.json({ error: 'nome_categoria_obrigatorio' }, 400)
      columns = ['id', 'nome', 'subcategoria_1', 'subcategoria_2', 'subcategoria_3', 'subcategoria_4']
      values = [id, nome, configText(body.subcategoria_1) || null, configText(body.subcategoria_2) || null, configText(body.subcategoria_3) || null, configText(body.subcategoria_4) || null]
    }
    const placeholders = columns.map(() => '?').join(', ')
    await c.env.SHARE_DB.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((column) => `${column} = excluded.${column}`).join(', ')}`).bind(...values).run()
    const saved = await c.env.SHARE_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
    return c.json({ item: saved }, 201)
  } catch (error) { return errorResponse(c, error) }
})

configuracoesRoutes.get('/fornecedores-combustivel', async (c) => {
  try {
    const fornecedores = await listar(c.env.SHARE_DB, 'SELECT * FROM fornecedores_combustivel ORDER BY nome_cidade COLLATE NOCASE, nome_fornecedor COLLATE NOCASE')
    return c.json(fornecedores)
  } catch (error) { return errorResponse(c, error) }
})

configuracoesRoutes.post('/fornecedores-combustivel', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>()
    const nomeFornecedor = configText(body.nome_fornecedor ?? body.nome)
    if (!nomeFornecedor) return c.json({ error: 'nome_fornecedor_obrigatorio' }, 400)
    const id = configText(body.id) || configId()
    const columns = ['id', 'nome_cidade', 'codigo_icao', 'nome_fornecedor', 'pessoa_contato', 'telefone']
    // nome_cidade é NOT NULL no schema; quando não informado, usa o próprio nome do fornecedor.
    const values: unknown[] = [
      id,
      configText(body.nome_cidade) || nomeFornecedor,
      configText(body.codigo_icao) || null,
      nomeFornecedor,
      configText(body.pessoa_contato) || null,
      configText(body.telefone) || null,
    ]
    const placeholders = columns.map(() => '?').join(', ')
    await c.env.SHARE_DB.prepare(`INSERT INTO fornecedores_combustivel (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((column) => `${column} = excluded.${column}`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP`).bind(...values).run()
    const saved = await c.env.SHARE_DB.prepare('SELECT * FROM fornecedores_combustivel WHERE id = ?').bind(id).first()
    return c.json({ item: saved }, 201)
  } catch (error) { return errorResponse(c, error) }
})

configuracoesRoutes.get('/fornecedores-favoritos', async (c) => {
  try {
    const fornecedores = await listar(c.env.SHARE_DB, 'SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo) COLLATE NOCASE, nome_completo COLLATE NOCASE')
    return c.json(fornecedores)
  } catch (error) { return errorResponse(c, error) }
})

configuracoesRoutes.delete('/configuracoes/:tipo/:id', async (c) => {
  try {
    const table = CONFIG_TABLES[c.req.param('tipo') as keyof typeof CONFIG_TABLES]
    if (!table) return c.json({ error: 'tipo_configuracao_invalido' }, 400)
    const result = await c.env.SHARE_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'configuracao_nao_encontrada' }, 404)
    return c.json({ ok: true })
  } catch (error) { return errorResponse(c, error) }
})
