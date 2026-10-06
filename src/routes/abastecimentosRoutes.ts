import { Context, Hono } from 'hono'
import { requireShareInternal } from '../lib/auth'
import { validateWorkerSchema } from '../lib/schema'

type Bindings = {
  SHARE_DB: D1Database
  INTERNAL_TOKEN?: string
  CACHE_KV?: KVNamespace
  RATE_LIMITER?: DurableObjectNamespace
}

type Variables = Record<string, never>

export const abastecimentosRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

async function garantirTabelaAbastecimentos(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  await validateWorkerSchema(c, [{
    table: 'abastecimentos',
    columns: ['id', 'cliente_id', 'socio_id', 'aeronave_id', 'data', 'tipo_combustivel', 'trecho', 'local', 'numero_comanda', 'numero_nf', 'litros', 'valor_unitario', 'valor_total', 'desconto', 'fornecedor_id', 'status', 'observacao', 'criado_por', 'lancamento_diario_id', 'voo_emprestado', 'numero_voo', 'prazo_envio_cliente', 'atualizado_em'],
  }])
}

async function garantirTabelaFornecedoresCombustivel(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  await validateWorkerSchema(c, [{
    table: 'fornecedores_combustivel',
    columns: ['id', 'nome_fornecedor', 'codigo_icao', 'preco_jet', 'preco_avgas', 'status'],
  }])
}

async function normalizarLocalAbastecimento(db: D1Database, valor: unknown): Promise<string | null> {
  const local = String(valor ?? '').trim()
  if (!local) return null
  const aerodromo = await db.prepare(
    'SELECT designativo_icao FROM aerodromo WHERE id = ?1 OR upper(trim(designativo_icao)) = upper(trim(?1)) LIMIT 1',
  ).bind(local).first<{ designativo_icao: string }>()
  return aerodromo?.designativo_icao?.trim().toUpperCase() || null
}

abastecimentosRoutes.get('/api/interno/abastecimentos/precos', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  await garantirTabelaAbastecimentos(c)
  await garantirTabelaFornecedoresCombustivel(c)

  const icao = String(c.req.query('icao') || '').trim().toUpperCase()
  const tipo = String(c.req.query('tipo_combustivel') || '').trim().toUpperCase()
  if (!/^[A-Z]{4}$/.test(icao)) return c.json({ error: 'icao_invalido' }, 400)

  const colunaPreco = /JET|JETA|JET_A1|JET-A1/.test(tipo) ? 'preco_jet' : 'preco_avgas'
  const db = c.env.SHARE_DB

  const [fornecedores, historico] = await Promise.all([
    db.prepare(`SELECT id, nome_fornecedor AS fornecedor, codigo_icao, ${colunaPreco} AS valor_unitario, 'fornecedor_cadastrado' AS origem
      FROM fornecedores_combustivel
      WHERE upper(COALESCE(codigo_icao, '')) = ?1 AND COALESCE(${colunaPreco}, 0) > 0
      ORDER BY valor_unitario`).bind(icao).all(),
    db.prepare(`SELECT a.id, a.data, a.tipo_combustivel, a.local, a.valor_unitario, a.litros,
        f.nome_fornecedor AS fornecedor, 'abastecimento_historico' AS origem
      FROM abastecimentos a
      LEFT JOIN fornecedores_combustivel f ON f.id = a.fornecedor_id
      WHERE (upper(COALESCE(a.local, '')) = ?1 OR upper(COALESCE(a.trecho, '')) LIKE ?2)
        AND (?3 = '' OR upper(COALESCE(a.tipo_combustivel, '')) LIKE ?4)
        AND COALESCE(a.valor_unitario, 0) > 0
      ORDER BY date(a.data) DESC, a.criado_em DESC LIMIT 20`).bind(icao, `%${icao}%`, tipo, `%${tipo}%`).all(),
  ])

  return c.json({ icao, tipo_combustivel: tipo || null, fornecedores: fornecedores.results, historico: historico.results, source: 'controle_abastecimento' })
})

export { normalizarLocalAbastecimento, garantirTabelaAbastecimentos, garantirTabelaFornecedoresCombustivel }
