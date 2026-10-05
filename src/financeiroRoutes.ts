import { Hono } from 'hono'
import {
  createExpense,
  createReimbursement,
  createDirectExternalExpense,
  createClientExpenseRateios,
  enqueueFinance,
  FinanceError,
  issueRevenue,
  emitirReciboReembolso,
  emitirReciboColaborador,
  emitirReciboPagamento,
  emitirReciboSaida,
  enviarReciboPagamentoParaRateio,
  programarReciboReembolso,
  processFinanceQueue,
  settlePayable,
  settleReceivable,
  loadSchema,
  holdingMovementColumn,
  validateFinanceSchema,
} from './financeiro/FinanceiroKernel'
import { createPaymentRequest, convertPaymentRequest, validatePaymentRequest } from './financeiro/paymentAgents'
import { mensagemFinanceiraStatements } from './financeiro/financeiroNotifications'
import { resumirHoldings } from './financeiro/cotistaDashboard'
import { pagamentosFolhaRoutes } from './financeiro/pagamentosFolhaRoutes'

type Bindings = {
  SHARE_DB: D1Database
  GEMINI_API_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  FILES?: R2Bucket
  SHARE_FILES?: R2Bucket
  R2_PUBLIC_URL?: string
}

type Variables = {
  userId: string | null
}

export const financeiroRoutes = new Hono<{
  Bindings: Bindings
  Variables: Variables
}>()

financeiroRoutes.route('/', pagamentosFolhaRoutes)

function errorResponse(c: any, error: unknown) {
  if (error instanceof FinanceError) {
    return c.json(
      {
        error: error.message,
        code: error.code,
      },
      error.status,
    )
  }

  console.error(
    '[financeiro]',
    error instanceof Error ? error.message : String(error),
    error,
  )
  return c.json(
    {
      error: 'falha_ao_processar_financeiro',
      code: 'erro_interno',
    },
    500,
  )
}

function storage(c: any): R2Bucket | undefined {
  return c.env.SHARE_FILES || c.env.FILES
}

function publicStorageUrl(c: any, key: string): string {
  const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  if (!publicBase) throw new Error('R2_PUBLIC_URL_nao_configurada')
  return `${publicBase}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
}

async function listar(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  const statement = db.prepare(sql)
  const result = params.length
    ? await statement.bind(...params).all<Record<string, unknown>>()
    : await statement.all<Record<string, unknown>>()
  return result.results ?? []
}

async function listarTodos(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  const pageSize = 500
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await listar(db, `${sql} LIMIT ? OFFSET ?`, ...params, pageSize, offset)
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

const CONFIG_TABLES = {
  fornecedores: 'fornecedores_favoritos',
  contas_bancarias: 'contas_bancarias',
  categorias_share: 'categoria_movimentacao_share',
  categorias_cliente: 'categoria_movimentacao_cliente',
} as const
const configId = () => crypto.randomUUID()

async function requireCaixaShareAccess(c: any): Promise<Response | null> {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'nao_autorizado' }, 401)
  const row = await c.env.SHARE_DB.prepare(`
    SELECT 1 FROM user_profiles p
     WHERE p.id = ? AND lower(replace(replace(trim(COALESCE(p.tipo_user, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster')
    UNION ALL
    SELECT 1 FROM usuarios_funcoes f
     WHERE f.user_id = ? AND lower(replace(replace(trim(COALESCE(f.funcao, '')), ' ', '_'), '-', '_')) IN ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster')
    LIMIT 1`).bind(userId, userId).first()
  return row ? null : c.json({ error: 'caixa_share_nao_autorizado' }, 403)
}

const configText = (value: unknown, fallback = '') => String(value ?? fallback).trim()

financeiroRoutes.get('/configuracoes', async (c) => {
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

financeiroRoutes.post('/configuracoes/:tipo', async (c) => {
  try {
    const table = CONFIG_TABLES[c.req.param('tipo') as keyof typeof CONFIG_TABLES]
    if (!table) return c.json({ error: 'tipo_configuracao_invalido' }, 400)
    const body = await c.req.json<Record<string, unknown>>()
    const id = configText(body.id) || configId()
    const userId = c.get('userId') || null
    let columns: string[]; let values: unknown[]
    if (table === 'fornecedores_favoritos') {
      const nome = configText(body.nome_completo ?? body.nome)
      if (!nome) return c.json({ error: 'nome_fornecedor_obrigatorio' }, 400)
      columns = ['id', 'nome_completo', 'apelido', 'documento', 'telefone', 'endereco', 'cidade', 'uf', 'pessoa_contato', 'categoria_fornecedor']
      values = [id, nome, configText(body.apelido) || null, configText(body.documento) || null, configText(body.telefone) || null, configText(body.endereco) || null, configText(body.cidade) || null, configText(body.uf) || null, configText(body.pessoa_contato) || null, configText(body.categoria_fornecedor, 'nenhum')]
    } else if (table === 'contas_bancarias') {
      const banco = configText(body.banco); const nome = configText(body.nome || body.razao_social, banco)
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

financeiroRoutes.get('/fornecedores-combustivel', async (c) => {
  try {
    const fornecedores = await listar(c.env.SHARE_DB, 'SELECT * FROM fornecedores_combustivel ORDER BY nome_cidade COLLATE NOCASE, nome_fornecedor COLLATE NOCASE')
    return c.json(fornecedores)
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.get('/fornecedores-favoritos', async (c) => {
  try {
    const fornecedores = await listar(c.env.SHARE_DB, 'SELECT * FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo) COLLATE NOCASE, nome_completo COLLATE NOCASE')
    return c.json(fornecedores)
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.delete('/configuracoes/:tipo/:id', async (c) => {
  try {
    const table = CONFIG_TABLES[c.req.param('tipo') as keyof typeof CONFIG_TABLES]
    if (!table) return c.json({ error: 'tipo_configuracao_invalido' }, 400)
    const result = await c.env.SHARE_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'configuracao_nao_encontrada' }, 404)
    return c.json({ ok: true })
  } catch (error) { return errorResponse(c, error) }
})

async function alocarNumeroReciboSaida(db: D1Database, cotistaId: string, dataEmissao: string, codigoInformado?: unknown): Promise<string> {
  const cotista = await db.prepare(`
    SELECT COALESCE(ca.codigo_cliente, cl.codigo_cliente, 'CLI') AS codigo_cliente
    FROM cotista_aeronave ca
    LEFT JOIN cliente cl ON cl.id = ca.cliente_id
    WHERE ca.id = ?
    LIMIT 1
  `).bind(cotistaId).first<{ codigo_cliente: string | null }>()
  const codigo = String(codigoInformado ?? cotista?.codigo_cliente ?? 'CLI').trim().toUpperCase() || 'CLI'
  const anoCompleto = dataEmissao.slice(0, 4)
  const anoCurto = anoCompleto.slice(-2)
  const anoCadastrado = await db.prepare('SELECT ano, proximo_numero FROM sequencia_numeros_recibo_saida WHERE codigo_cliente = ? AND ano IN (?, ?) ORDER BY CASE WHEN ano = ? THEN 0 ELSE 1 END LIMIT 1').bind(codigo, anoCompleto, anoCurto, anoCompleto).first<{ ano: string; proximo_numero: number | null }>()
  const ano = anoCadastrado?.ano ?? anoCompleto
  // Recibos de saída têm uma sequência própria, independente de
  // sequencia_numeros_recibos. A sequência começa em 1 e deve respeitar o
  // próximo número já gravado para o código/ano, sem aplicar o piso 101 ou
  // recalcular com base em números antigos da tabela de recibos.
  const proximoConfigurado = Math.max(Number(anoCadastrado?.proximo_numero || 1), 1)
  const proximoNumero = proximoConfigurado
  const sequencia = await db.prepare(`
    INSERT INTO sequencia_numeros_recibo_saida (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(codigo_cliente, ano) DO UPDATE SET cotista_aeronave_id = excluded.cotista_aeronave_id, proximo_numero = excluded.proximo_numero
    RETURNING proximo_numero - 1 AS numero
  `).bind(crypto.randomUUID(), cotistaId, codigo, ano, proximoNumero + 1).first<{ numero: number }>()
  if (!sequencia) throw new Error('falha_ao_gerar_sequencia_recibo_saida')
  return `REC-${codigo}${String(sequencia.numero).padStart(3, '0')}/${anoCurto}`
}

async function enriquecerFornecedores(db: D1Database, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows
  const cotistaIds = [...new Set(rows.map((row) => String(row.cotista_aeronave_id ?? row.cotista_id ?? '').trim()).filter(Boolean))]
  const fornecedorIds = [...new Set(rows.map((row) => String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()).filter(Boolean))]
  const porCotista = new Map<string, string>()
  const porFornecedor = new Map<string, string>()
  if (cotistaIds.length) {
    const placeholders = cotistaIds.map(() => '?').join(', ')
    const cotistas = await listar(db, `SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
      WHERE ca.id IN (${placeholders})`, ...cotistaIds)
    cotistas.forEach((row) => { if (row.id && row.nome) porCotista.set(String(row.id), String(row.nome)) })
  }
  if (fornecedorIds.length) {
    const placeholders = fornecedorIds.map(() => '?').join(', ')
    const fornecedores = await listar(db, `SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN (${placeholders})`, ...fornecedorIds)
    fornecedores.forEach((row) => { if (row.id && row.nome_completo) porFornecedor.set(String(row.id), String(row.nome_completo)) })
  }
  return rows.map((row) => {
    const fornecedorId = String(row.fornecedor_id ?? row.fornecedores_favoritos_id ?? '').trim()
    const cotistaId = String(row.cotista_aeronave_id ?? row.cotista_id ?? '').trim()
    const fornecedorNome = row.fornecedor_nome ?? row.fornecedor ?? porFornecedor.get(fornecedorId) ?? porCotista.get(cotistaId) ?? null
    return { ...row, fornecedor_id: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null, fornecedor_nome: fornecedorNome }
  })
}

function mapConta(row: Record<string, unknown>): Record<string, unknown> {
  const documento = row.numero_nf ?? row.numero_recibo ?? row.numero_doc ?? row.numero_demonstrativo ?? null
  const documentoUrl = row.url_demonstrativo ?? row.url_nf ?? row.url_recibo ?? row.url_boleto ?? row.url_doc ?? row.lancamento_boleto_url ?? row.lancamento_nf_url ?? row.boleto_url ?? row.nf_url ?? null
  return {
    id: row.id,
    dataEmissao: row.lancamento_data_emissao ?? row.data_emissao ?? row.data ?? null,
    dataVencimento: row.data_vencimento,
    valor: Number(row.valor ?? Number(row.valor_centavos ?? 0) / 100),
    categoriaId: row.categoria_id ?? null,
    categoriaNome: row.categoria_nome ?? null,
    descricao: row.descricao ?? null,
    criadoPor: row.criado_por ?? null,
    aeronaveId: row.aeronave_id ?? null,
    fornecedorId: row.fornecedor_id ?? row.fornecedores_favoritos_id ?? null,
    fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null,
    cotistaId: row.cotista_id ?? null,
    tipoCaixa: row.tipo_caixa ?? (row.movimentos_id ? 'HOLDING' : 'SHARE'),
    holdingId: row.holding_id ?? null,
    movimentoHoldingId: row.movimentos_id ?? null,
    boletoUrl: row.boleto_url ?? null,
    nfUrl: row.nf_url ?? null,
    nfSaidaId: row.nf_saida_id ?? null,
    dataPagamento: row.data_pagamento ?? row.data_recebimento ?? null,
    bancoPagamento: row.banco_pagamento ?? row.banco_recebimento ?? null,
    comprovantePagamentoUrl: row.comprovante_pagamento_url ?? row.comprovante_recebimento_url ?? null,
    documento,
    documentoUrl,
    lancamentoId: row.lancamento_id ?? row.lancamentos_id ?? row.lancamento_receita_id ?? null,
    status: row.status,
    solicitanteNome: row.solicitante_nome ?? null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  }
}

function periodoFinanceiro(periodo: string | undefined): { inicio?: string; fim?: string } {
  if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) return {}
  const [ano, mes] = periodo.split('-').map(Number)
  return {
    inicio: `${periodo}-01`,
    fim: new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10),
  }
}

function statusFinanceiro(status: unknown): string {
  const value = String(status ?? '').toUpperCase()
  if (value === 'EM_ABERTO') return 'Pendente'
  if (value === 'EM_ATRASO' || value === 'ATRASADO') return 'Atrasado'
  if (value === 'RECEBIDO') return 'Recebido'
  if (value === 'PAGO' || value === 'PAGO_DIRETAMENTE' || value === 'REEMBOLSADO') return 'Pago'
  if (value === 'CANCELADO') return 'Cancelado'
  return 'Pendente'
}

function valorReais(row: Record<string, unknown>, field = 'valor_centavos'): number {
  return Number(row[field] ?? 0) / 100
}

async function dashboardShare(c: any) {
  const db = c.env.SHARE_DB
  const { inicio, fim } = periodoFinanceiro(c.req.query('periodo'))
  const aeronave = c.req.query('aeronave')
  const filtros: string[] = []
  const params: unknown[] = []
  if (inicio) { filtros.push('date(COALESCE(l.data_emissao, l.criado_em)) >= date(?)'); params.push(inicio) }
  if (fim) { filtros.push('date(COALESCE(l.data_emissao, l.criado_em)) <= date(?)'); params.push(fim) }
  if (aeronave && aeronave !== 'Todas as aeronaves') { filtros.push('a.matricula_registro = ?'); params.push(aeronave) }
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''
  const [lancamentos, pagar, receber, reembolsos, categorias] = await Promise.all([
    listar(db, `SELECT l.*, a.matricula_registro AS aeronave, cb.banco AS banco_pagamento_nome FROM lancamentos l LEFT JOIN aeronave a ON a.id = l.aeronave_id LEFT JOIN contas_bancarias cb ON cb.id = l.conta_bancaria_id ${where} ORDER BY date(COALESCE(l.data_emissao, l.criado_em)) DESC LIMIT 1000`, ...params),
    listar(db, `SELECT cp.*, l.fornecedor_nome, l.numero_doc, l.numero_nf, l.aeronave_id, a.matricula_registro AS aeronave, l.cotista_aeronave_id, l.descricao AS lancamento_descricao FROM contas_apagar cp LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id LEFT JOIN aeronave a ON a.id = cp.aeronave_id WHERE COALESCE(UPPER(l.tipo_caixa), 'SHARE') = 'SHARE' AND COALESCE(l.reembolsavel, 0) = 0 AND cp.movimentos_id IS NULL AND UPPER(COALESCE(cp.origem_tipo, '')) <> 'RELATORIO_DESPESA_VIAGEM' AND UPPER(COALESCE(cp.categoria_nome, '')) NOT LIKE '%REEMBOLS%' ${aeronave && aeronave !== 'Todas as aeronaves' ? 'AND a.matricula_registro = ?' : ''} ORDER BY date(cp.data_vencimento) ASC LIMIT 500`, ...(aeronave && aeronave !== 'Todas as aeronaves' ? [aeronave] : [])),
    listar(db, `SELECT cr.*, l.numero_doc, l.numero_nf, l.aeronave_id, a.matricula_registro AS aeronave, COALESCE(l.descricao, cr.descricao) AS descricao_real FROM contas_areceber cr LEFT JOIN lancamentos l ON l.id = cr.lancamentos_id LEFT JOIN aeronave a ON a.id = cr.aeronave_id ${aeronave && aeronave !== 'Todas as aeronaves' ? 'WHERE a.matricula_registro = ?' : ''} ORDER BY date(cr.data_vencimento) ASC LIMIT 500`, ...(aeronave && aeronave !== 'Todas as aeronaves' ? [aeronave] : [])),
    listar(db, `SELECT r.*, l.descricao, l.aeronave_id, a.matricula_registro AS aeronave, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, r.cotista_id) AS cotista_nome, COALESCE((SELECT SUM(rp.valor_centavos) FROM rateio_pagamentos rp WHERE rp.conta_receber_id = r.conta_receber_id AND rp.status = 'CONFIRMADO'), 0) AS valor_recebido_centavos FROM reembolsos r LEFT JOIN lancamentos l ON l.id = r.lancamento_origem_id LEFT JOIN aeronave a ON a.id = l.aeronave_id LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY r.criado_em DESC LIMIT 500`),
    listar(db, `SELECT COALESCE(l.categoria_nome, 'Sem categoria') AS nome, SUM(CASE WHEN l.fluxo IN ('SAIDA','DESPESA') THEN l.valor_centavos ELSE 0 END) AS valor FROM lancamentos l LEFT JOIN aeronave a ON a.id = l.aeronave_id ${where} GROUP BY COALESCE(l.categoria_nome, 'Sem categoria') ORDER BY valor DESC LIMIT 12`, ...params),
  ])
  const saidas = lancamentos.filter((row) => ['SAIDA', 'DESPESA'].includes(String(row.fluxo ?? '').toUpperCase()))
  const entradas = lancamentos.filter((row) => ['ENTRADA', 'RECEITA'].includes(String(row.fluxo ?? '').toUpperCase()))
  const total = (rows: Record<string, unknown>[]) => rows.reduce((sum, row) => sum + valorReais(row), 0)
  const porMes = new Map<string, { mes: string; entradas: number; saidas: number; saldo: number }>()
  lancamentos.forEach((row) => {
    const mes = String(row.data_emissao ?? row.criado_em ?? '').slice(0, 7)
    if (!mes) return
    const atual = porMes.get(mes) ?? { mes, entradas: 0, saidas: 0, saldo: 0 }
    const value = valorReais(row)
    if (['ENTRADA', 'RECEITA'].includes(String(row.fluxo ?? '').toUpperCase())) atual.entradas += value
    else atual.saidas += value
    atual.saldo = atual.entradas - atual.saidas
    porMes.set(mes, atual)
  })
  const payables = pagar.map((row) => ({ id: row.id, vencimento: row.data_vencimento, descricao: row.descricao ?? row.lancamento_descricao, fornecedor: row.fornecedor_nome ?? 'Não informado', categoria: row.categoria_nome ?? 'Sem categoria', aeronave: row.aeronave ?? 'Todas', cotistaCliente: row.cotista_aeronave_id ?? 'Share Brasil', valor: valorReais(row), status: statusFinanceiro(row.status), documento: row.numero_nf ?? row.numero_doc ?? '', banco: row.banco_pagamento_nome ?? null }))
  const receivables = receber.map((row) => ({ id: row.id, vencimento: row.data_vencimento, descricao: row.descricao_real ?? 'Recebimento', cliente: row.cotista_id ?? 'Cliente não informado', categoria: row.categoria_nome ?? 'Sem categoria', aeronave: row.aeronave ?? 'Todas', valor: valorReais(row), status: statusFinanceiro(row.status), banco: row.banco_recebimento ?? null, nf: row.numero_nf ?? row.numero_doc ?? null }))
  const reimbursements = reembolsos.map((row) => { const totalCentavos = Number(row.valor_centavos ?? 0); const recebidoCentavos = Number(row.valor_recebido_centavos ?? 0); return { id: row.id, despesa: row.descricao ?? 'Reembolso', aeronave: row.aeronave ?? 'Todas', clienteCotista: row.cotista_nome ?? row.cotista_id ?? 'Não informado', valorTotal: totalCentavos / 100, valorDevido: totalCentavos / 100, valorRecebido: recebidoCentavos / 100, valorPendente: Math.max(0, totalCentavos - recebidoCentavos) / 100, status: statusFinanceiro(row.status), pagoPor: 'Share Brasil', origem: 'D1 / reembolsos' } })
  return c.json({
    live: true, kpis: [
      { label: 'A pagar', value: total(pagar).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${pagar.length} títulos`, helper: 'obrigações no D1', tone: 'warning' },
      { label: 'A receber', value: total(receber).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${receber.length} títulos`, helper: 'recebíveis no D1', tone: 'info' },
      { label: 'Reembolsos pendentes', value: total(reembolsos.filter((row) => !['RECEBIDO', 'REEMBOLSADO'].includes(String(row.status).toUpperCase()))).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${reembolsos.length} registros`, helper: 'aptos para acompanhamento', tone: 'special' },
      { label: 'Entradas no período', value: total(entradas).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${entradas.length} lançamentos`, helper: 'caixa realizado', tone: 'success' },
      { label: 'Saídas no período', value: total(saidas).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${saidas.length} lançamentos`, helper: 'despesas registradas', tone: 'default' },
    ], cashFlow: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)), categories: categorias.map((row, index) => ({ name: row.nome, value: Number(row.valor ?? 0) / 100, fill: ['var(--chart-cyan)', 'var(--chart-blue)', 'var(--chart-indigo)', 'var(--chart-violet)', 'var(--chart-slate)'][index % 5] })), payables, receivables, reimbursements, salaries: []
  })
}

async function consultarContas(c: any, table: 'contas_apagar' | 'contas_areceber') {
  const status = c.req.query('status')
  const cotistaId = c.req.query('cotistaId')
  const fornecedorId = c.req.query('fornecedorId')
  const vencidasAte = c.req.query('vencidasAte')
  const filtros: string[] = []
  const params: unknown[] = []
  const alias = table === 'contas_apagar' ? 'cp' : 'cr'
  const origem = table === 'contas_apagar' ? ' LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id' : ' LEFT JOIN lancamentos l ON l.id = cr.lancamentos_id'
  if (table === 'contas_apagar') {
    filtros.push("COALESCE(UPPER(l.tipo_caixa), 'SHARE') = 'SHARE'")
    filtros.push('COALESCE(l.reembolsavel, 0) = 0')
    filtros.push("UPPER(COALESCE(cp.origem_tipo, '')) <> 'RELATORIO_DESPESA_VIAGEM'")
    filtros.push("UPPER(COALESCE(cp.categoria_nome, '')) NOT LIKE '%REEMBOLS%'")
  }
  if (status) { filtros.push(`${alias}.status = ?`); params.push(status) }
  if (cotistaId && table === 'contas_areceber') { filtros.push(`${alias}.cotista_id = ?`); params.push(cotistaId) }
  if (fornecedorId && table === 'contas_apagar') { filtros.push(`${alias}.fornecedor_id = ?`); params.push(fornecedorId) }
  if (vencidasAte) { filtros.push(`date(${alias}.data_vencimento) <= date(?)`); params.push(vencidasAte) }
  const rows = await listar(c.env.SHARE_DB, `SELECT ${alias}.*, l.data_emissao AS lancamento_data_emissao, l.numero_nf, l.numero_recibo, l.numero_doc, l.numero_demonstrativo, l.url_demonstrativo, l.url_nf, l.url_recibo, l.url_boleto, l.url_doc FROM ${table} ${alias}${origem}${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(${alias}.data_vencimento) ASC, ${alias}.criado_em DESC LIMIT 500`, ...params)
  const rowsComFornecedor = await enriquecerFornecedores(c.env.SHARE_DB, rows)
  const mapped = rowsComFornecedor.map(mapConta)
  if (table !== 'contas_areceber') return mapped
  return Promise.all(mapped.map(async (conta) => ({
    ...conta,
    rateios: await listar(c.env.SHARE_DB,
      'SELECT id, cotista_id, valor_rateado_centavos, valor_pago_real_centavos, status FROM rateio_despesas WHERE lancamento_id = ? ORDER BY rowid',
      conta.lancamentoId,
    ),
  })))
}

/*
 * Esta rota somente valida o schema. Ela não cria, altera ou exclui tabelas.
 * Pode ser usada no health check ou no deploy para detectar incompatibilidade.
 */
financeiroRoutes.get('/schema/validate', async (c) => {
  try {
    await validateFinanceSchema(c.env.SHARE_DB)
    return c.json({ valido: true })
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.get('/share', async (c) => {
  try { return await dashboardShare(c) } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/cotista', async (c) => {
  try {
    const url = new URL(c.req.url)
    url.pathname = '/cotista/dashboard'
    const aeronave = c.req.query('aeronave')
    const cotista = c.req.query('cotista')
    const periodo = c.req.query('periodo')
    if (aeronave && aeronave !== 'Todas as aeronaves') url.searchParams.set('aeronave_id', aeronave)
    if (cotista && cotista !== 'Todos os cotistas') {
      const encontrado = await c.env.SHARE_DB.prepare(`SELECT ca.id FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id = ? OR upper(COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, '')) = upper(?) LIMIT 1`).bind(cotista, cotista).first<{ id: string }>()
      if (encontrado?.id) url.searchParams.set('cotista_id', encontrado.id)
    }
    if (periodo && /^\d{4}-\d{2}$/.test(periodo)) { const [ano, mes] = periodo.split('-').map(Number); url.searchParams.set('inicio', `${periodo}-01`); url.searchParams.set('fim', new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10)) }
    url.searchParams.delete('aeronave')
    url.searchParams.delete('cotista')
    url.searchParams.delete('periodo')
    return financeiroRoutes.fetch(new Request(url, c.req.raw), c.env, c.executionCtx)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/contas-apagar', async (c) => {
  try { return c.json(await consultarContas(c, 'contas_apagar')) } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.post('/contas-apagar', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const valorCentavos = Math.round(Number(body.valor_centavos ?? Number(body.valor ?? 0) * 100))
    const descricao = String(body.descricao ?? '').trim()
    const dataEmissao = String(body.data_emissao ?? body.data ?? new Date().toISOString().slice(0, 10)).trim()
    const dataVencimento = String(body.data_vencimento ?? body.vencimento ?? dataEmissao).trim()
    if (!descricao || !Number.isInteger(valorCentavos) || valorCentavos <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) || !/^\d{4}-\d{2}-\d{2}$/.test(dataVencimento)) {
      return c.json({ error: 'descricao, valor e datas_validos_sao_obrigatorios' }, 400)
    }
    const result = await createExpense(c.env.SHARE_DB, {
      ...body,
      idempotency_key: body.idempotency_key ?? body.idempotencyKey ?? `conta-apagar:${crypto.randomUUID()}`,
      valor_centavos: valorCentavos,
      descricao,
      data: dataEmissao,
      data_vencimento: dataVencimento,
      tipo_caixa: 'SHARE',
      pago_diretamente: false,
      reembolsavel: false,
      origem_tipo_conta: String(body.origem_tipo_conta ?? 'DESPESA'),
    }, c.get('userId') || null, { internal: true })
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/contas-areceber', async (c) => {
  try { return c.json(await consultarContas(c, 'contas_areceber')) } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/solicitacoes-compra', async (c) => {
  try {
    const rows = await listar(c.env.SHARE_DB, `SELECT sc.*, e.id AS envio_id, e.status AS envio_status, e.valor, e.vencimento, e.tipo_caixa,
        e.lancamento_id, e.movimentacao_id, e.movimentos_holding_id,
        COALESCE(u.nome_exibicao, u.nome_completo, u.email, sc.solicitante_nome, sc.user_id) AS solicitante_nome
      FROM solicitacoes_compra sc
      LEFT JOIN envio_despesas e ON e.solicitacao_compra_id = sc.id
      LEFT JOIN user_profiles u ON u.id = sc.user_id
      ORDER BY datetime(COALESCE(sc.data_solicitacao, sc.criado_em)) DESC LIMIT 500`)
    return c.json({ solicitacoes: rows })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.get('/solicitacoes-pagamento', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [envios, reembolsos] = await Promise.all([
      listar(db, `SELECT e.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email, e.criado_por) AS solicitante_nome
        FROM envio_despesas e LEFT JOIN user_profiles u ON u.id = e.criado_por
        WHERE e.tipo IN ('cliente', 'reembolso') ORDER BY e.criado_em DESC LIMIT 500`),
      listar(db, `SELECT cp.*, l.fornecedor_nome, l.numero_doc, l.numero_nf, l.aeronave_id,
          a.matricula_registro AS aeronave, l.cotista_aeronave_id, l.descricao AS lancamento_descricao,
          mh.holding_id, CASE WHEN cp.movimentos_id IS NOT NULL THEN 'HOLDING' ELSE COALESCE(l.tipo_caixa, 'SHARE') END AS tipo_caixa,
          COALESCE(u.nome_exibicao, u.nome_completo, u.email, cp.colaborador_id) AS solicitante_nome
        FROM contas_apagar cp
        LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id
        LEFT JOIN movimentos_holding mh ON mh.id = cp.movimentos_id
        LEFT JOIN aeronave a ON a.id = cp.aeronave_id
        LEFT JOIN user_profiles u ON u.id = cp.colaborador_id
        WHERE (COALESCE(l.reembolsavel, 0) = 1
          OR UPPER(COALESCE(cp.origem_tipo, '')) = 'RELATORIO_DESPESA_VIAGEM'
          OR UPPER(COALESCE(cp.categoria_nome, '')) LIKE '%REEMBOLS%')
          AND UPPER(cp.status) NOT IN ('PAGO', 'CANCELADO')
        ORDER BY date(cp.data_vencimento) ASC LIMIT 500`),
    ])
    return c.json({ envios, reembolsos: reembolsos.map(mapConta) })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/movimentos-holding/pendentes', async (c) => {
  try {
    const movimentos = await listar(c.env.SHARE_DB, `SELECT mh.id, mh.holding_id, h.nome AS holding_nome,
        mh.socio_id, hs.nome AS socio_nome, mh.aeronave_id, a.matricula_registro AS aeronave,
        mh.data_emissao, mh.data_vencimento, mh.descricao, mh.categoria_nome, mh.valor_centavos,
        mh.status, mh.fornecedor_nome,
        COALESCE((SELECT SUM(rh.valor_rateado_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS rateado_centavos,
        COALESCE((SELECT SUM(rh.valor_pago_real_centavos) FROM rateio_hold rh WHERE rh.movimento_id = mh.id AND rh.status <> 'CANCELADO'), 0) AS pago_centavos
      FROM movimentos_holding mh
      LEFT JOIN holdings h ON h.id = mh.holding_id
      LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
      LEFT JOIN aeronave a ON a.id = mh.aeronave_id
      WHERE mh.tipo_caixa = 'HOLD' AND UPPER(mh.fluxo) = 'SAIDA'
        AND UPPER(mh.status) IN ('EM_ABERTO', 'EM_ATRASO', 'AGUARDANDO_REEMBOLSO')
        AND COALESCE(mh.pago_diretamente, 0) = 0
      ORDER BY date(mh.data_vencimento) ASC, mh.criado_em DESC LIMIT 500`)
    return c.json({ movimentos })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/movimentos-holding/:id/baixa', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const movimentoId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const dataPagamento = String(body.data_pagamento ?? '').trim()
    const bancoId = String(body.conta_bancaria_id ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPagamento) || !bancoId) return c.json({ error: 'data_e_conta_bancaria_obrigatorias' }, 400)
    const movimento = await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first<Record<string, unknown>>()
    if (!movimento) return c.json({ error: 'movimento_holding_nao_encontrado' }, 404)
    if (String(movimento.status).toUpperCase() === 'PAGO') return c.json({ ...movimento, idempotent: true })
    if (String(movimento.status).toUpperCase() === 'CANCELADO') return c.json({ error: 'movimento_holding_cancelado' }, 409)
    const conta = await db.prepare("SELECT id FROM contas_bancarias WHERE id = ? AND tipo_caixa = 'HOLDING' AND holding_id = ? AND ativo = 1").bind(bancoId, movimento.holding_id).first()
    if (!conta) return c.json({ error: 'conta_bancaria_holding_invalida' }, 400)
    const envio = await db.prepare(`SELECT id, criado_por, descricao FROM envio_despesas
      WHERE movimentos_holding_id = ? OR movimentacao_id = ? LIMIT 1`).bind(movimentoId, movimentoId).first<Record<string, unknown>>()
    const statements = [
      db.prepare("UPDATE movimentos_holding SET status = 'PAGO', data_pagamento = ?, conta_bancaria_id = ?, forma_pagamento = ?, comprovante_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(dataPagamento, bancoId, body.forma_pagamento ?? null, body.comprovante_url ?? null, movimentoId),
      db.prepare("UPDATE rateio_hold SET status = 'PAGO', data_pagamento = ?, valor_pago_real_centavos = valor_rateado_centavos, atualizado_em = CURRENT_TIMESTAMP WHERE movimento_id = ? AND status <> 'CANCELADO'")
        .bind(dataPagamento, movimentoId),
      ...(envio ? [
        db.prepare("UPDATE envio_despesas SET status = 'CONCLUIDO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('CONVERTIDO', 'APROVADO')").bind(envio.id),
        ...mensagemFinanceiraStatements(db, String(envio.criado_por ?? '') || null, c.get('userId') || null, 'Solicitação Holding concluída', `O pagamento da solicitação “${String(envio.descricao ?? 'Despesa Holding')}” foi concluído em ${dataPagamento}.`),
      ] : []),
    ]
    await db.batch(statements)
    return c.json({ ...(await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first()), idempotent: false })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/recibos-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const rows = await listar(c.env.SHARE_DB, 'SELECT * FROM recibos_saida ORDER BY date(data_emissao) DESC, criado_em DESC LIMIT 500')
    return c.json({ recibos: rows })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const body = await c.req.json<Record<string, unknown>>()
    const cotistaId = String(body.cotista_aeronave_id ?? body.cotista_id ?? '').trim()
    const aeronaveId = String(body.aeronave_id ?? '').trim()
    const valor = Number(body.valor_total ?? body.valor ?? 0)
    const dataEmissao = String(body.data_emissao ?? '').trim()
    const dataVencimento = String(body.data_vencimento ?? dataEmissao).trim()
    const descricao = String(body.descricao_servico ?? body.descricao ?? '').trim()
    if (!cotistaId || !aeronaveId || !(valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) || !descricao) {
      return c.json({ error: 'cotista_aeronave_id, aeronave_id, valor_total, data_emissao e descricao_servico são obrigatórios' }, 400)
    }
    const id = crypto.randomUUID()
    const numero = await alocarNumeroReciboSaida(c.env.SHARE_DB, cotistaId, dataEmissao, body.codigo_cliente)
    const categoriaInformada = String(body.categoria_receita_id ?? body.categoria_id ?? '').trim()
    const categoriaExiste = categoriaInformada
      ? Boolean(await c.env.SHARE_DB.prepare('SELECT id FROM categoria_movimentacao_share WHERE id = ?').bind(categoriaInformada).first())
      : false
    const financeiro = await issueRevenue(c.env.SHARE_DB, {
      idempotency_key: `recibo_saida:${id}`,
      valor_centavos: Math.round(valor * 100), descricao,
      data_emissao: dataEmissao, data_vencimento: dataVencimento,
      aeronave_id: aeronaveId, cotista_aeronave_id: cotistaId,
      categoria_id: categoriaExiste ? categoriaInformada : null,
      categoria_cliente_id: body.categoria_cliente_id ?? body.categoria_despesa_id ?? null,
      categoria_cliente_nome: body.categoria_cliente_nome ?? body.categoria_despesa_subcategoria ?? null,
      categoria_nome: body.categoria_receita_nome ?? body.nome_categoria,
      numero_recibo: numero,
      origem_tipo: 'RECIBO_SAIDA', origem_id: id,
      periodicidade: 'MENSAL',
    }, c.get('userId') || null)
    if (financeiro.lancamentoClienteId) {
      await c.env.SHARE_DB.prepare(`
        UPDATE rateio_despesas
        SET percentual_sociedade = COALESCE((SELECT percentual_sociedade FROM cotista_aeronave WHERE id = ?), 100),
            percentual_uso = 100,
            periodicidade = 'MENSAL',
            valor_pago_real_centavos = 0,
            status = 'AGUARDANDO_REEMBOLSO',
            atualizado_em = CURRENT_TIMESTAMP
        WHERE lancamento_id = ?
      `).bind(cotistaId, financeiro.lancamentoClienteId).run()
    }
    await c.env.SHARE_DB.prepare(`INSERT INTO recibos_saida
      (id, numero_recibo, cotista_id, aeronave_id, valor_total, percentual, descricao_servico,
       nome_categoria, categoria_id, subcategoria_1, data_emissao, data_vencimento,
       status, contas_areceber_id, lancamentos_id, criado_por)
      VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, 'EM_ABERTO', ?, ?, ?)`)
      .bind(id, numero, cotistaId, aeronaveId, valor, descricao,
        body.categoria_receita_nome ?? body.nome_categoria ?? null,
        categoriaExiste ? categoriaInformada : null,
        body.categoria_despesa_subcategoria ?? null, dataEmissao, dataVencimento,
        financeiro.contaReceberId ?? null, financeiro.id ?? financeiro.lancamento_id ?? null, c.get('userId') || null).run()
    if (financeiro.contaReceberId) {
      await c.env.SHARE_DB.prepare('UPDATE contas_areceber SET recibos_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(id, financeiro.contaReceberId).run()
    }
    const recibo = await c.env.SHARE_DB.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(id).first()
    return c.json({ recibo }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.patch('/recibos-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const body = await c.req.json<Record<string, unknown>>()
    const pdfUrl = String(body.pdf_url ?? '').trim()
    if (!pdfUrl) return c.json({ error: 'pdf_url_obrigatorio' }, 400)
    const result = await c.env.SHARE_DB.prepare('UPDATE recibos_saida SET pdf_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(pdfUrl, c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)
    const recibo = await c.env.SHARE_DB.prepare('SELECT numero_recibo, lancamentos_id FROM recibos_saida WHERE id = ?').bind(c.req.param('id')).first<{ numero_recibo: string | null; lancamentos_id: string | null }>()
    const principalId = String(recibo?.lancamentos_id ?? '').trim()
    const principal = principalId ? await c.env.SHARE_DB.prepare('SELECT id FROM lancamentos WHERE id = ?').bind(principalId).first<{ id: string }>() : null
    const cliente = principal ? await c.env.SHARE_DB.prepare('SELECT id FROM lancamentos WHERE origem_id = ? AND tipo_caixa = ? LIMIT 1').bind(principal.id, 'CLIENTE').first<{ id: string }>() : null
    const ids = [principal?.id, cliente?.id].filter((id): id is string => Boolean(id))
    for (const lancamentoId of ids) {
      await c.env.SHARE_DB.prepare(`UPDATE lancamentos SET numero_recibo = ?, url_recibo = ?, origem_tipo = CASE WHEN tipo_caixa = 'CLIENTE' THEN 'RECIBO_SAIDA' ELSE origem_tipo END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(recibo?.numero_recibo ?? null, pdfUrl, lancamentoId).run()
      await c.env.SHARE_DB.prepare('UPDATE rateio_despesas SET numero_recibo = ?, recibo_url = ? WHERE lancamento_id = ?').bind(recibo?.numero_recibo ?? null, pdfUrl, lancamentoId).run().catch(() => undefined)
    }
    const reciboAtualizado = await c.env.SHARE_DB.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(c.req.param('id')).first()
    return c.json({ recibo: reciboAtualizado })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.delete('/recibos-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const reciboId = c.req.param('id')
    const recibo = await db.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(reciboId).first<Record<string, unknown>>()
    if (!recibo) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)

    const contaId = String(recibo.contas_areceber_id ?? '').trim()
    const reciboLancamentoId = String(recibo.lancamentos_id ?? '').trim()
    const conta = contaId
      ? await db.prepare('SELECT lancamentos_id, movimentos_id FROM contas_areceber WHERE id = ?').bind(contaId).first<{ lancamentos_id: string | null; movimentos_id: string | null }>()
      : null
    const lancamentoIds = [...new Set([reciboLancamentoId, conta?.lancamentos_id ?? ''].filter(Boolean))]
    const movimentoIds = [...new Set([conta?.movimentos_id ?? '', reciboLancamentoId].filter(Boolean))]
    if (reciboLancamentoId) {
      const espelho = await listar(db, 'SELECT id FROM lancamentos WHERE origem_id = ?', reciboLancamentoId)
      lancamentoIds.push(...espelho.map((row) => String(row.id)).filter(Boolean))
    }
    const ids = [...new Set(lancamentoIds)]
    const movimentos = [...new Set(movimentoIds)]
    const placeholders = ids.map(() => '?').join(', ')
    const movimentoPlaceholders = movimentos.map(() => '?').join(', ')
    const rateioIds = ids.length
      ? (await listar(db, `SELECT id FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`, ...ids)).map((row) => String(row.id)).filter(Boolean)
      : []

    const statements: D1PreparedStatement[] = []
    if (ids.length) statements.push(db.prepare(`DELETE FROM financeiro_vinculos WHERE (origem_id IN (${placeholders}) OR destino_id IN (${placeholders}) OR origem_id = ? OR destino_id = ?)`).bind(...ids, ...ids, reciboId, reciboId))
    else statements.push(db.prepare('DELETE FROM financeiro_vinculos WHERE origem_id = ? OR destino_id = ?').bind(reciboId, reciboId))
    if (rateioIds.length) {
      const rateioPlaceholders = rateioIds.map(() => '?').join(', ')
      statements.push(db.prepare(`DELETE FROM rateio_pagamentos WHERE rateio_id IN (${rateioPlaceholders})`).bind(...rateioIds))
    }
    if (ids.length) statements.push(db.prepare(`DELETE FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`).bind(...ids))
    if (movimentos.length) statements.push(db.prepare(`DELETE FROM rateio_hold WHERE movimento_id IN (${movimentoPlaceholders})`).bind(...movimentos))
    if (contaId) statements.push(db.prepare('UPDATE contas_areceber SET recibos_saida_id = NULL WHERE id = ?').bind(contaId))
    if (contaId) statements.push(db.prepare('DELETE FROM contas_areceber WHERE id = ?').bind(contaId))
    statements.push(db.prepare('DELETE FROM recibos_saida WHERE id = ?').bind(reciboId))
    if (ids.length) statements.push(db.prepare(`DELETE FROM lancamentos WHERE id IN (${placeholders})`).bind(...ids))
    if (movimentos.length) statements.push(db.prepare(`DELETE FROM movimentos_holding WHERE id IN (${movimentoPlaceholders})`).bind(...movimentos))
    await db.batch(statements)

    const pdfUrl = String(recibo.pdf_url ?? '')
    if (pdfUrl) {
      try {
        const parsed = new URL(pdfUrl)
        const key = parsed.searchParams.get('key') || decodeURIComponent(parsed.pathname.replace(/^\//, ''))
        if (key) await storage(c)?.delete(key)
      } catch (error) {
        console.warn('[financeiro] não foi possível excluir o PDF do recibo:', error)
      }
    }
    return c.json({ ok: true, id: reciboId })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos-saida/:id/dar-baixa', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const reciboId = c.req.param('id')
    const recibo = await c.env.SHARE_DB.prepare('SELECT contas_areceber_id FROM recibos_saida WHERE id = ?').bind(reciboId).first<{ contas_areceber_id: string | null }>()
    if (!recibo) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const contaId = String(recibo.contas_areceber_id ?? '').trim()
    if (!contaId) return c.json({ error: 'conta_a_receber_nao_vinculada' }, 409)
    const result = await settleReceivable(c.env.SHARE_DB, contaId, {
      data_recebimento: body.data_recebimento ?? body.data_pagamento ?? body.dataRecebimento,
      conta_bancaria_id: body.conta_bancaria_id ?? body.conta_bancaria ?? body.bancoRecebimento,
      forma_pagamento: body.forma_pagamento ?? body.formaPagamento,
      comprovante_url: body.comprovante_url ?? body.comprovanteRecebimentoUrl,
      pagamentos: body.pagamentos,
    }, c.get('userId') || null)
    return c.json({ ok: true, conta: result })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/lancamentos/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const opcional = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/opcoes] consulta opcional indisponível', error); return { results: [] } })).results ?? []
    const [categorias, contas, cotistas, holdings] = await Promise.all([
      opcional('SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share ORDER BY nome'),
      opcional('SELECT id, banco, numero_conta, NULL AS tipo_conta, holding_id FROM contas_bancarias WHERE ativo = 1 ORDER BY banco'),
      opcional("SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, ca.aeronave_id, ca.percentual_sociedade FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY nome"),
      opcional('SELECT id, nome, conta_bancaria FROM holdings ORDER BY nome'),
    ])
    return c.json({ categorias, contas_bancarias: contas, cotistas, holdings, pagadores: cotistas })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/share/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const tipoCaixa = c.req.query('tipo_caixa')
    const holdingId = c.req.query('holding_id')
    const filtroConta = tipoCaixa === 'HOLDING' || tipoCaixa === 'SHARE' ? `WHERE tipo_caixa = ? AND ativo = 1${holdingId && tipoCaixa === 'HOLDING' ? ' AND holding_id = ?' : ''}` : ''
    const parametrosConta = tipoCaixa === 'HOLDING' && holdingId ? [tipoCaixa, holdingId] : [tipoCaixa]
    const consultas = [
      listar(db, 'SELECT id, nome, tipo, grupo_categoria AS grupo, tipo_despesa AS classificacao, NULL AS empresa_id, COALESCE(reembolsavel, 0) AS reembolsavel FROM categoria_movimentacao_share ORDER BY nome'),
      filtroConta
        ? listar(db, `SELECT id, banco, numero_conta, NULL AS tipo_conta, holding_id FROM contas_bancarias ${filtroConta} ORDER BY banco`, ...parametrosConta)
        : listar(db, 'SELECT id, banco, numero_conta, NULL AS tipo_conta, holding_id FROM contas_bancarias WHERE ativo = 1 ORDER BY banco'),
      listar(db, 'SELECT id, razao_social, cnpj FROM empresa ORDER BY razao_social'),
    ]
    const [categorias, contas, empresas] = await Promise.all(consultas)
    return c.json({ categorias, contas_bancarias: contas, empresas })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/lancamentos', async (c) => {
  try {
    const inicio = c.req.query('inicio')
    const fim = c.req.query('fim')
    const caixa = c.req.query('caixa')
    const filtros: string[] = []
    const params: unknown[] = []
    if (inicio) { filtros.push('date(COALESCE(data_emissao, criado_em)) >= date(?)'); params.push(inicio) }
    if (fim) { filtros.push('date(COALESCE(data_emissao, criado_em)) <= date(?)'); params.push(fim) }
    if (caixa) { filtros.push('tipo_caixa = ?'); params.push(caixa.toUpperCase()) }
    // Reembolsos de tripulantes originados em relatório de viagem são contas
    // a pagar e aparecem em Solicitações de pagamento. Apenas despesas do
    // próprio caixa Share (incluindo payer=sharebrasil) permanecem aqui.
    if (caixa?.toUpperCase() === 'SHARE') {
      filtros.push(`NOT (
        UPPER(COALESCE(origem_tipo, '')) = 'RELATORIO_DESPESA_VIAGEM'
        AND (
          COALESCE(reembolsavel, 0) = 1
          OR UPPER(COALESCE(categoria_nome, '')) LIKE '%REEMBOLS%'
          OR UPPER(COALESCE(grupo_categoria, '')) LIKE '%REEMBOLS%'
        )
      )`)
    }
    const rows = await listar(c.env.SHARE_DB, `SELECT * FROM lancamentos${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(COALESCE(data_emissao, criado_em)) DESC, criado_em DESC LIMIT 500`, ...params)
    return c.json({ lancamentos: await enriquecerFornecedores(c.env.SHARE_DB, rows) })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/notas-saida/opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [cotistas, aeronaves, categoriasReceita, categoriasDespesa, contasBancarias] = await Promise.all([
      listar(db, "SELECT ca.id AS cotista_aeronave_id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, COALESCE(cl.cnpj, hs.cpf) AS documento, COALESCE(cl.endereco, hs.endereco) AS endereco, COALESCE(cl.cidade, hs.cidade) AS cidade, COALESCE(cl.uf, hs.uf) AS uf, CASE WHEN ca.socio_id IS NULL THEN 'cliente' ELSE 'socio_hold' END AS tipo_cotista, ca.percentual_sociedade FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id ORDER BY nome"),
      listar(db, 'SELECT id, matricula_registro FROM aeronave ORDER BY matricula_registro'),
      listar(db, "SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share WHERE upper(COALESCE(grupo_categoria, '')) LIKE '%RECEIT%' OR upper(COALESCE(nome, '')) LIKE '%N.F%' OR upper(COALESCE(nome, '')) LIKE '%RECIBO%' ORDER BY nome"),
      listar(db, 'SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
      listar(db, 'SELECT id, banco, numero_conta FROM contas_bancarias ORDER BY banco'),
    ])
    return c.json({ cotistas, aeronaves, categoriasReceita, categoriasDespesa, contasBancarias })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/notas-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const notas = await listar(db, `SELECT n.id, 'nf_saida' AS origem, n.numero, n.cotista_id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cliente_nome, COALESCE(cl.cnpj, hs.cpf) AS cliente_cnpj, COALESCE(cl.endereco, hs.endereco) AS cliente_endereco, COALESCE(cl.cidade, hs.cidade) AS cliente_cidade, COALESCE(cl.uf, hs.uf) AS cliente_uf, cl.email_principal AS cliente_email, n.aeronave_id, a.matricula_registro AS aeronave_matricula, n.data_emissao AS data_criacao, n.data_vencimento, n.valor_total, n.nome_categoria AS categoria, n.descricao_servico AS descricao, n.status, n.arquivo_pdf_url, n.criado_em, n.atualizado_em, cr.id AS contas_areceber_id FROM notas_fiscais_saida n LEFT JOIN cotista_aeronave ca ON ca.id = n.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id LEFT JOIN aeronave a ON a.id = n.aeronave_id LEFT JOIN contas_areceber cr ON cr.nf_saida_id = n.id ORDER BY date(n.data_emissao) DESC, n.criado_em DESC`)
    const recibos = await listar(db, `SELECT r.id, 'recibo_saida' AS origem, r.numero_recibo, r.cotista_id AS cotista_aeronave_id, ca.cliente_id, ca.socio_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cliente_nome, COALESCE(cl.cnpj, hs.cpf) AS cliente_cnpj, COALESCE(cl.endereco, hs.endereco) AS cliente_endereco, COALESCE(cl.cidade, hs.cidade) AS cliente_cidade, COALESCE(cl.uf, hs.uf) AS cliente_uf, cl.email_principal AS cliente_email, r.aeronave_id, a.matricula_registro AS aeronave_matricula, r.data_emissao, r.data_vencimento, r.valor_total, r.nome_categoria, r.descricao_servico, r.status, r.pdf_url, r.contas_areceber_id, r.criado_em, r.atualizado_em FROM recibos_saida r LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id LEFT JOIN aeronave a ON a.id = r.aeronave_id ORDER BY date(r.data_emissao) DESC, r.criado_em DESC`)
    return c.json({ notas, recibos })
  } catch (error) { return errorResponse(c, error) }
})

async function categoriaClienteNota(db: D1Database, id: string, subcategoria: string | null) {
  if (!id) return { id: null, nome: null, subcategoria }
  const row = await db.prepare('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!row) return { id: null, nome: null, subcategoria }
  const subcategorias = [row.subcategoria_1, row.subcategoria_2, row.subcategoria_3, row.subcategoria_4].map((value) => String(value ?? '').trim()).filter(Boolean)
  return { id: String(row.id), nome: String(row.nome ?? '').trim() || null, subcategoria: subcategoria || subcategorias[0] || null }
}

function documentoSaidaRow(db: D1Database, id: string) {
  return db.prepare(`SELECT n.*, cr.id AS contas_areceber_id
    FROM notas_fiscais_saida n
    LEFT JOIN contas_areceber cr ON cr.nf_saida_id = n.id
    WHERE n.id = ?`).bind(id).first<Record<string, unknown>>()
}

function notaSaidaStatements(db: D1Database, nota: {
  id: string
  numero: string
  cotistaId: string
  aeronaveId: string
  valor: number
  descricao: string
  categoriaNome: string
  categoriaId: string
  subcategoria: string | null
  dataEmissao: string
  dataVencimento: string
  status: string
  arquivoPdfUrl: string | null
  lancamentoId: string
  contaReceberId: string
}): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  statements.push(db.prepare(`INSERT INTO notas_fiscais_saida
    (id, numero, cotista_id, aeronave_id, valor_total, percentual, descricao_servico, nome_categoria,
     categoria_id, subcategoria_1, data_emissao, data_vencimento, status, arquivo_pdf_url, lancamentos_id)
    VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(nota.id, nota.numero, nota.cotistaId, nota.aeronaveId, nota.valor, nota.descricao,
      nota.categoriaNome, nota.categoriaId, nota.subcategoria, nota.dataEmissao, nota.dataVencimento,
      nota.status, nota.arquivoPdfUrl, nota.lancamentoId))
  statements.push(db.prepare(`UPDATE contas_areceber
    SET nf_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ? AND (nf_saida_id IS NULL OR nf_saida_id = ?)`)
    .bind(nota.id, nota.contaReceberId, nota.id))
  return statements
}

financeiroRoutes.post('/notas-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const numero = String(body.numero ?? '').trim()
    const cotistaId = String(body.cotista_id ?? body.cotista_aeronave_id ?? '').trim()
    const aeronaveId = String(body.aeronave_id ?? '').trim()
    const dataEmissao = String(body.data_emissao ?? '').trim()
    const dataVencimento = String(body.data_vencimento ?? dataEmissao).trim()
    const descricao = String(body.descricao_servico ?? body.descricao ?? '').trim()
    const valor = Number(body.valor_total ?? body.valor ?? 0)
    const categoriaReceitaId = String(body.categoria_receita_id ?? '').trim()
    const categoriaClienteId = String(body.categoria_id ?? '').trim()
    if (!numero || !cotistaId || !aeronaveId || !categoriaReceitaId || !(valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) || !descricao) {
      return c.json({ error: 'numero, cotista_id, aeronave_id, categoria_receita_id, valor_total, data_emissao e descricao_servico são obrigatórios' }, 400)
    }
    const cotista = await db.prepare('SELECT id FROM cotista_aeronave WHERE id = ? AND aeronave_id = ?').bind(cotistaId, aeronaveId).first()
    if (!cotista) return c.json({ error: 'cotista_aeronave_invalido' }, 400)
    const categoriaReceita = await db.prepare('SELECT id, nome FROM categoria_movimentacao_share WHERE id = ?').bind(categoriaReceitaId).first<{ id: string; nome: string }>()
    if (!categoriaReceita) return c.json({ error: 'categoria_receita_invalida' }, 400)
    const categoriaCliente = await categoriaClienteNota(db, categoriaClienteId, String(body.subcategoria_1 ?? '').trim() || null)
    if (categoriaClienteId && !categoriaCliente.id) return c.json({ error: 'categoria_despesa_invalida' }, 400)
    const id = crypto.randomUUID()
    const requestKey = String(body.idempotency_key ?? '').trim() || id
    const idempotencyKey = `nf_saida:${requestKey}`
    const dadosNota = {
      numero,
      cotistaId,
      aeronaveId,
      valor,
      descricao,
      categoriaNome: String(body.categoria_receita_nome ?? categoriaReceita.nome),
      categoriaId: categoriaReceitaId,
      subcategoria: categoriaCliente.subcategoria,
      dataEmissao,
      dataVencimento,
      status: ['PAGO', 'RECEBIDO', 'PAID'].includes(String(body.status ?? '').trim().toUpperCase()) ? 'PAGO' : 'EM_ABERTO',
      arquivoPdfUrl: body.arquivo_pdf_url ? String(body.arquivo_pdf_url) : null,
    }
    const financeiro = await issueRevenue(db, {
      idempotency_key: idempotencyKey,
      valor_centavos: Math.round(valor * 100),
      descricao,
      data: dataEmissao,
      data_emissao: dataEmissao,
      data_vencimento: dataVencimento,
      aeronave_id: aeronaveId,
      cotista_aeronave_id: cotistaId,
      categoria_id: categoriaReceitaId,
      categoria_nome: body.categoria_receita_nome ?? categoriaReceita.nome,
      categoria_cliente_id: categoriaCliente.id,
      categoria_cliente_nome: categoriaCliente.nome,
      categoria_despesa_subcategoria: categoriaCliente.subcategoria,
      origem_tipo: 'NF_SAIDA',
      origem_id: id,
      periodicidade: 'MENSAL',
    }, c.get('userId') || null, {}, ({ lancamentoId, contaReceberId }) =>
      notaSaidaStatements(db, { ...dadosNota, id, lancamentoId, contaReceberId }))

    if (financeiro.idempotent) {
      const conta = await db.prepare(`SELECT id, nf_saida_id, lancamentos_id
        FROM contas_areceber WHERE idempotency_key = ? LIMIT 1`).bind(idempotencyKey)
        .first<{ id: string; nf_saida_id: string | null; lancamentos_id: string | null }>()
      if (!conta?.id || !conta.lancamentos_id) return c.json({ error: 'operacao_financeira_incompleta' }, 409)
      const notaExistente = conta.nf_saida_id
        ? await documentoSaidaRow(db, conta.nf_saida_id)
        : await db.prepare('SELECT id FROM notas_fiscais_saida WHERE lancamentos_id = ? LIMIT 1')
          .bind(conta.lancamentos_id).first<{ id: string }>()
      if (notaExistente) {
        if (!conta.nf_saida_id) {
          await db.prepare(`UPDATE contas_areceber SET nf_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP
            WHERE id = ? AND nf_saida_id IS NULL`).bind(notaExistente.id, conta.id).run()
        }
        return c.json({ nota: await documentoSaidaRow(db, String(notaExistente.id)) }, 200)
      }
      const notaId = conta.nf_saida_id || id
      await db.batch(notaSaidaStatements(db, {
        ...dadosNota, id: notaId, lancamentoId: conta.lancamentos_id, contaReceberId: conta.id,
      }))
      return c.json({ nota: await documentoSaidaRow(db, notaId) }, 200)
    }

    const nota = await documentoSaidaRow(db, id)
    if (!nota) return c.json({ error: 'nota_saida_nao_persistida' }, 500)
    return c.json({ nota }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.patch('/notas-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    if (!(await documentoSaidaRow(db, id))) return c.json({ error: 'nota_saida_nao_encontrada' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const fields: Array<[string, unknown]> = []
    const add = (column: string, value: unknown) => { if (value !== undefined) fields.push([column, value === '' ? null : value]) }
    add('numero', body.numero); add('cotista_id', body.cotista_id ?? body.cotista_aeronave_id); add('aeronave_id', body.aeronave_id)
    add('data_emissao', body.data_emissao); add('data_vencimento', body.data_vencimento); add('valor_total', body.valor_total ?? body.valor)
    add('nome_categoria', body.nome_categoria); add('descricao_servico', body.descricao_servico ?? body.descricao); add('status', body.status)
    add('arquivo_pdf_url', body.arquivo_pdf_url)
    if (!fields.length) return c.json({ error: 'nenhum_campo_atualizavel' }, 400)
    const assignments = fields.map(([column]) => `${column} = ?`).join(', ')
    await db.prepare(`UPDATE notas_fiscais_saida SET ${assignments}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(...fields.map(([, value]) => value), id).run()
    return c.json({ nota: await documentoSaidaRow(db, id) })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.delete('/notas-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const nota = await documentoSaidaRow(db, id)
    if (!nota) return c.json({ error: 'nota_saida_nao_encontrada' }, 404)
    const contaId = String(nota.contas_areceber_id ?? '').trim()
    const lancamentoId = String(nota.lancamentos_id ?? '').trim()
    const conta = contaId ? await db.prepare('SELECT lancamentos_id FROM contas_areceber WHERE id = ?').bind(contaId).first<{ lancamentos_id: string | null }>() : null
    const lancamentos = [...new Set([lancamentoId, conta?.lancamentos_id ?? ''].filter(Boolean))]
    const espelhos = lancamentos.length ? await listar(db, `SELECT id FROM lancamentos WHERE origem_id IN (${lancamentos.map(() => '?').join(', ')})`, ...lancamentos) : []
    lancamentos.push(...espelhos.map((row) => String(row.id)).filter(Boolean))
    const ids = [...new Set(lancamentos)]
    const statements: D1PreparedStatement[] = []
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(', ')
      const rateios = await listar(db, `SELECT id FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`, ...ids)
      const rateioIds = rateios.map((row) => String(row.id)).filter(Boolean)
      if (rateioIds.length) statements.push(db.prepare(`DELETE FROM rateio_pagamentos WHERE rateio_id IN (${rateioIds.map(() => '?').join(', ')})`).bind(...rateioIds))
      statements.push(db.prepare(`DELETE FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`).bind(...ids))
      statements.push(db.prepare(`DELETE FROM financeiro_vinculos WHERE origem_id IN (${placeholders}) OR destino_id IN (${placeholders}) OR origem_id = ? OR destino_id = ?`).bind(...ids, ...ids, id, id))
      statements.push(db.prepare(`DELETE FROM lancamentos WHERE id IN (${placeholders})`).bind(...ids))
    } else {
      statements.push(db.prepare('DELETE FROM financeiro_vinculos WHERE origem_id = ? OR destino_id = ?').bind(id, id))
    }
    if (contaId) statements.push(db.prepare('DELETE FROM contas_areceber WHERE id = ?').bind(contaId))
    statements.push(db.prepare('DELETE FROM notas_fiscais_saida WHERE id = ?').bind(id))
    await db.batch(statements)
    return c.json({ ok: true, id })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/notas-saida/:id/dar-baixa', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const nota = await documentoSaidaRow(c.env.SHARE_DB, c.req.param('id'))
    if (!nota) return c.json({ error: 'nota_saida_nao_encontrada' }, 404)
    const contaId = String(nota.contas_areceber_id ?? '').trim()
    if (!contaId) return c.json({ error: 'conta_a_receber_nao_vinculada' }, 409)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const dataPagamento = body.data_pagamento ?? body.data_recebimento
    const contaBancaria = body.conta_bancaria_id ?? body.conta_bancaria ?? body.banco_recebimento
    const pagamentos = Array.isArray(body.pagamentos) && body.pagamentos.length
      ? body.pagamentos
      : [{
          tipo_pagador: 'COTISTA',
          pagador_cotista_id: nota.cotista_id,
          valor_centavos: Math.round(Number(nota.valor_total ?? 0) * 100),
          data_pagamento: dataPagamento,
          conta_bancaria_id: contaBancaria,
          forma_pagamento: body.forma_pagamento,
          comprovante_url: body.comprovante_url,
        }]
    const conta = await settleReceivable(c.env.SHARE_DB, contaId, {
      data_recebimento: dataPagamento,
      conta_bancaria_id: contaBancaria,
      forma_pagamento: body.forma_pagamento,
      comprovante_url: body.comprovante_url,
      pagamentos,
    }, c.get('userId') || null)
    return c.json({ ok: true, conta })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/notas-saida/anexos', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const origem = String(form.origem ?? 'nota_fiscal_saida')
    const documentoId = String(form.documento_id ?? '').trim() || crypto.randomUUID()
    const prefixo = origem === 'recibo_saida' ? 'recibo_saida' : 'nota_fiscal_saida'
    const id = crypto.randomUUID()
    const key = `share/${prefixo}/${documentoId}/${id}-${arquivo.name}`
    await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
    const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
    const url = publicBase
      ? `${publicBase}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
      : `/api/financeiro/notas-saida/anexos/${id}/arquivo?key=${encodeURIComponent(key)}`
    return c.json({ id, url }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/notas-saida/anexos/:id/arquivo', async (c) => {
  const denied = await requireCaixaShareAccess(c); if (denied) return denied
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const key = c.req.query('key')
  if (!key) return c.notFound()
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
})

function anexosDashboardFinanceiro(row: Record<string, unknown>, prefix: 'lancamento' | 'movimento_holding') {
  const origemId = String(row.id ?? '')
  if (!origemId) return []
  let anexosJson: unknown[] = []
  try {
    const parsed = JSON.parse(String(row.anexos_json || '[]'))
    if (Array.isArray(parsed)) anexosJson = parsed
  } catch { /* mantém os anexos por URL */ }
  const urls: Array<[string, string]> = [
    ['url_nf', 'Nota fiscal'],
    ['url_boleto', 'Boleto'],
    ['url_doc', 'Documento'],
    ['url_demonstrativo', 'Demonstrativo'],
    ['comprovante_url', 'Comprovante'],
  ]
  const itens = anexosJson.map((anexo: any) => ({ id: `${prefix}:${origemId}`, nome: anexo?.nome || anexo?.filename || 'Documento anexado' }))
  for (const [campo, nome] of urls) if (row[campo]) itens.push({ id: `${prefix}:${origemId}`, nome })
  return itens
}

financeiroRoutes.get('/dashboard/financeiro', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const schema = await loadSchema(db)
    const holdingColumn = holdingMovementColumn(schema)
    const [receber, pagar, movimentacoes, movimentosHolding, rateiosDespesas, rateiosHold, emailsEnviados] = await Promise.all([
      listar(db, "SELECT ar.valor_centavos, ar.status FROM contas_areceber ar LEFT JOIN lancamentos l ON l.id = ar.lancamentos_id WHERE COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO' AND ar.status <> 'CANCELADO'"),
      listar(db, "SELECT cp.id, cp.lancamentos_id, cp.valor_centavos, cp.status, cp.data_vencimento FROM contas_apagar cp LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id WHERE COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO' AND cp.status <> 'CANCELADO'"),
      listar(db, `SELECT l.*, cl.email_principal AS destinatario_email, COALESCE(NULLIF(cl.codigo_cliente, ''), NULLIF(ca.codigo_cliente, ''), (SELECT NULLIF(ca_cliente.codigo_cliente, '') FROM cotista_aeronave ca_cliente WHERE ca_cliente.aeronave_id = l.aeronave_id AND ca_cliente.cliente_id = l.cliente_id LIMIT 1)) AS codigo_cliente FROM lancamentos l LEFT JOIN cliente cl ON cl.id = l.cliente_id LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id WHERE l.escopo_financeiro = 'FINANCEIRO' ORDER BY l.criado_em DESC LIMIT 100`),
      listar(db, `SELECT mh.*, h.nome AS holding_nome, hs.nome AS socio_nome, (SELECT ca.codigo_cliente FROM cotista_aeronave ca WHERE ca.aeronave_id = mh.aeronave_id AND ca.socio_id = mh.socio_id LIMIT 1) AS codigo_cliente FROM movimentos_holding mh LEFT JOIN holdings h ON h.id = mh.holding_id LEFT JOIN hold_socios hs ON hs.id = mh.socio_id WHERE mh.escopo_financeiro = 'FINANCEIRO' ORDER BY mh.criado_em DESC LIMIT 100`),
      listar(db, `SELECT l.*, e.id AS envio_id, e.tipo_caixa AS envio_tipo_caixa, COALESCE(l.id, e.id) AS origem_id, rd.id AS rateio_id, rd.cotista_id AS rateio_cotista_id, rd.data_emissao AS rateio_data_emissao, rd.data_vencimento AS rateio_data_vencimento, rd.categoria_nome AS rateio_categoria_nome, rd.tipo_rateio AS rateio_tipo_rateio, rd.percentual_sociedade AS rateio_percentual, rd.valor_rateado_centavos AS rateio_valor_centavos, rd.valor_pago_real_centavos AS rateio_valor_pago_centavos, rd.status AS rateio_status, rd.descricao_despesa AS rateio_descricao, rd.documento_numero AS rateio_documento, rd.numero_nf AS rateio_numero_nf, rd.numero_recibo AS rateio_numero_recibo, rd.numero_boleto AS rateio_numero_boleto, rd.numero_demonstrativo AS rateio_numero_demonstrativo, rd.numero_doc AS rateio_numero_doc, rd.url_nf AS rateio_url_nf, rd.url_recibo AS rateio_url_recibo, rd.url_boleto AS rateio_url_boleto, rd.url_demonstrativo AS rateio_url_demonstrativo, rd.url_doc AS rateio_url_doc, ca.codigo_cliente AS rateio_codigo_cliente, cl.razao_social AS rateio_participante_nome FROM rateio_despesas rd LEFT JOIN lancamentos l ON l.id = rd.lancamento_id LEFT JOIN envio_despesas e ON e.id = rd.lancamento_id LEFT JOIN cotista_aeronave ca ON ca.id = rd.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id WHERE COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO' AND UPPER(COALESCE(rd.status, '')) <> 'CANCELADO' ORDER BY rd.criado_em DESC LIMIT 300`),
      listar(db, `SELECT mh.*, e.tipo_caixa AS envio_tipo_caixa, rh.id AS rateio_id, rh.socio_id AS rateio_socio_id, rh.data_emissao AS rateio_data_emissao, rh.data_vencimento AS rateio_data_vencimento, rh.categoria_nome AS rateio_categoria_nome, rh.tipo_rateio AS rateio_tipo_rateio, rh.percentual_uso AS rateio_percentual, rh.valor_rateado_centavos AS rateio_valor_centavos, rh.valor_pago_real_centavos AS rateio_valor_pago_centavos, rh.status AS rateio_status, rh.descricao_despesa AS rateio_descricao, rh.documento_numero AS rateio_documento, rh.numero_nf AS rateio_numero_nf, rh.numero_recibo AS rateio_numero_recibo, rh.numero_boleto AS rateio_numero_boleto, rh.numero_demonstrativo AS rateio_numero_demonstrativo, rh.numero_doc AS rateio_numero_doc, rh.url_nf AS rateio_url_nf, rh.url_recibo AS rateio_url_recibo, rh.url_boleto AS rateio_url_boleto, rh.url_demonstrativo AS rateio_url_demonstrativo, rh.url_doc AS rateio_url_doc, hs.nome AS rateio_participante_nome FROM rateio_hold rh JOIN movimentos_holding mh ON mh.id = rh.${holdingColumn} LEFT JOIN envio_despesas e ON e.movimentos_holding_id = mh.id LEFT JOIN hold_socios hs ON hs.id = rh.socio_id WHERE mh.escopo_financeiro = 'FINANCEIRO' AND UPPER(COALESCE(rh.status, '')) <> 'CANCELADO' ORDER BY rh.criado_em DESC LIMIT 300`),
      listar(db, `SELECT e.id, e.destinatarios, e.assunto, e.status, e.anexos, e.erro_mensagem AS erro, e.criado_em, e.email_enviado_em FROM emails_enviados e WHERE (lower(COALESCE(e.referencia_tipo, '')) NOT IN ('nf_saida', 'recibo_saida', 'recibo_colaborador', 'despesa_empresa', 'solicitacao_compra') OR EXISTS (SELECT 1 FROM lancamentos l WHERE l.email_enviado_id = e.id AND l.escopo_financeiro = 'FINANCEIRO')) ORDER BY e.criado_em DESC LIMIT 200`),
    ])
    const hoje = new Date().toISOString().slice(0, 10)
    const contaPendente = (row: Record<string, unknown>) => {
      const status = String(row.status ?? '').toUpperCase()
      const vencida = Boolean(row.data_vencimento) && String(row.data_vencimento).slice(0, 10) < hoje
      return status === 'EM_ABERTO' || status === 'PENDENTE' || status === 'ATRASADO' || status === 'VENCIDO' || (vencida && !['PAGO', 'CANCELADO', 'RECEBIDO'].includes(status))
    }
    const totalAReceber = receber.reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const totalPago = pagar.filter((row) => String(row.status).toUpperCase() === 'PAGO').reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const lancamentosComFornecedor = await enriquecerFornecedores(db, movimentacoes)
    const movimentosHoldingComFornecedor = await enriquecerFornecedores(db, movimentosHolding)
    const rateiosDespesasComFornecedor = await enriquecerFornecedores(db, rateiosDespesas.map((row) => ({
      ...row,
      id: row.rateio_id,
      origem_id: row.origem_id ?? row.id,
      descricao: row.rateio_descricao ?? row.descricao,
      numero_doc: row.rateio_documento ?? row.rateio_numero_doc ?? row.numero_doc,
      numero_nf: row.rateio_numero_nf ?? row.numero_nf,
      numero_recibo: row.rateio_numero_recibo ?? row.numero_recibo,
      numero_boleto: row.rateio_numero_boleto ?? row.numero_boleto,
      numero_demonstrativo: row.rateio_numero_demonstrativo ?? row.numero_demonstrativo,
      url_nf: row.rateio_url_nf ?? row.url_nf,
      url_recibo: row.rateio_url_recibo ?? row.url_recibo,
      url_boleto: row.rateio_url_boleto ?? row.url_boleto,
      url_demonstrativo: row.rateio_url_demonstrativo ?? row.url_demonstrativo,
      url_doc: row.rateio_url_doc ?? row.url_doc,
      tipo_caixa: row.tipo_caixa ?? row.envio_tipo_caixa,
      data_emissao: row.rateio_data_emissao ?? row.data_emissao,
      data_vencimento: row.rateio_data_vencimento ?? row.data_vencimento,
      categoria_nome: row.rateio_categoria_nome ?? row.categoria_nome,
      grupo_categoria: row.rateio_tipo_rateio ?? row.grupo_categoria,
      cotista_aeronave_id: row.rateio_cotista_id,
      codigo_cliente: row.rateio_codigo_cliente,
      participante_nome: row.rateio_participante_nome,
      status: row.rateio_status,
      valor_centavos: row.rateio_valor_centavos,
      valor: Number(row.rateio_valor_centavos || 0) / 100,
      valor_pago_real_centavos: row.rateio_valor_pago_centavos,
      origem_tipo: 'rateio_despesas',
    })))
    const rateiosHoldComFornecedor = await enriquecerFornecedores(db, rateiosHold.map((row) => ({
      ...row,
      id: row.rateio_id,
      origem_id: row.id,
      descricao: row.rateio_descricao ?? row.descricao,
      numero_doc: row.rateio_documento ?? row.rateio_numero_doc ?? row.numero_doc,
      numero_nf: row.rateio_numero_nf ?? row.numero_nf,
      numero_recibo: row.rateio_numero_recibo ?? row.numero_recibo,
      numero_boleto: row.rateio_numero_boleto ?? row.numero_boleto,
      numero_demonstrativo: row.rateio_numero_demonstrativo ?? row.numero_demonstrativo,
      url_nf: row.rateio_url_nf ?? row.url_nf,
      url_recibo: row.rateio_url_recibo ?? row.url_recibo,
      url_boleto: row.rateio_url_boleto ?? row.url_boleto,
      url_demonstrativo: row.rateio_url_demonstrativo ?? row.url_demonstrativo,
      url_doc: row.rateio_url_doc ?? row.url_doc,
      tipo_caixa: row.tipo_caixa ?? row.envio_tipo_caixa,
      data_emissao: row.rateio_data_emissao ?? row.data_emissao,
      data_vencimento: row.rateio_data_vencimento ?? row.data_vencimento,
      categoria_nome: row.rateio_categoria_nome ?? row.categoria_nome,
      grupo_categoria: row.rateio_tipo_rateio ?? row.grupo_categoria,
      socio_id: row.rateio_socio_id,
      socio_nome: row.rateio_participante_nome,
      status: row.rateio_status,
      valor_centavos: row.rateio_valor_centavos,
      valor: Number(row.rateio_valor_centavos || 0) / 100,
      valor_pago_real_centavos: row.rateio_valor_pago_centavos,
      origem_tipo: 'rateio_hold',
    })))
    const lancamentosComRateio = new Set(rateiosDespesasComFornecedor.map((row) => String(row.origem_id ?? '')).filter(Boolean))
    const movimentosHoldingComRateio = new Set(rateiosHoldComFornecedor.map((row) => String(row.origem_id ?? '')).filter(Boolean))
    const lancamentosExibidos = [
      ...rateiosDespesasComFornecedor,
      ...lancamentosComFornecedor.filter((row) => !lancamentosComRateio.has(String(row.id ?? ''))),
    ]
    const movimentosHoldingExibidos = [
      ...rateiosHoldComFornecedor,
      ...movimentosHoldingComFornecedor.filter((row) => !movimentosHoldingComRateio.has(String(row.id ?? ''))),
    ]
    const movimentacoesComFornecedor = [...lancamentosExibidos, ...movimentosHoldingExibidos]
    const lancIds = lancamentosComFornecedor.map((row) => String(row.id ?? '')).filter(Boolean)
    const reativacoes = lancIds.length
      ? await listar(db, `SELECT r.lancamento_id, rr.justificativa, rr.reativado_em
           FROM recibo_reativacoes rr
           JOIN recibos r ON r.id = rr.recibo_id
          WHERE r.lancamento_id IN (${lancIds.map(() => '?').join(', ')})
            AND UPPER(COALESCE(r.status, '')) <> 'CANCELADO'
          ORDER BY rr.reativado_em DESC`, ...lancIds).catch(() => [])
      : []
    const reativacaoPorLancamento = new Map<string, Record<string, unknown>>()
    reativacoes.forEach((row) => {
      const chave = String(row.lancamento_id ?? '')
      if (chave && !reativacaoPorLancamento.has(chave)) reativacaoPorLancamento.set(chave, row)
    })
    const contasPendentes = pagar.filter(contaPendente)
    const contasEmAberto = new Set(contasPendentes.flatMap((row) => [row.id, row.lancamentos_id].filter(Boolean).map(String)))
    return c.json({
      resumo: { total_a_receber: totalAReceber, total_pago: totalPago, pendencias: contasPendentes.length, pagamentos_confirmados: pagar.filter((row) => String(row.status).toUpperCase() === 'PAGO').length },
      lancamentos: lancamentosExibidos.map((row) => ({ ...row, destinatario_email: row.destinatario_email ?? null, anexos: anexosDashboardFinanceiro(row, 'lancamento'), fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null, valor: row.valor ?? Number(row.valor_centavos || 0) / 100, pendencia: [row.id, row.origem_id].filter(Boolean).some((id) => contasEmAberto.has(String(id))), justificativa_reativacao: reativacaoPorLancamento.get(String(row.origem_id ?? row.id))?.justificativa ?? null, reativado_em: reativacaoPorLancamento.get(String(row.origem_id ?? row.id))?.reativado_em ?? null })),
      movimentos_holding: movimentosHoldingExibidos.map((row) => ({ ...row, tipo_caixa: 'HOLDING', anexos: anexosDashboardFinanceiro(row, 'movimento_holding'), fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null, valor: row.valor ?? Number(row.valor_centavos || 0) / 100, pendencia: [row.id, row.origem_id].filter(Boolean).some((id) => contasEmAberto.has(String(id))) })),
      movimentacoes: movimentacoesComFornecedor.map((row) => ({ ...row, fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null, valor: Number(row.valor_centavos || 0) / 100 })),
      emails_enviados: emailsEnviados
    })
  } catch (error) { return errorResponse(c, error) }
})

async function origemRateio(db: D1Database, origemTipo: string, origemId: string) {
  if (origemTipo === 'lancamentos') {
    const lancamento = await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(origemId).first<Record<string, unknown>>()
    if (!lancamento) return null
    return { kind: 'cliente' as const, source: lancamento, movimentoId: null }
  }
  if (origemTipo === 'movimentos_holding') {
    const movimento = await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(origemId).first<Record<string, unknown>>()
    if (!movimento) return null
    return { kind: 'holding' as const, source: movimento, movimentoId: origemId }
  }
  if (origemTipo === 'rateio_hold') {
    const rateio = await db.prepare('SELECT * FROM rateio_hold WHERE id = ?').bind(origemId).first<Record<string, unknown>>()
    if (!rateio) return null
    const movimentoId = String(rateio.movimento_id ?? rateio.movimentos_id ?? '').trim()
    const movimento = movimentoId ? await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first<Record<string, unknown>>() : null
    if (!movimento) return null
    return { kind: 'holding' as const, source: movimento, movimentoId }
  }
  return null
}

financeiroRoutes.get('/dashboard/financeiro/movimentacoes/:origemTipo/:origemId/rateio-opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const origem = await origemRateio(db, c.req.param('origemTipo'), c.req.param('origemId'))
    if (!origem) return c.json({ error: 'movimentacao_nao_encontrada' }, 404)
    const aeronaveId = String(origem.source.aeronave_id ?? '').trim()
    if (!aeronaveId) return c.json({ error: 'aeronave_obrigatoria_para_rateio' }, 409)
    const rows = origem.kind === 'cliente'
      ? await listar(db, `SELECT ca.id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, ca.id) AS nome, COALESCE(ca.percentual_sociedade, 0) AS percentual_sugerido FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.aeronave_id = ? ORDER BY nome`, aeronaveId)
      : await listar(db, `SELECT DISTINCT hs.id, COALESCE(hs.nome, hs.id) AS nome, COALESCE(ca.percentual_sociedade, 0) AS percentual_sugerido FROM hold_socios hs LEFT JOIN cotista_aeronave ca ON ca.socio_id = hs.id AND ca.aeronave_id = ? WHERE hs.id IN (SELECT socio_id FROM cotista_aeronave WHERE aeronave_id = ? AND socio_id IS NOT NULL) ORDER BY nome`, aeronaveId, aeronaveId)
    return c.json({
      origem_tipo: c.req.param('origemTipo'),
      origem_id: c.req.param('origemId'),
      valor_centavos: Number(origem.source.valor_centavos ?? origem.source.valor_rateado_centavos ?? 0),
      data_vencimento: origem.source.data_vencimento ? String(origem.source.data_vencimento).slice(0, 10) : null,
      periodicidade: origem.source.periodicidade ? String(origem.source.periodicidade).toUpperCase() : null,
      cotistas: rows,
    })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/dashboard/financeiro/movimentacoes/:origemTipo/:origemId/rateio', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const origem = await origemRateio(db, c.req.param('origemTipo'), c.req.param('origemId'))
    if (!origem) return c.json({ error: 'movimentacao_nao_encontrada' }, 404)
    const body = await c.req.json<Record<string, unknown>>()
    const linhas = Array.isArray(body.linhas) ? body.linhas as Array<Record<string, unknown>> : []
    const total = linhas.reduce((sum, line) => sum + Number(line.percentual ?? 0), 0)
    if (!linhas.length || Math.abs(total - 100) > 0.01) return c.json({ error: 'percentuais_devem_totalizar_100' }, 400)
    const aeronaveId = String(origem.source.aeronave_id ?? '').trim()
    const valorTotal = Number(origem.source.valor_centavos ?? origem.source.valor_rateado_centavos ?? 0)
    if (!aeronaveId || !Number.isInteger(valorTotal) || valorTotal <= 0) return c.json({ error: 'valor_ou_aeronave_invalidos' }, 400)
    const dataEmissao = String(origem.source.data_emissao ?? origem.source.data ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
    const dataVencimento = String(body.data_vencimento ?? dataEmissao).slice(0, 10)
    const periodicidade = String(body.periodicidade ?? 'EVENTUAL').toUpperCase()
    const tipoRateio = String(body.tipo_rateio ?? 'EXTRA').toUpperCase()
    const descricao = String(origem.source.descricao ?? origem.source.descricao_despesa ?? 'Despesa financeira')
    const categoriaId = origem.source.categoria_id ?? null
    const categoriaNome = origem.source.categoria_nome ?? null
    const rateioIds: string[] = []
    const statements: D1PreparedStatement[] = []
    for (const linha of linhas) {
      const id = crypto.randomUUID(); rateioIds.push(id)
      const percentual = Number(linha.percentual); const rateado = Math.round(valorTotal * percentual / 100)
      if (origem.kind === 'cliente') {
        const cotista = await db.prepare('SELECT id, percentual_sociedade FROM cotista_aeronave WHERE id = ? AND aeronave_id = ?').bind(String(linha.cotista_id ?? ''), aeronaveId).first<{ id: string; percentual_sociedade: number | null }>()
        if (!cotista) return c.json({ error: 'cotista_cliente_invalido' }, 400)
        statements.push(db.prepare(`INSERT INTO rateio_despesas (id, lancamento_id, aeronave_id, cotista_id, data_emissao, data_vencimento, categoria_id, categoria_nome, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, tipo_rateio, periodicidade, status, descricao_despesa, pago_diretamente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'EM_ABERTO', ?, 0)`).bind(id, c.req.param('origemId'), aeronaveId, cotista.id, dataEmissao, dataVencimento, categoriaId, categoriaNome, Number(cotista.percentual_sociedade ?? 0), percentual, valorTotal, rateado, tipoRateio, periodicidade, descricao))
      } else {
        const socio = await db.prepare('SELECT id FROM hold_socios WHERE id = ?').bind(String(linha.cotista_id ?? '')).first<{ id: string }>()
        if (!socio || !origem.movimentoId) return c.json({ error: 'socio_holding_invalido' }, 400)
        statements.push(db.prepare(`INSERT INTO rateio_hold (id, movimento_id, aeronave_id, socio_id, data_emissao, data_vencimento, categoria_id, categoria_nome, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, tipo_rateio, periodicidade, status, descricao_despesa) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'EM_ABERTO', ?)`).bind(id, origem.movimentoId, aeronaveId, socio.id, dataEmissao, dataVencimento, categoriaId, categoriaNome, percentual, valorTotal, rateado, tipoRateio, periodicidade, descricao))
      }
    }
    await db.batch(statements)
    return c.json({ ok: true, rateio_ids: rateioIds }, 201)
  } catch (error) { return errorResponse(c, error) }
})


financeiroRoutes.get('/dashboard/financeiro/movimentacoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const [abastecimentos, recibos, reembolsos, relatorios] = await Promise.all([
      listar(db, `SELECT a.id, a.numero_voo, a.data, a.numero_nf, a.numero_comanda, a.valor_total, a.status, a.observacao AS descricao, 'abastecimento' AS origem, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, a.cliente_id, a.socio_id, 'Cotista não informado') AS cotista_nome, 'CLIENTE' AS tipo_caixa FROM abastecimentos a LEFT JOIN cliente cl ON cl.id = a.cliente_id LEFT JOIN hold_socios hs ON hs.id = a.socio_id LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = a.aeronave_id AND (ca.cliente_id = a.cliente_id OR ca.socio_id = a.socio_id) ORDER BY date(a.data) DESC, a.id DESC LIMIT 1000`),
      listar(db, `SELECT r.id, NULL AS numero_voo, r.data_emissao AS data, COALESCE(r.numero_documento_anexo, r.numero_recibo) AS numero_doc, r.descricao, r.valor, r.status, r.tipo_caixa, 'recibo' AS origem, COALESCE(cl.razao_social, hs.nome, r.nome_pagador, 'Cotista não informado') AS cotista_nome FROM recibos r LEFT JOIN cliente cl ON cl.id = r.pagador_id AND r.pagador_tipo = 'cotista_aeronave' LEFT JOIN hold_socios hs ON hs.id = r.pagador_id AND r.pagador_tipo = 'cotista_aeronave' WHERE EXISTS (SELECT 1 FROM lancamentos l WHERE l.origem_id = r.id AND l.escopo_financeiro = 'FINANCEIRO') ORDER BY date(r.data_emissao) DESC, r.id DESC LIMIT 1000`),
      listar(db, `SELECT r.id, NULL AS numero_voo, r.criado_em AS data, NULL AS numero_doc, 'Reembolso' AS descricao, r.valor_centavos, r.status, 'CLIENTE' AS tipo_caixa, 'reembolso' AS origem, COALESCE(cl.razao_social, hs.nome, r.cotista_id, 'Cotista não informado') AS cotista_nome FROM reembolsos r LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE EXISTS (SELECT 1 FROM lancamentos l WHERE l.id = r.lancamento_origem_id AND l.escopo_financeiro = 'FINANCEIRO') ORDER BY date(r.criado_em) DESC, r.id DESC LIMIT 1000`),
      listar(db, `SELECT r.id, r.numero_voo, r.data_inicio AS data, r.numero_relatorio AS numero_doc, 'Relatório de despesa de viagem' AS descricao, r.total_valor AS valor, r.status, 'CLIENTE' AS tipo_caixa, 'relatorio_despesa_viagem' AS origem, CASE WHEN r.socio_id IS NOT NULL THEN COALESCE(NULLIF(hs.nome, ''), ca.codigo_cliente) ELSE COALESCE(NULLIF(cl.razao_social, ''), NULLIF(h.nome, ''), NULLIF(hs_holding.nome, ''), ca.codigo_cliente) END AS cotista_nome FROM relatorio_despesa_viagem r LEFT JOIN cliente cl ON cl.id = r.cliente_id LEFT JOIN holdings h ON h.id = r.cliente_id LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = r.aeronave_id AND ((r.socio_id IS NOT NULL AND ca.socio_id = r.socio_id) OR (r.cliente_id IS NOT NULL AND (ca.cliente_id = r.cliente_id OR ca.id = r.cliente_id))) LEFT JOIN hold_socios hs ON hs.id = COALESCE(r.socio_id, ca.socio_id) LEFT JOIN holdings hs_holding ON hs_holding.id = hs.holding_id WHERE EXISTS (SELECT 1 FROM lancamentos l WHERE l.origem_id = r.id AND l.escopo_financeiro = 'FINANCEIRO') ORDER BY date(r.data_inicio) DESC, r.id DESC LIMIT 1000`),
    ])
    const rows: Record<string, unknown>[] = [
      ...abastecimentos.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor_total || 0), numero_doc: row.numero_nf || row.numero_comanda || null })),
      ...recibos.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor || 0) / 100 })),
      ...reembolsos.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor_centavos || 0) / 100 })),
      ...relatorios.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor || 0) })),
    ]
    const pastas = new Map<string, { id: string; nome: string; quantidade: number; voos: Map<string, { numero_voo: string; quantidade: number; despesas: Record<string, unknown>[] }> }>()
    for (const row of rows) {
      // A tela representa apenas despesas vinculadas a um voo. Registros sem
      // número de voo não podem aparecer como uma pasta/voo artificial.
      const numeroVoo = String(row.numero_voo || '').trim()
      if (!numeroVoo) continue
      const nome = String(row.cotista_nome || 'Cotista não informado').trim() || 'Cotista não informado'
      const pastaId = nome.toLocaleLowerCase()
      let pasta = pastas.get(pastaId)
      if (!pasta) { pasta = { id: pastaId, nome, quantidade: 0, voos: new Map() }; pastas.set(pastaId, pasta) }
      let voo = pasta.voos.get(numeroVoo)
      if (!voo) { voo = { numero_voo: numeroVoo, quantidade: 0, despesas: [] }; pasta.voos.set(numeroVoo, voo) }
      voo.despesas.push({ ...row, email: 'NÃO INFORMADO', valor: Number(row.valor || 0), data: row.data || null }); voo.quantidade += 1; pasta.quantidade += 1
    }
    return c.json({ pastas: [...pastas.values()].map((pasta) => ({ ...pasta, voos: [...pasta.voos.values()] })) })
  } catch (error) { return errorResponse(c, error) }
})


function calcularCompensacaoBalanco(rows: Record<string, unknown>[]) {
  const devido = new Map<string, number>()
  const pago = new Map<string, number>()
  const nomes = new Map<string, string>()
  for (const row of rows) {
    if (String(row.fluxo ?? 'SAIDA').toUpperCase() === 'ENTRADA') continue
    const participante = String(row.participante_id ?? '').trim()
    const nome = String(row.participante_nome ?? '').trim()
    if (participante && nome) nomes.set(participante, nome)
    const valorDevido = Math.max(0, Number(row.valor_rateado_centavos ?? row.valor_centavos ?? 0))
    if (participante) devido.set(participante, (devido.get(participante) || 0) + valorDevido)
    const pagador = String(row.pago_por ?? '').trim() || (Number(row.pago_diretamente || 0) ? participante : '')
    const valorPago = Math.max(0, Number(row.valor_pago_centavos ?? 0))
    if (pagador && valorPago) pago.set(pagador, (pago.get(pagador) || 0) + valorPago)
  }
  const ids = [...new Set([...devido.keys(), ...pago.keys()])]
  const saldos = ids.map((cotista) => {
    const totalPagoCentavos = pago.get(cotista) || 0
    const totalDevidoCentavos = devido.get(cotista) || 0
    return { cotista: nomes.get(cotista) || cotista, cotistaId: cotista, totalPagoCentavos, totalDevidoCentavos, saldoCentavos: totalPagoCentavos - totalDevidoCentavos }
  }).sort((a, b) => Math.abs(b.saldoCentavos) - Math.abs(a.saldoCentavos))
  const matriz: Record<string, Record<string, number>> = {}
  for (const credor of ids) matriz[credor] = Object.fromEntries(ids.map((devedor) => [devedor, 0]))
  const credores = saldos.filter((item) => item.saldoCentavos > 0).map((item) => ({ id: item.cotista, valor: item.saldoCentavos }))
  const devedores = saldos.filter((item) => item.saldoCentavos < 0).map((item) => ({ id: item.cotista, valor: -item.saldoCentavos }))
  let credorIndex = 0
  let devedorIndex = 0
  while (credorIndex < credores.length && devedorIndex < devedores.length) {
    const valor = Math.min(credores[credorIndex].valor, devedores[devedorIndex].valor)
    matriz[credores[credorIndex].id][devedores[devedorIndex].id] = valor
    credores[credorIndex].valor -= valor
    devedores[devedorIndex].valor -= valor
    if (credores[credorIndex].valor === 0) credorIndex += 1
    if (devedores[devedorIndex].valor === 0) devedorIndex += 1
  }
  return { saldos, matrizCompensacao: matriz }
}

financeiroRoutes.get('/cotista/dashboard', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const schema = await loadSchema(db)
    const holdingColumn = holdingMovementColumn(schema)
    const inicio = c.req.query('inicio')
    const fim = c.req.query('fim')
    const aeronaveId = c.req.query('aeronave_id')
    const cotistaId = c.req.query('cotista_id')
    const cotistaAeronaveId = cotistaId
    let cotistaClienteId = cotistaId
    let cotistaSocioId: string | undefined
    if (cotistaId) {
      const cotista = await db.prepare('SELECT socio_id FROM cotista_aeronave WHERE id = ?').bind(cotistaId).first<{ socio_id: string | null }>()
      if (cotista?.socio_id) {
        cotistaSocioId = cotista.socio_id
        cotistaClienteId = undefined
      } else if (!cotista) {
        const socio = await db.prepare('SELECT id FROM hold_socios WHERE id = ?').bind(cotistaId).first<{ id: string }>()
        if (socio) {
          cotistaSocioId = socio.id
          cotistaClienteId = undefined
        }
      }
    }
    const filtrosCliente: string[] = []
    const filtrosHolding: string[] = []
    const filtrosLancamentos: string[] = ["UPPER(COALESCE(l.status, '')) <> 'CANCELADO'"]
    const paramsCliente: unknown[] = []
    const paramsHolding: unknown[] = []
    const paramsLancamentos: unknown[] = []
    const filtrosMovimento: string[] = ["mh.tipo_caixa = 'HOLD'", "UPPER(COALESCE(mh.fluxo, '')) IN ('SAIDA', 'ENTRADA', 'APORTE', 'REEMBOLSO', 'ESTORNO')", "UPPER(COALESCE(mh.status, '')) <> 'CANCELADO'"]
    const paramsMovimento: unknown[] = []
    if (schema.get('movimentos_holding')?.has('escopo_financeiro')) filtrosMovimento.push("COALESCE(mh.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO'")
    if (inicio) { filtrosCliente.push('date(r.data_emissao) >= date(?)'); paramsCliente.push(inicio); filtrosHolding.push('date(r.data_emissao) >= date(?)'); paramsHolding.push(inicio); filtrosLancamentos.push('date(l.data_emissao) >= date(?)'); paramsLancamentos.push(inicio) }
    if (fim) { filtrosCliente.push('date(r.data_emissao) <= date(?)'); paramsCliente.push(fim); filtrosHolding.push('date(r.data_emissao) <= date(?)'); paramsHolding.push(fim); filtrosLancamentos.push('date(l.data_emissao) <= date(?)'); paramsLancamentos.push(fim) }
    if (aeronaveId) { filtrosCliente.push('r.aeronave_id = ?'); paramsCliente.push(aeronaveId); filtrosHolding.push('r.aeronave_id = ?'); paramsHolding.push(aeronaveId); filtrosLancamentos.push('l.aeronave_id = ?'); paramsLancamentos.push(aeronaveId) }
    if (cotistaClienteId) { filtrosCliente.push('r.cotista_id = ?'); paramsCliente.push(cotistaClienteId) }
    if (cotistaAeronaveId) { filtrosLancamentos.push('l.cotista_aeronave_id = ?'); paramsLancamentos.push(cotistaAeronaveId) }
    if (cotistaId && cotistaSocioId) filtrosCliente.push('1 = 0')
    if (cotistaId && !cotistaSocioId) { filtrosHolding.push('1 = 0'); filtrosMovimento.push('1 = 0') }
    if (cotistaSocioId) { filtrosHolding.push('r.socio_id = ?'); paramsHolding.push(cotistaSocioId); filtrosMovimento.push('mh.socio_id = ?'); paramsMovimento.push(cotistaSocioId) }
    if (inicio) { filtrosMovimento.push('date(mh.data_emissao) >= date(?)'); paramsMovimento.push(inicio) }
    if (fim) { filtrosMovimento.push('date(mh.data_emissao) <= date(?)'); paramsMovimento.push(fim) }
    if (aeronaveId) { filtrosMovimento.push('mh.aeronave_id = ?'); paramsMovimento.push(aeronaveId) }
    const lancamentoSemRateio = "NOT EXISTS (SELECT 1 FROM rateio_despesas rd WHERE rd.lancamento_id = l.id AND UPPER(COALESCE(rd.status, '')) <> 'CANCELADO')"
    const movimentoHoldingSemRateio = `NOT EXISTS (SELECT 1 FROM rateio_hold rh WHERE rh.${holdingColumn} = mh.id AND UPPER(COALESCE(rh.status, '')) <> 'CANCELADO')`
    const rows = await listar(c.env.SHARE_DB, `
      SELECT r.id, r.aeronave_id, r.cotista_id AS participante_id, r.data_emissao AS data, r.descricao_despesa AS descricao,
             r.documento_numero AS numero_doc, r.fornecedor_id, r.categoria_nome, r.tipo_rateio AS grupo_categoria,
             r.data_vencimento, 'SAIDA' AS fluxo, r.valor_rateado_centavos AS valor_centavos,
             r.valor_rateado_centavos AS valor_rateado_centavos,
             r.valor_pago_real_centavos AS valor_pago_centavos, r.pago_por AS pago_por, 'CLIENTE' AS tipo_caixa,
             r.pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado, r.status, r.observacoes,
             'rateio_despesas' AS origem_rateio, NULL AS local,
             COALESCE(cl.razao_social, ca.codigo_cliente, r.cotista_id) AS participante_nome
        FROM rateio_despesas r
        LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        WHERE ${[...filtrosCliente, "UPPER(COALESCE(r.status, '')) <> 'CANCELADO'"].join(' AND ')}
      UNION ALL
      SELECT r.id, r.aeronave_id, r.socio_id AS participante_id, r.data_emissao AS data, r.descricao_despesa AS descricao,
             r.documento_numero AS numero_doc, NULL AS fornecedor_id, r.categoria_nome, r.tipo_rateio AS grupo_categoria,
             r.data_vencimento, 'SAIDA' AS fluxo, r.valor_rateado_centavos AS valor_centavos,
             r.valor_rateado_centavos AS valor_rateado_centavos,
             r.valor_pago_real_centavos AS valor_pago_centavos, r.pago_por AS pago_por, 'HOLDING' AS tipo_caixa,
             r.pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado, r.status, r.observacoes,
             'rateio_hold' AS origem_rateio, NULL AS local,
             COALESCE(hs.nome, r.socio_id) AS participante_nome
        FROM rateio_hold r
        LEFT JOIN hold_socios hs ON hs.id = r.socio_id
        WHERE ${[...filtrosHolding, "UPPER(COALESCE(r.status, '')) <> 'CANCELADO'"].join(' AND ')}
      UNION ALL
      SELECT l.id, l.aeronave_id, l.cotista_aeronave_id AS participante_id, l.data_emissao AS data,
             l.descricao, COALESCE(l.numero_doc, l.numero_nf, l.numero_recibo) AS numero_doc,
             l.fornecedores_favoritos_id AS fornecedor_id, l.categoria_nome, l.grupo_categoria,
             l.data_vencimento, l.fluxo, l.valor_centavos, l.valor_centavos AS valor_rateado_centavos,
             0 AS valor_pago_centavos, l.pago_por, l.tipo_caixa, l.pago_diretamente,
             l.reembolsavel, l.reembolso_quitado, l.status, l.observacoes,
             'lancamentos' AS origem_rateio, NULL AS local,
             COALESCE(cl.razao_social, ca.codigo_cliente, l.cotista_aeronave_id) AS participante_nome
        FROM lancamentos l
        LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
       WHERE ${[...filtrosLancamentos, lancamentoSemRateio].join(' AND ')}
      UNION ALL
      SELECT mh.id, mh.aeronave_id, mh.socio_id AS participante_id, mh.data_emissao AS data,
             mh.descricao, COALESCE(mh.numero_doc, mh.numero_nf) AS numero_doc, mh.fornecedor_id,
             mh.categoria_nome, mh.grupo_categoria, mh.data_vencimento,
             CASE WHEN UPPER(mh.fluxo) IN ('ENTRADA', 'APORTE', 'ESTORNO') THEN 'ENTRADA' ELSE 'SAIDA' END AS fluxo,
             mh.valor_centavos, mh.valor_centavos AS valor_rateado_centavos, 0 AS valor_pago_centavos,
             NULL AS pago_por, mh.tipo_caixa, mh.pago_diretamente, 0 AS reembolsavel,
             0 AS reembolso_quitado, mh.status, mh.observacoes, 'movimentos_holding' AS origem_rateio,
             NULL AS local, COALESCE(hs.nome, mh.socio_id) AS participante_nome
        FROM movimentos_holding mh
        LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
       WHERE ${[...filtrosMovimento, movimentoHoldingSemRateio].join(' AND ')}
      ORDER BY 4 DESC, 1 DESC LIMIT 1000
    `, ...paramsCliente, ...paramsHolding, ...paramsLancamentos, ...paramsMovimento)
    const [movimentosHolding, sociosHolding, rateiosHolding] = aeronaveId
      ? await Promise.all([
        listarTodos(db, `SELECT mh.id, mh.holding_id, mh.socio_id, mh.aeronave_id, mh.data_emissao AS data,
            mh.data_pagamento, mh.descricao, mh.categoria_nome, mh.grupo_categoria, mh.fluxo,
            mh.valor_centavos, mh.status, mh.pago_diretamente, mh.conta_bancaria_id,
            COALESCE(NULLIF(cb.nome, ''), NULLIF(cb.banco, ''), mh.conta_bancaria_id) AS conta_bancaria,
            h.nome AS holding_nome, hs.nome AS socio_nome
          FROM movimentos_holding mh
          LEFT JOIN holdings h ON h.id = mh.holding_id
          LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
          LEFT JOIN contas_bancarias cb ON cb.id = mh.conta_bancaria_id
          WHERE ${filtrosMovimento.join(' AND ')}
          ORDER BY date(mh.data_emissao) DESC, mh.criado_em DESC, mh.id DESC`, ...paramsMovimento),
        cotistaId && !cotistaSocioId ? Promise.resolve([]) : listar(db, `SELECT DISTINCT h.id AS holding_id, h.nome AS holding_nome,
            COALESCE(NULLIF(h.conta_bancaria, ''), (SELECT COALESCE(NULLIF(cb.nome, ''), cb.banco)
              FROM contas_bancarias cb WHERE cb.holding_id = h.id AND cb.ativo = 1 ORDER BY cb.id LIMIT 1)) AS conta_bancaria,
            hs.id AS socio_id, hs.nome AS socio_nome, COALESCE(ca.percentual_sociedade, 0) AS percentual
          FROM cotista_aeronave ca
          INNER JOIN hold_socios hs ON hs.id = ca.socio_id
          INNER JOIN holdings h ON h.id = hs.holding_id
          WHERE ca.aeronave_id = ? ${cotistaSocioId ? 'AND ca.socio_id = ?' : ''}
          ORDER BY h.nome, hs.nome`, ...(cotistaSocioId ? [aeronaveId, cotistaSocioId] : [aeronaveId])),
        listarTodos(db, `SELECT r.${holdingColumn} AS movimento_id, r.socio_id, r.status, r.pago_diretamente,
            r.valor_rateado_centavos, r.valor_pago_real_centavos
          FROM rateio_hold r WHERE ${[...filtrosHolding, "UPPER(COALESCE(r.status, '')) <> 'CANCELADO'"].join(' AND ')}
          ORDER BY date(r.data_emissao) DESC, r.id DESC`, ...paramsHolding),
      ])
      : [[], [], []]
    const holdings = resumirHoldings(
      sociosHolding.map((row) => ({ holdingId: String(row.holding_id), holdingName: String(row.holding_nome), bankAccount: row.conta_bancaria ? String(row.conta_bancaria) : null, socioId: String(row.socio_id), socioName: String(row.socio_nome), percentage: Number(row.percentual || 0) })),
      movimentosHolding.map((row) => ({ id: String(row.id), holding_id: row.holding_id ? String(row.holding_id) : null, socio_id: row.socio_id ? String(row.socio_id) : null, fluxo: row.fluxo ? String(row.fluxo) : null, status: row.status ? String(row.status) : null, valor_centavos: row.valor_centavos as number | string | null, pago_diretamente: row.pago_diretamente as number | boolean | null })),
      rateiosHolding.map((row) => ({ movimento_id: row.movimento_id ? String(row.movimento_id) : null, socio_id: String(row.socio_id), status: row.status ? String(row.status) : null, pago_diretamente: row.pago_diretamente as number | boolean | null, valor_rateado_centavos: row.valor_rateado_centavos as number | string | null, valor_pago_real_centavos: row.valor_pago_real_centavos as number | string | null })),
    )
    const lancamentos = rows.map((row) => ({ id: row.id, aeronaveId: row.aeronave_id ?? null, participanteId: row.participante_id ?? null, participanteNome: row.participante_nome ?? null, data: row.data, descricao: row.descricao, documento: row.numero_doc ?? null, fornecedor: row.fornecedor_id ?? null, categoria: row.categoria_nome ?? 'SEM CATEGORIA', grupoCategoria: row.grupo_categoria ?? '', tipo: row.origem_rateio ?? null, prazo: row.data_vencimento ?? null, fluxo: String(row.fluxo ?? 'SAIDA').toUpperCase(), valorCentavos: Number(row.valor_centavos || row.valor_rateado_centavos || 0), valorPagoCentavos: Number(row.valor_pago_centavos || 0), pagoPor: row.pago_por ?? '', caixa: row.tipo_caixa ?? 'SHARE', pagoDiretamente: Boolean(row.pago_diretamente), reembolsavel: Boolean(row.reembolsavel), reembolsoQuitado: Boolean(row.reembolso_quitado), status: row.status ?? 'EM_ABERTO', observacoes: row.observacoes ?? null, local: row.local ?? null, rateios: [] }))
    const extratoHolding = movimentosHolding.slice(0, 1000).map((row) => ({ id: String(row.id), holdingId: row.holding_id ? String(row.holding_id) : null, holdingNome: row.holding_nome ? String(row.holding_nome) : null, socioId: row.socio_id ? String(row.socio_id) : null, socioNome: row.socio_nome ? String(row.socio_nome) : null, aeronaveId: row.aeronave_id ? String(row.aeronave_id) : null, data: row.data ? String(row.data) : '', dataPagamento: row.data_pagamento ? String(row.data_pagamento) : null, descricao: String(row.descricao ?? ''), categoria: row.categoria_nome ? String(row.categoria_nome) : null, fluxo: String(row.fluxo ?? '').toUpperCase(), valorCentavos: Number(row.valor_centavos || 0), status: String(row.status ?? 'EM_ABERTO').toUpperCase(), contaBancaria: row.conta_bancaria ? String(row.conta_bancaria) : null, diretamentePago: Boolean(row.pago_diretamente) }))
    const entradas = lancamentos.filter((row) => row.fluxo === 'ENTRADA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const saidas = lancamentos.filter((row) => row.fluxo === 'SAIDA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const porMes = new Map<string, { mes: string; entradas: number; saidas: number; custoRateado: number; lancamentos: number; saldo: number; mediaPorLancamento: number }>()
    const porCategoria = new Map<string, { valor: number; quantidade: number; grupo: string }>()
    rows.forEach((row) => {
      const mes = String(row.data ?? '').slice(0, 7)
      if (mes) { const atual = porMes.get(mes) ?? { mes, entradas: 0, saidas: 0, custoRateado: 0, lancamentos: 0, saldo: 0, mediaPorLancamento: 0 }; const valor = Number(row.valor_centavos || 0) / 100; if (String(row.fluxo).toUpperCase() === 'ENTRADA') atual.entradas += valor; else { atual.saidas += valor; atual.custoRateado += Number(row.valor_rateado_centavos || row.valor_centavos || 0) / 100; } atual.lancamentos += 1; atual.saldo = atual.entradas - atual.saidas; atual.mediaPorLancamento = atual.lancamentos ? atual.saidas / atual.lancamentos : 0; porMes.set(mes, atual) }
      if (String(row.fluxo).toUpperCase() !== 'SAIDA') return; const categoria = String(row.categoria_nome ?? 'SEM CATEGORIA'); const atual = porCategoria.get(categoria) ?? { valor: 0, quantidade: 0, grupo: String(row.grupo_categoria ?? '') }; atual.valor += Number(row.valor_centavos || 0) / 100; atual.quantidade += 1; porCategoria.set(categoria, atual)
    })
    const compensacao = calcularCompensacaoBalanco(rows)
    return c.json({ lancamentos, ...compensacao, holdings, movimentos_holding: extratoHolding, resumo: { entradas, saidas, saldo: entradas - saidas, custo_rateado: [...porMes.values()].reduce((total, item) => total + item.custoRateado, 0), pendentes: lancamentos.filter((row) => ['EM_ABERTO', 'EM_ATRASO', 'PENDENTE', 'APROVADO', 'EMAIL_ENVIADO'].includes(String(row.status).toUpperCase())).length, media_mensal: porMes.size ? saidas / porMes.size : 0, media_lancamento: lancamentos.length ? saidas / lancamentos.length : 0 }, fechamento_mensal: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)), ranking_gastos: [...porCategoria.entries()].map(([categoria, value]) => ({ categoria, ...value })).sort((a, b) => b.valor - a.valor), ranking_cotistas: [] })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/cotista/voos-emprestimos', async (c) => {
  try {
    const cotistaId = String(c.req.query('cotista_id') || '').trim()
    const tipo = String(c.req.query('tipo') || 'cliente').trim().toLowerCase()
    const aeronaveExcluida = String(c.req.query('excluir_aeronave_id') || '').trim()
    if (!cotistaId || !['cliente', 'socio'].includes(tipo)) return c.json({ voos_emprestimos: [] })
    const filtros = [`a.voo_emprestado = 1`, `a.${tipo === 'socio' ? 'socio_id' : 'cliente_id'} = ?`]
    const params: unknown[] = [cotistaId]
    if (aeronaveExcluida) { filtros.push('a.aeronave_id <> ?'); params.push(aeronaveExcluida) }
    const rows = await listar(c.env.SHARE_DB, `SELECT a.id, a.numero_voo, a.data, a.trecho, a.local, a.litros, a.valor_total, a.status, a.numero_comanda, a.numero_nf, a.aeronave_id, ar.matricula_registro, ar.fabricante, ar.modelo, COALESCE(ad.designativo_icao, a.local) AS local_icao FROM abastecimentos a LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN aerodromo ad ON ad.id = a.local OR upper(trim(ad.designativo_icao)) = upper(trim(a.local)) WHERE ${filtros.join(' AND ')} ORDER BY date(a.data) DESC, a.id DESC`, ...params)
    return c.json({ voos_emprestimos: rows })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.get('/balanco', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/cotista/dashboard'
  return financeiroRoutes.fetch(new Request(url, c.req.raw), c.env, c.executionCtx)
})
financeiroRoutes.post('/lancamentos/despesa', async (c) => {
  try {
    const body = await c.req.json()
    const result = await createExpense(
      c.env.SHARE_DB,
      body,
      c.get('userId') || null,
    )
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/lancamentos/receita', async (c) => {
  try {
    const body = await c.req.json()
    const result = await issueRevenue(
      c.env.SHARE_DB,
      body,
      c.get('userId') || null,
    )
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/reembolsos', async (c) => {
  try {
    const body = await c.req.json()
    const result = await createReimbursement(c.env.SHARE_DB, body, c.get('userId') || null)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/salarios/resumo', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const folhas = await db.prepare(`SELECT f.*, COUNT(i.id) AS quantidade_colaboradores FROM folhas_pagamento f LEFT JOIN itens_folha i ON i.folha_id = f.id GROUP BY f.id ORDER BY f.competencia_ano DESC, f.competencia_mes DESC LIMIT 24`).all<Record<string, unknown>>()
    const folha = folhas.results?.[0] ?? null
    const itens = folha ? await db.prepare(`SELECT i.*, COALESCE(u.nome_exibicao, u.nome_completo, u.login, i.user_id) AS colaborador FROM itens_folha i LEFT JOIN user_profiles u ON u.id = i.user_id WHERE i.folha_id = ? ORDER BY colaborador`).bind(folha.id).all<Record<string, unknown>>() : { results: [] as Record<string, unknown>[] }
    const soma = (field: string) => (itens.results ?? []).reduce((sum, row) => sum + Number(row[field] ?? 0), 0); const pagos = (itens.results ?? []).filter((row) => String(row.status).toUpperCase() === 'PAGO')
    const beneficios = await db.prepare('SELECT COALESCE(SUM(saldo_inicial), 0) AS total FROM cartoes_beneficios WHERE ano = ? AND mes = ?').bind(Number(folha?.competencia_ano ?? new Date().getFullYear()), Number(folha?.competencia_mes ?? new Date().getMonth() + 1)).first<{ total: number }>().catch(() => ({ total: 0 }))
    return c.json({ disponivel: true, folha, folhas: folhas.results ?? [], itens: itens.results ?? [], resumo: { folha_mes: Number(folha?.total_liquido_centavos ?? soma('total_liquido_centavos')) / 100, salarios_pagos: pagos.reduce((s, row) => s + Number(row.total_liquido_centavos ?? 0), 0) / 100, salarios_pendentes: ((itens.results ?? []).filter((row) => !pagos.includes(row))).reduce((s, row) => s + Number(row.total_liquido_centavos ?? 0), 0) / 100, beneficios: Number(beneficios?.total ?? 0), encargos: Number(folha?.total_encargos_centavos ?? soma('fgts_centavos') + soma('inss_centavos')) / 100, impostos: soma('irrf_centavos') / 100, total_folha: Number(folha?.total_liquido_centavos ?? soma('total_liquido_centavos')) / 100 } })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.patch('/lancamentos/:id', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>()
    const atual = await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(id).first<Record<string, unknown>>()
    if (!atual) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    if (body.status != null && !['EM_ABERTO', 'PENDENTE', 'PAGO', 'RECEBIDO', 'ATRASADO', 'EM_ATRASO', 'CANCELADO'].includes(String(body.status).toUpperCase())) return c.json({ error: 'status_lancamento_invalido' }, 400)
    const allowed = ['descricao', 'data_emissao', 'data_vencimento', 'data_pagamento', 'status', 'categoria_id', 'categoria_nome', 'grupo_categoria', 'fornecedor_nome', 'numero_doc', 'numero_nf', 'numero_boleto', 'numero_demonstrativo', 'url_doc', 'url_nf', 'url_boleto', 'url_demonstrativo', 'observacoes', 'forma_pagamento', 'aeronave_id', 'cotista_aeronave_id']
    const values = allowed.filter((field) => Object.prototype.hasOwnProperty.call(body, field)).map((field) => [field, body[field] ?? null] as const)
    if (body.valor_centavos != null || body.valorCentavos != null) {
      const amount = Number(body.valor_centavos ?? body.valorCentavos)
      if (!Number.isInteger(amount) || amount <= 0) return c.json({ error: 'valor_centavos_invalido' }, 400)
      values.push(['valor_centavos', amount])
    }
    if (!values.length) return c.json({ error: 'nenhum_campo_para_atualizar' }, 400)
    const assignments = values.map(([field]) => `${field} = ?`).join(', ')
    await db.batch([
      db.prepare(`UPDATE lancamentos SET ${assignments}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(...values.map(([, value]) => value), id),
      ...(values.some(([field]) => field === 'valor_centavos') ? [db.prepare('UPDATE contas_apagar SET valor_centavos = ? WHERE lancamentos_id = ?').bind(values.find(([field]) => field === 'valor_centavos')?.[1], id), db.prepare('UPDATE contas_areceber SET valor_centavos = ? WHERE lancamentos_id = ?').bind(values.find(([field]) => field === 'valor_centavos')?.[1], id)] : []),
    ])
    return c.json(await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(id).first())
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/lancamentos/:id/duplicar', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const source = await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    if (!source) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const payload = { descricao: body.descricao ?? source.descricao, data: body.data ?? source.data_emissao, data_emissao: body.data_emissao ?? body.data ?? source.data_emissao, data_vencimento: body.data_vencimento ?? source.data_vencimento, valor_centavos: body.valor_centavos ?? source.valor_centavos, categoria_id: source.categoria_id, categoria_nome: source.categoria_nome, grupo_categoria: source.grupo_categoria, fornecedor_nome: source.fornecedor_nome, aeronave_id: source.aeronave_id, cotista_aeronave_id: source.cotista_aeronave_id, tipo_caixa: source.tipo_caixa, reembolsavel: source.reembolsavel, idempotency_key: `duplicado:${source.id}:${crypto.randomUUID()}` }
    const result = String(source.fluxo).toUpperCase() === 'ENTRADA' || String(source.fluxo).toUpperCase() === 'RECEITA' ? await issueRevenue(db, payload, c.get('userId') || null) : await createExpense(db, payload, c.get('userId') || null)
    return c.json(result, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/lancamentos/:id/anexos', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const row = await db.prepare('SELECT anexos_json FROM lancamentos WHERE id = ?').bind(id).first<{ anexos_json?: string }>()
    if (!row) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    const body = await c.req.json<Record<string, unknown>>()
    const anexo = { id: crypto.randomUUID(), nome: String(body.nome ?? '').trim(), url: String(body.url ?? '').trim(), tipo: String(body.tipo ?? 'documento'), numero: body.numero ? String(body.numero) : null }
    if (!anexo.nome || !anexo.url) return c.json({ error: 'nome_e_url_obrigatorios' }, 400)
    const antigos = JSON.parse(String(row.anexos_json || '[]'))
    const anexos = Array.isArray(antigos) ? [...antigos, anexo] : [anexo]
    await db.prepare('UPDATE lancamentos SET anexos_json = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(anexos), id).run()
    return c.json({ anexo }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/contas-apagar/:id/agendar', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const row = await db.prepare('SELECT id, lancamentos_id, status FROM contas_apagar WHERE id = ?').bind(id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'conta_a_pagar_nao_encontrada' }, 404)
    if (String(row.status).toUpperCase() === 'PAGO') return c.json({ error: 'conta_ja_paga' }, 409)
    const observacao = String(body.observacoes ?? 'Pagamento agendado').trim()
    await db.batch([
      db.prepare("UPDATE contas_apagar SET status = 'EM_ABERTO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
      ...(row.lancamentos_id ? [db.prepare('UPDATE lancamentos SET observacoes = CASE WHEN observacoes IS NULL OR observacoes = \'\' THEN ? ELSE observacoes || \'\\n\' || ? END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(observacao, observacao, row.lancamentos_id)] : []),
    ])
    return c.json({ ok: true, id, status: 'Agendado' })
  } catch (error) { return errorResponse(c, error) }
})

const DEMONSTRATIVO_IA_PROMPT = (tipo: string) => `Você é um EXTRATOR DE DADOS estritamente fiel de demonstrativos/faturas de tarifas aeroportuárias e de navegação aérea brasileiras.
O campo TIPO DO DEMONSTRATIVO informado pelo usuário é ${tipo}. Antes de extrair as linhas, confira o cabeçalho/layout: "DEMONSTRATIVO DAS TARIFAS A COBRAR", colunas POU/PER/PAN/PAT e emissor INFRAERO indicam TARIFA DE POUSO (INFRAERO); documento emitido pelo DECEA, com TAN/TAT, plano de voo IFR e rota origem-destino, indica TARIFA DECEA. Não confunda o aeroporto emissor com uma rota DECEA.

Sua única tarefa é TRANSCREVER o que está escrito no documento. Você NÃO conhece a operação da aeronave, não sabe quem é o cotista/dono do avião, e não sabe a rota que o avião fez. NÃO adivinhe, NÃO infira, NÃO complete nada que não esteja literalmente no documento.

FORMATO DE SAÍDA — responda EXCLUSIVAMENTE com este JSON, sem markdown, sem comentários, sem texto fora do JSON:
{
  "numero_documento": string|null,
  "competencia": string|null,
  "data_faturamento": string|null,
  "aeronave_matricula": string|null,
  "tipo_detectado": "INFRAERO"|"DECEA"|"POUSO"|null,
  "cliente_nome": string|null,
  "valor_total": number|null,
  "itens": [
    {
      "data": "YYYY-MM-DD",
      "hora": "HH:MM"|null,
      "operacao": string|null,
      "origem": string|null,
      "destino": string|null,
      "matricula": string|null,
      "valor": number
    }
  ]
}

REGRAS OBRIGATÓRIAS POR ITEM:
1. "data": data do evento da tarifa, SEMPRE em YYYY-MM-DD (converta DD/MM/AAAA quando for o caso).
2. "hora": horário exato no formato HH:MM (24h). Se não houver horário no documento, use null — nunca invente.
3. Para INFRAERO/POUSO: "operacao" é o código ICAO de 4 letras do aeródromo onde ocorreu o pouso (ex: SBCY, SBGL), repetido em cada item quando o documento não variar o aeroporto; deixe origem e destino null.
4. Para DECEA: quando a linha trouxer uma rota/plano de voo, preencha "origem" e "destino" com os códigos ICAO de 4 letras. Não force "operacao" nem descarte a rota; se houver apenas um aeródromo/evento, use "operacao" e deixe origem/destino null.
5. "valor": número decimal puro (float), sem "R$", sem separador de milhar, com ponto decimal. Ex: "R$ 1.234,56" vira 1234.56.
6. "matricula": matrícula da aeronave se aparecer na linha; senão null.

REGRAS DE NEGÓCIO — OBRIGATÓRIAS:
- INFRAERO (tarifa de pouso) é cobrada por POUSO, no aeródromo onde o avião ATERRISSOU. O documento NÃO mostra de onde o avião veio nem para onde foi.
- Para DECEA, a ligação com o trecho voado usa origem e destino extraídos do plano de voo e depois é confirmada pelo diário de bordo. Para INFRAERO/POUSO, a ligação usa o aeródromo de chegada e o horário do pouso.
- NUNCA escreva nome de cotista, cliente, sócio ou proprietário nos itens, mesmo que veja anotação manuscrita no documento sugerindo isso. Ignore.
- NUNCA invente, arredonde ou corrija valores — apenas converta o formato numérico do que está escrito.
- "itens" nunca pode ser null/omitido; se não houver linha legível, retorne [].
- Inclua TODAS as linhas do documento, na ordem em que aparecem.
- Campo ausente no documento → null (nunca repita o rótulo da coluna como valor).
- Se o cabeçalho/layout contradizer o tipo informado, informe o tipo real em "tipo_detectado", mas continue extraindo fielmente as linhas. Nesse caso, nunca fabrique origem/destino.`

type ItemExtraidoBruto = Record<string, unknown>

function paraNumeroDemonstrativo(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor
  if (typeof valor !== 'string') return null
  const limpo = valor
    .replace(/R\$\s?/gi, '')
    .trim()
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
  const numero = Number(limpo)
  return Number.isFinite(numero) ? numero : null
}

function paraDataIsoDemonstrativo(valor: unknown): string {
  const texto = String(valor ?? '').trim()
  if (!texto) return ''
  const brasileira = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (brasileira) return `${brasileira[3]}-${brasileira[2]}-${brasileira[1]}`
  const iso = texto.match(/^\d{4}-\d{2}-\d{2}/)
  return iso ? iso[0] : texto
}

function normalizarItensDemonstrativo(dados: Record<string, unknown>): Record<string, unknown> {
  const itensBrutos = Array.isArray(dados.itens) ? (dados.itens as ItemExtraidoBruto[]) : []
  // Nos demonstrativos INFRAERO a matrícula normalmente aparece apenas no
  // cabeçalho (como PRMDL no demonstrativo mensal), não em cada operação.
  // Propagar esse contexto para cada item evita que o cruzamento dependa de
  // uma repetição que não existe no documento.
  const matriculaCabecalho = dados.aeronave_matricula ? String(dados.aeronave_matricula).trim().toUpperCase() : null
  const itens = itensBrutos.map((item) => ({
    ...item,
    data: paraDataIsoDemonstrativo(item.data),
    hora: item.hora ? String(item.hora).slice(0, 5) : null,
    operacao: item.operacao ? String(item.operacao).trim().toUpperCase() : null,
    origem: item.origem ? String(item.origem).trim().toUpperCase() : null,
    destino: item.destino ? String(item.destino).trim().toUpperCase() : null,
    matricula: item.matricula ? String(item.matricula).trim().toUpperCase() : matriculaCabecalho,
    valor: paraNumeroDemonstrativo(item.valor) ?? 0,
  }))
  const somaItens = Math.round(itens.reduce((total, item) => total + (Number(item.valor) || 0), 0) * 100) / 100
  const valorTotal = paraNumeroDemonstrativo(dados.valor_total)
  const precisaRevisaoManual = valorTotal !== null && Math.abs(somaItens - valorTotal) > 0.01
  return {
    ...dados,
    tipo_detectado: dados.tipo_detectado ? String(dados.tipo_detectado).trim().toUpperCase() : null,
    valor_total: valorTotal,
    itens,
    _meta: { soma_itens: somaItens, precisa_revisao_manual: precisaRevisaoManual },
  }
}

function normalizarBase64(value: unknown): string {
  return String(value ?? '').replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
}

financeiroRoutes.post('/recibos/leitura-demonstrativo', async (c) => {
  try {
    const body = await c.req.json<{ imageBase64?: string; image?: string; mimeType?: string; tipo?: string }>().catch(() => ({} as { imageBase64?: string; image?: string; mimeType?: string; tipo?: string }))
    const base64 = normalizarBase64(body.imageBase64 ?? body.image)
    const mimeType = String(body.mimeType || 'application/pdf').trim().toLowerCase()
    const tipo = String(body.tipo || 'INFRAERO').trim().toUpperCase()
    if (base64.length < 100) return c.json({ error: 'arquivo_invalido' }, 400)
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return c.json({ error: 'tipo_arquivo_nao_suportado' }, 400)
    const payload = { imageBase64: base64, mimeType, tipo }
    const resposta = c.env.GEMINI_API_KEY
      ? await (async () => {
        const modelos = ['gemini-flash-latest', 'gemini-3.6-flash']
        let aiRes: Response | null = null
        const maxAttempts = 3
        for (const modelo of modelos) {
          let attempts = 0
          while (attempts < maxAttempts) {
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(c.env.GEMINI_API_KEY as string)}`
            aiRes = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: DEMONSTRATIVO_IA_PROMPT(tipo) }] },
                contents: [{ role: 'user', parts: [{ text: `Tipo do demonstrativo: ${tipo}. Extraia os dados para revisão manual; não crie nem altere registros.` }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
                generationConfig: { response_mime_type: 'application/json' },
              }),
            })
            if (aiRes.status !== 503) return aiRes
            attempts++
            if (attempts < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 2000 * attempts))
          }
        }
        return aiRes
      })()
      : c.env.SUPABASE_URL && c.env.SUPABASE_ANON_KEY
        ? await fetch(`${c.env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/demonstrativo-ocr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: c.env.SUPABASE_ANON_KEY, Authorization: c.req.header('Authorization') || '' },
          body: JSON.stringify(payload),
        })
        : null
    if (!resposta) return c.json({ error: 'servico_de_leitura_ia_nao_configurado' }, 503)
    if (!resposta.ok) return c.json({ error: 'falha_na_leitura_por_ia', details: await resposta.text() }, 502)
    const json = await resposta.json<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; dados_extraidos?: Record<string, unknown> }>()
    if (json.dados_extraidos) return c.json({ sucesso: true, persistido: false, tipo, dados_extraidos: normalizarItensDemonstrativo(json.dados_extraidos) })
    const texto = String(json.candidates?.[0]?.content?.parts?.[0]?.text || '{}').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
    let dados: Record<string, unknown>
    try { dados = JSON.parse(texto) as Record<string, unknown> } catch { return c.json({ error: 'formato_invalido_retornado_pela_ia' }, 422) }
    return c.json({ sucesso: true, persistido: false, tipo, dados_extraidos: normalizarItensDemonstrativo(dados) })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>()
    const handlers: Record<string, (db: D1Database, body: Record<string, unknown>, userId: string | null) => Promise<Record<string, unknown>>> = {
      recibo_reembolso: emitirReciboReembolso,
      recibo_colaborador: emitirReciboColaborador,
      recibo_pagamento: emitirReciboPagamento,
      recibo_saida: emitirReciboSaida,
    }
    const tipo = String(body.tipo_recibo ?? '')
    const handler = handlers[tipo]
    if (!handler) return c.json({ error: 'tipo_recibo_invalido', message: 'Tipo de recibo não suportado' }, 400)
    const result = await handler(c.env.SHARE_DB, body, c.get('userId') || null)
    return c.json(result, 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/recibos/gerar-demonstrativo', async (c) => {
  try {
    const body = await c.req.json<{ grupos?: Array<Record<string, unknown>> }>().catch(() => ({} as { grupos?: Array<Record<string, unknown>> }))
    const grupos = Array.isArray(body.grupos) ? body.grupos : []
    if (!grupos.length) return c.json({ error: 'nenhum_cotista_para_gerar' }, 400)
    const recibos: Record<string, unknown>[] = []
    for (const grupo of grupos) {
      const valorCentavos = Number(grupo.valor_centavos ?? 0)
      if (!String(grupo.cotista_id ?? '').trim() || !Number.isInteger(valorCentavos) || valorCentavos <= 0) return c.json({ error: 'grupo_de_recibo_invalido' }, 400)
      const resultado = await emitirReciboReembolso(c.env.SHARE_DB, {
        tipo_recibo: 'recibo_reembolso',
        aeronave_id: grupo.aeronave_id,
        pagador_tipo: 'cotista_aeronave',
        pagador_id: grupo.cotista_id,
        nome_pagador: grupo.nome_pagador,
        documento_pagador: grupo.documento_pagador,
        endereco_pagador: grupo.endereco_pagador,
        cidade_pagador: grupo.cidade_pagador,
        uf_pagador: grupo.uf_pagador,
        recebedor_nome: 'SHARE BRASIL SERVICOS AEROPORTUARIOS',
        valor_centavos: valorCentavos,
        descricao: grupo.descricao,
        data_emissao: grupo.data_emissao,
        data_vencimento: grupo.data_vencimento,
        categoria_movimentacao_id: grupo.categoria_movimentacao_id,
        categoria_nome: grupo.categoria_nome,
        grupo_categoria: grupo.grupo_categoria || 'DESPESAS REEMBOLSÁVEIS',
        numero_documento_anexo: grupo.numero_documento_anexo,
        observacoes: grupo.observacoes,
        idempotency_key: grupo.idempotency_key,
      }, c.get('userId') || null)
      recibos.push(resultado.recibo as Record<string, unknown>)
    }
    return c.json({ recibos }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/recibos', async (c) => {
  const db = c.env.SHARE_DB
  const filtros: string[] = []
  const params: unknown[] = []
  const status = c.req.query('status')
  const beneficiarioTipo = c.req.query('beneficiario_tipo')
  const busca = c.req.query('q')?.trim()
  const dataInicial = c.req.query('data_inicial')
  const dataFinal = c.req.query('data_final')
  const limitParam = Number(c.req.query('limit') ?? 100)
  const offsetParam = Number(c.req.query('offset') ?? 0)
  const limit = Number.isInteger(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 100
  const offset = Number.isInteger(offsetParam) ? Math.max(offsetParam, 0) : 0
  if (status) { filtros.push('status = ?'); params.push(status) }
  if (beneficiarioTipo) { filtros.push('beneficiario_tipo = ?'); params.push(beneficiarioTipo) }
  if (busca) {
    filtros.push("LOWER(COALESCE(numero_recibo, '') || ' ' || COALESCE(descricao, '') || ' ' || COALESCE(nome_pagador, '') || ' ' || COALESCE(numero_documento_anexo, '')) LIKE LOWER(?)")
    params.push(`%${busca}%`)
  }
  if (dataInicial) { filtros.push('date(data_emissao) >= date(?)'); params.push(dataInicial) }
  if (dataFinal) { filtros.push('date(data_emissao) <= date(?)'); params.push(dataFinal) }
  const where = filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''
  const [result, totalResult] = await Promise.all([
    db.prepare(`SELECT * FROM recibos${where} ORDER BY criado_em DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS total FROM recibos${where}`).bind(...params).first<{ total: number }>(),
  ])
  const recibos = result.results ?? []
  const cotistaIds = [...new Set(recibos.filter((row) => row.pagador_tipo === 'cotista_aeronave').map((row) => String(row.pagador_id ?? '')).filter(Boolean))]
  const clienteIds = [...new Set(recibos.filter((row) => row.pagador_tipo === 'cliente').map((row) => String(row.pagador_id ?? '')).filter(Boolean))]
  const reciboIds = recibos.map((row) => String(row.id ?? '')).filter(Boolean)
  const pdfAnexos = reciboIds.length
    ? await listar(db, `SELECT id, recibo_id FROM recibo_anexos WHERE recibo_id IN (${reciboIds.map(() => '?').join(', ')}) AND UPPER(COALESCE(finalidade, '')) = 'PDF' ORDER BY rowid DESC`, ...reciboIds)
    : []
  const pdfAnexoPorRecibo = new Map<string, Record<string, unknown>>()
  pdfAnexos.forEach((row) => { if (row.recibo_id && !pdfAnexoPorRecibo.has(String(row.recibo_id))) pdfAnexoPorRecibo.set(String(row.recibo_id), row) })
  const contasProgramadas = reciboIds.length
    ? await listar(db, `SELECT c.id AS conta_pagar_id, l.origem_id AS recibo_id FROM contas_apagar c INNER JOIN lancamentos l ON l.id = c.lancamentos_id WHERE c.status <> 'CANCELADO' AND l.origem_tipo IN ('RECIBO', 'RECIBO_REEMBOLSO') AND l.origem_id IN (${reciboIds.map(() => '?').join(', ')})`, ...reciboIds)
    : []
  const rateiosCriados = reciboIds.length
    ? await listar(db, `SELECT DISTINCT l.origem_id AS recibo_id FROM rateio_despesas rd INNER JOIN lancamentos l ON l.id = rd.lancamento_id WHERE l.origem_tipo = 'RECIBO' AND l.origem_id IN (${reciboIds.map(() => '?').join(', ')}) UNION SELECT DISTINCT origem_id AS recibo_id FROM rateio_hold WHERE origem_tipo = 'RECIBO' AND origem_id IN (${reciboIds.map(() => '?').join(', ')})`, ...reciboIds, ...reciboIds).catch(() => [])
    : []
  const contaProgramadaPorRecibo = new Map(contasProgramadas.map((row) => [String(row.recibo_id), String(row.conta_pagar_id)]))
  const rateioCriadoPorRecibo = new Set(rateiosCriados.map((row) => String(row.recibo_id)))
  const cotistas = cotistaIds.length
    ? await listar(db, `SELECT ca.id, ca.cliente_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome, COALESCE(cl.cnpj, hs.cpf) AS documento, COALESCE(cl.endereco, hs.endereco) AS endereco, COALESCE(cl.cidade, hs.cidade) AS cidade, COALESCE(cl.uf, hs.uf) AS uf FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id IN (${cotistaIds.map(() => '?').join(', ')}) OR ca.cliente_id IN (${cotistaIds.map(() => '?').join(', ')})`, ...cotistaIds, ...cotistaIds)
    : []
  const cotistaPorId = new Map<string, Record<string, unknown>>()
  cotistas.forEach((row) => {
    for (const chave of [row.id, row.cliente_id]) {
      if (chave) cotistaPorId.set(String(chave), row)
    }
  })
  const clientes = clienteIds.length
    ? await listar(db, `SELECT id, razao_social AS nome, cnpj AS documento, endereco, cidade, uf FROM cliente WHERE id IN (${clienteIds.map(() => '?').join(', ')})`, ...clienteIds)
    : []
  const clientePorId = new Map(clientes.map((row) => [String(row.id), row]))
  const rateios = reciboIds.length
    ? await listar(db, `SELECT rr.id, rr.recibo_id, rr.rateio_id, rr.percentual, rr.valor, rr.cotista_id, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS cotista_nome FROM recibo_rateio rr LEFT JOIN cotista_aeronave ca ON ca.id = rr.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE rr.recibo_id IN (${reciboIds.map(() => '?').join(', ')}) ORDER BY rr.rowid`, ...reciboIds)
    : []
  const rateiosPorRecibo = new Map<string, Record<string, unknown>[]>()
  for (const rateio of rateios) {
    const lista = rateiosPorRecibo.get(String(rateio.recibo_id)) ?? []
    lista.push(rateio)
    rateiosPorRecibo.set(String(rateio.recibo_id), lista)
  }
  const total = Number(totalResult?.total ?? 0)
  return c.json({
    pagina: { limit, offset, total, has_more: offset + recibos.length < total },
    recibos: recibos.map((recibo) => {
      const cotista = cotistaPorId.get(String(recibo.pagador_id ?? ''))
      return {
        ...recibo,
        pdf_anexo_id: pdfAnexoPorRecibo.get(String(recibo.id))?.id ?? null,
        pdf_url: recibo.url_recibo ?? null,
        nome_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.nome ?? recibo.nome_pagador ?? null : recibo.pagador_tipo === 'cliente' ? clientePorId.get(String(recibo.pagador_id))?.nome ?? recibo.nome_pagador ?? null : 'Share Brasil',
        documento_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.documento ?? recibo.documento_pagador ?? null : recibo.pagador_tipo === 'cliente' ? clientePorId.get(String(recibo.pagador_id))?.documento ?? recibo.documento_pagador ?? null : recibo.documento_pagador ?? null,
        endereco_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.endereco ?? recibo.endereco_pagador ?? null : recibo.pagador_tipo === 'cliente' ? clientePorId.get(String(recibo.pagador_id))?.endereco ?? recibo.endereco_pagador ?? null : recibo.endereco_pagador ?? null,
        cidade_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.cidade ?? recibo.cidade_pagador ?? null : recibo.pagador_tipo === 'cliente' ? clientePorId.get(String(recibo.pagador_id))?.cidade ?? recibo.cidade_pagador ?? null : recibo.cidade_pagador ?? null,
        uf_pagador: recibo.pagador_tipo === 'cotista_aeronave' ? cotista?.uf ?? recibo.uf_pagador ?? null : recibo.pagador_tipo === 'cliente' ? clientePorId.get(String(recibo.pagador_id))?.uf ?? recibo.uf_pagador ?? null : recibo.uf_pagador ?? null,
        rateio_linhas: rateiosPorRecibo.get(String(recibo.id)) ?? [],
        conta_pagar_id: contaProgramadaPorRecibo.get(String(recibo.id)) ?? null,
        despesa_programada: contaProgramadaPorRecibo.has(String(recibo.id)) || rateioCriadoPorRecibo.has(String(recibo.id)),
      }
    })
  })
})

financeiroRoutes.get('/recibos/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/lancamentos] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [clientes, colaboradores, freelancers, aeronaves, cotistas, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, razao_social, cnpj, endereco, cidade, uf, holding, status, codigo_cliente FROM cliente ORDER BY razao_social'),
    read("SELECT id, nome_completo, nome_exibicao, cpf, endereco, cidade, uf, email, telefone, canac, nome_banco, tipo_conta, conta_numero, agencia_numero, pix, 'user_profiles' AS origem FROM user_profiles ORDER BY nome_completo"),
    read("SELECT id, nome_completo, cpf, endereco, cidade, uf, telefone, canac, 'tripulacao_freelancer' AS origem FROM tripulacao_freelancer WHERE lower(COALESCE(status, 'ativo')) = 'ativo' ORDER BY nome_completo"),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read(`SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente, ca.percentual_sociedade,
                 COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente) AS nome,
                 cl.cnpj, hs.cpf,
                 COALESCE(cl.endereco, hs.endereco) AS endereco,
                 COALESCE(cl.cidade, hs.cidade) AS cidade,
                 COALESCE(cl.uf, hs.uf) AS uf
            FROM cotista_aeronave ca
            LEFT JOIN cliente cl ON cl.id = ca.cliente_id
            LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
           ORDER BY COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente), ca.codigo_cliente`),
    read('SELECT id, nome, grupo_categoria, tipo_despesa FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  const recebedores = [
    ...colaboradores.map((item: any) => ({ ...item, id: `perfil:${item.id}`, nome: item.nome_completo || item.nome_exibicao || item.email || '', tipo_user: item.tipo_user || 'colaborador' })),
    ...freelancers.map((item: any) => ({ ...item, id: `freelancer:${item.id}`, nome: item.nome_completo || '', tipo_user: 'freelancer' })),
  ].sort((a: any, b: any) => String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR'))
  return c.json({ clientes, colaboradores, freelancers, aeronaves, cotistas, categorias, categorias_cliente: categoriasCliente, recebedores })
})

financeiroRoutes.patch('/recibos/:id/status', async (c) => {
  try {
    const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
    const status = String(body.status ?? '').toUpperCase()
    const permitidos = new Set(['ANEXO_PENDENTE', 'PDF_PENDENTE', 'EMAIL_ENVIADO', 'ERRO_ANEXO', 'ERRO_PDF'])
    if (!permitidos.has(status)) return c.json({ error: 'status_recibo_invalido' }, 400)
    const result = await c.env.SHARE_DB.prepare('UPDATE recibos SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    return c.json({ ok: true, status })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/enviar-despesa-rateio', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const result = await enviarReciboPagamentoParaRateio(c.env.SHARE_DB, c.req.param('id'), c.get('userId') || null, body)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/programar-contas-apagar', async (c) => {
  try {
    const reciboId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>()
    const receiptInicial = await c.env.SHARE_DB.prepare('SELECT id, tipo_recibo, status FROM recibos WHERE id = ?').bind(reciboId).first<Record<string, unknown>>()
    if (!receiptInicial) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    if (String(receiptInicial.status).toUpperCase() !== 'EMAIL_ENVIADO') return c.json({ error: 'recibo_precisa_ser_enviado_por_email' }, 409)
    await programarReciboReembolso(c.env.SHARE_DB, reciboId, { ...body, data_vencimento: body.data_vencimento }, c.get('userId') || null)
    const receipt = await c.env.SHARE_DB.prepare(`SELECT id, lancamento_id, aeronave_id, tipo_caixa, status, valor, descricao, data_emissao, data_vencimento, categoria_movimentacao_id, grupo_categoria, url_recibo FROM recibos WHERE id = ?`).bind(reciboId).first<Record<string, unknown>>()
    if (!receipt) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    const lancamentoVinculadoId = String(receipt.lancamento_id ?? '').trim()
    const lancamento = lancamentoVinculadoId
      ? await c.env.SHARE_DB.prepare(`SELECT id, status, tipo_caixa, valor_centavos, descricao, aeronave_id, categoria_id, categoria_nome, data_emissao, data_vencimento FROM lancamentos WHERE id = ?`).bind(lancamentoVinculadoId).first<Record<string, unknown>>()
      : await c.env.SHARE_DB.prepare(`SELECT id, status, tipo_caixa, valor_centavos, descricao, aeronave_id, categoria_id, categoria_nome, data_emissao, data_vencimento FROM lancamentos WHERE origem_id = ? AND origem_tipo = 'RECIBO_REEMBOLSO' ORDER BY criado_em DESC LIMIT 1`).bind(reciboId).first<Record<string, unknown>>()
    const lancamentoId = String(lancamento?.id ?? '').trim()
    if (!lancamentoId) return c.json({ error: 'lancamento_do_recibo_nao_encontrado' }, 409)
    if (!lancamento || String(lancamento.tipo_caixa).toUpperCase() !== 'SHARE' || String(lancamento.status).toUpperCase() !== 'EM_ABERTO') return c.json({ error: 'lancamento_share_em_aberto_nao_encontrado' }, 409)
    const existing = await c.env.SHARE_DB.prepare(`SELECT id FROM contas_apagar WHERE lancamentos_id = ? AND status <> 'CANCELADO' LIMIT 1`).bind(lancamentoId).first<{ id: string }>()
    const existingRateio = await c.env.SHARE_DB.prepare(`SELECT id FROM rateio_despesas WHERE lancamento_id = ? LIMIT 1`).bind(lancamentoId).first<{ id: string }>().catch(() => null)
    const existingRateioHold = existingRateio
      ? null
      : await c.env.SHARE_DB.prepare(`SELECT id FROM rateio_hold WHERE origem_id = ? AND origem_tipo = 'RECIBO' LIMIT 1`).bind(reciboId).first<{ id: string }>().catch(() => null)
    if (existingRateio || existingRateioHold) {
      if (existing?.id && body.boleto_url) await c.env.SHARE_DB.prepare('UPDATE contas_apagar SET boleto_url = ? WHERE id = ?').bind(String(body.boleto_url), existing.id).run()
      return c.json({ ok: true, conta_pagar_id: existing?.id ?? null, rateio_ids: [existingRateio?.id ?? existingRateioHold!.id], idempotent: true })
    }
    const aeronaveId = String(body.aeronave_id ?? lancamento.aeronave_id ?? receipt.aeronave_id ?? '').trim()
    const dataVencimento = String(body.data_vencimento_boleto ?? body.data_vencimento ?? lancamento.data_vencimento ?? receipt.data_vencimento ?? lancamento.data_emissao ?? receipt.data_emissao ?? '').trim()
    const tipoRateio = String(body.tipo_rateio ?? 'FIXO').toUpperCase()
    const periodicidade = body.periodicidade ? String(body.periodicidade) : 'ÚNICO'
    const linhas = Array.isArray(body.linhas) ? body.linhas as Array<Record<string, unknown>> : []
    const linhasNormalizadas = linhas.map((linha) => ({
      ...linha,
      cotista_id: String(linha.cotista_id ?? '').trim(),
      percentual_uso: Number(linha.percentual_uso ?? linha.percentual ?? 0),
    }))
    const valorCentavos = Number(lancamento.valor_centavos ?? receipt.valor ?? 0)
    const percentualTotal = linhasNormalizadas.reduce((total, linha) => total + linha.percentual_uso, 0)
    const cotistaIds = linhasNormalizadas.map((linha) => linha.cotista_id).filter(Boolean)
    const idsUnicos = new Set(cotistaIds)
    if (!aeronaveId || !dataVencimento || !linhasNormalizadas.length || cotistaIds.length !== linhasNormalizadas.length || idsUnicos.size !== cotistaIds.length || linhasNormalizadas.some((linha) => !Number.isFinite(linha.percentual_uso) || linha.percentual_uso <= 0) || Math.abs(percentualTotal - 100) > 0.01 || !['FIXO', 'VARIAVEL_POR_VOO', 'VARIAVEL_POR_HORA', 'EXTRA'].includes(tipoRateio)) return c.json({ error: 'dados_de_rateio_invalidos' }, 400)
    const cotistas = await listar(c.env.SHARE_DB, `SELECT ca.id, ca.aeronave_id, ca.socio_id, ca.percentual_sociedade, hs.holding_id FROM cotista_aeronave ca LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id IN (${cotistaIds.map(() => '?').join(',')})`, ...cotistaIds)
    if (cotistas.length !== cotistaIds.length || cotistas.some((cotista) => String(cotista.aeronave_id) !== aeronaveId)) return c.json({ error: 'cotistas_invalidos_para_aeronave' }, 400)
    const holdingIds = [...new Set(cotistas.filter((cotista) => String(cotista.socio_id ?? '').trim()).map((cotista) => String(cotista.holding_id ?? '').trim()).filter(Boolean))]
    if (holdingIds.length > 1 || cotistas.some((cotista) => String(cotista.socio_id ?? '').trim() && !String(cotista.holding_id ?? '').trim())) return c.json({ error: 'holding_do_cotista_invalida' }, 400)
    const contaId = existing?.id ?? crypto.randomUUID()
    const rateioIds = linhasNormalizadas.map(() => crypto.randomUUID())
    // A conta a pagar pertence ao caixa Share; seu FK de categoria aponta
    // para categoria_movimentacao_share. O rateio, por outro lado, usa a
    // categoria selecionada do cliente.
    const categoriaIdConta = lancamento.categoria_id ?? receipt.categoria_movimentacao_id ?? null
    const categoriaNomeConta = lancamento.categoria_nome ?? receipt.categoria_nome ?? receipt.grupo_categoria ?? null
    const categoriaIdRateio = body.categoria_id ?? null
    const categoriaNomeRateio = body.categoria_nome ?? null
    const descricao = lancamento.descricao ?? receipt.descricao ?? 'Recibo'
    const dataEmissao = lancamento.data_emissao ?? receipt.data_emissao ?? null
    const documentoUrl = receipt.url_recibo ?? null
    const movimentoHoldingId = holdingIds.length ? crypto.randomUUID() : null
    const statements = existing ? [] : [c.env.SHARE_DB.prepare(`INSERT INTO contas_apagar (id, data_vencimento, valor_centavos, categoria_id, categoria_nome, descricao, aeronave_id, lancamentos_id, boleto_url, nf_url, criado_por, origem_tipo, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECIBO', ?, 'EM_ABERTO')`).bind(contaId, dataVencimento, valorCentavos, categoriaIdConta, categoriaNomeConta, descricao, aeronaveId, lancamentoId, body.boleto_url ?? null, null, c.get('userId') || null, `recibo:${reciboId}`)]
    if (movimentoHoldingId) {
      const cotistaHolding = cotistas.find((cotista) => String(cotista.holding_id) === holdingIds[0])
      statements.push(c.env.SHARE_DB.prepare(`INSERT INTO movimentos_holding (id, holding_id, socio_id, aeronave_id, periodicidade, tipo_caixa, data_emissao, data_vencimento, descricao, categoria_id, categoria_nome, fluxo, valor_centavos, status, pago_diretamente, numero_recibo, url_recibo, observacoes, criado_por) VALUES (?, ?, ?, ?, ?, 'HOLD', ?, ?, ?, ?, ?, 'SAIDA', ?, 'EM_ABERTO', 0, ?, ?, ?, ?)`).bind(movimentoHoldingId, holdingIds[0], cotistaHolding?.socio_id ?? null, aeronaveId, periodicidade, dataEmissao, dataVencimento, descricao, categoriaIdRateio, categoriaNomeRateio, valorCentavos, receipt.numero_recibo ?? null, documentoUrl, body.observacoes ?? null, c.get('userId') || null))
    }
    linhasNormalizadas.forEach((linha, index) => {
      const cotista = cotistas.find((item) => String(item.id) === String(linha.cotista_id))!
      const percentual = linha.percentual_uso
      const rateado = Math.round(valorCentavos * percentual / 100)
      const campos = String(cotista.socio_id ?? '').trim() ? `INSERT INTO rateio_hold (id, movimento_id, aeronave_id, socio_id, data_emissao, data_vencimento, categoria_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4, tipo_rateio, periodicidade, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, status, descricao_despesa, observacoes, origem_id, origem_tipo, documento_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'EM_ABERTO', ?, ?, ?, 'RECIBO', ?)` : `INSERT INTO rateio_despesas (id, lancamento_id, aeronave_id, cotista_id, data_emissao, data_vencimento, categoria_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4, tipo_rateio, periodicidade, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, status, descricao_despesa, observacoes, documento_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'EM_ABERTO', ?, ?, ?)`
      const parametros = String(cotista.socio_id ?? '').trim()
        ? [rateioIds[index], movimentoHoldingId, aeronaveId, cotista.socio_id, dataEmissao, dataVencimento, categoriaIdRateio, categoriaNomeRateio, body.subcategoria_1 ?? null, body.subcategoria_2 ?? null, body.subcategoria_3 ?? null, body.subcategoria_4 ?? null, tipoRateio, periodicidade, Number(cotista.percentual_sociedade ?? 0), percentual, valorCentavos, rateado, descricao, body.observacoes ?? null, reciboId, documentoUrl]
        : [rateioIds[index], lancamentoId, aeronaveId, cotista.id, dataEmissao, dataVencimento, categoriaIdRateio, categoriaNomeRateio, body.subcategoria_1 ?? null, body.subcategoria_2 ?? null, body.subcategoria_3 ?? null, body.subcategoria_4 ?? null, tipoRateio, periodicidade, Number(cotista.percentual_sociedade ?? 0), percentual, valorCentavos, rateado, descricao, body.observacoes ?? null, documentoUrl]
      statements.push(c.env.SHARE_DB.prepare(campos).bind(...parametros))
    })
    await c.env.SHARE_DB.batch(statements)
    return c.json({ ok: true, conta_pagar_id: contaId, rateio_ids: rateioIds }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/cancelar', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const reciboId = c.req.param('id')
    const recibo = await db.prepare('SELECT id, status, lancamento_id FROM recibos WHERE id = ?').bind(reciboId).first<{ id: string; status: string | null; lancamento_id: string | null }>()
    if (!recibo) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    if (String(recibo.status ?? '').toUpperCase() === 'CANCELADO') return c.json({ error: 'recibo_nao_encontrado_ou_ja_cancelado' }, 409)

    // Estados que ainda não representam uma baixa financeira. AGUARDANDO_REEMBOLSO
    // também é cancelável: a programação ainda não foi recebida/paga.
    const statusAbertos = ['EM_ABERTO', 'AGUARDANDO_REEMBOLSO', 'EM_ATRASO', 'PENDENTE', 'VENCIDO', 'CRIADO', 'PDF_PENDENTE', 'EMITIDO', 'EMAIL_ENVIADO']
    const [lancamentos, movimentos, rateiosDespesas, rateiosHold, contasApagar, contasReceber, reembolsos] = await Promise.all([
      db.prepare(`SELECT id, status FROM lancamentos
        WHERE id = ?1
           OR (origem_id = ?2 AND UPPER(COALESCE(origem_tipo, '')) IN ('RECIBO', 'RECIBO_REEMBOLSO'))
           OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?1)`)
        .bind(recibo.lancamento_id ?? null, reciboId).all<{ id: string; status: string | null }>(),
      db.prepare(`SELECT id, status FROM movimentos_holding WHERE id IN (
          SELECT movimento_id FROM rateio_hold WHERE origem_id = ?1
          UNION SELECT cr.movimentos_id FROM contas_areceber cr INNER JOIN reembolsos r ON r.conta_receber_id = cr.id WHERE r.lancamento_origem_id = ?2
        )`).bind(reciboId, recibo.lancamento_id ?? null).all<{ id: string; status: string | null }>(),
      db.prepare(`SELECT id, status FROM rateio_despesas
        WHERE lancamento_id IN (SELECT id FROM lancamentos WHERE id = ?2 OR origem_id = ?1 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?2))`)
        .bind(reciboId, recibo.lancamento_id ?? null).all<{ id: string; status: string | null }>(),
      db.prepare(`SELECT id, status FROM rateio_hold WHERE origem_id = ?1
        OR movimento_id IN (SELECT cr.movimentos_id FROM contas_areceber cr INNER JOIN reembolsos r ON r.conta_receber_id = cr.id WHERE r.lancamento_origem_id = ?2)`)
        .bind(reciboId, recibo.lancamento_id ?? null).all<{ id: string; status: string | null }>(),
      db.prepare(`SELECT id, status FROM contas_apagar WHERE lancamentos_id IN (
        SELECT id FROM lancamentos WHERE id = ?1 OR origem_id = ?2 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?1)
      )`).bind(recibo.lancamento_id ?? null, reciboId).all<{ id: string; status: string | null }>(),
      db.prepare(`SELECT id, status FROM contas_areceber WHERE lancamentos_id IN (SELECT id FROM lancamentos WHERE id = ?2 OR origem_id = ?1 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?2))
        OR id IN (SELECT conta_receber_id FROM reembolsos WHERE lancamento_origem_id = ?2)`)
        .bind(reciboId, recibo.lancamento_id ?? null).all<{ id: string; status: string | null }>(),
      db.prepare('SELECT id, status FROM reembolsos WHERE lancamento_origem_id = ?').bind(recibo.lancamento_id ?? null).all<{ id: string; status: string | null }>(),
    ])
    const relacionados = [lancamentos.results, movimentos.results, rateiosDespesas.results, rateiosHold.results, contasApagar.results, contasReceber.results, reembolsos.results].flat()
    const baixados = relacionados.filter((row) => {
      const status = String(row.status ?? '').toUpperCase()
      return status && status !== 'CANCELADO' && !statusAbertos.includes(status)
    })
    if (baixados.length) {
      return c.json({
        error: 'recibo_nao_pode_cancelar_baixa_realizada',
        code: 'recibo_nao_pode_cancelar_baixa_realizada',
        message: 'Não é possível cancelar o recibo porque a baixa de pagamento ou recebimento já ocorreu.',
        registros: baixados.map((row) => ({ id: row.id, status: row.status })),
      }, 409)
    }

    const reembolsoIds = reembolsos.results.map((row) => row.id)
    await db.batch([
      db.prepare(`UPDATE recibos SET status_anterior = status, status = 'CANCELADO' WHERE id = ? AND UPPER(COALESCE(status, '')) <> 'CANCELADO'`).bind(reciboId),
      db.prepare(`UPDATE lancamentos SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP
        WHERE id = ?1 OR (origem_id = ?2 AND UPPER(COALESCE(origem_tipo, '')) IN ('RECIBO', 'RECIBO_REEMBOLSO'))
           OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?1)`).bind(recibo.lancamento_id ?? null, reciboId),
      db.prepare(`UPDATE movimentos_holding SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE id IN (
          SELECT movimento_id FROM rateio_hold WHERE origem_id = ?1
          UNION SELECT cr.movimentos_id FROM contas_areceber cr INNER JOIN reembolsos r ON r.conta_receber_id = cr.id WHERE r.lancamento_origem_id = ?2
        )`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE rateio_despesas SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP
        WHERE lancamento_id IN (SELECT id FROM lancamentos WHERE id = ?2 OR origem_id = ?1 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?2))`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE rateio_hold SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE origem_id = ?1
        OR movimento_id IN (SELECT cr.movimentos_id FROM contas_areceber cr INNER JOIN reembolsos r ON r.conta_receber_id = cr.id WHERE r.lancamento_origem_id = ?2)`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE contas_apagar SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE lancamentos_id IN (
        SELECT id FROM lancamentos WHERE id = ?1 OR origem_id = ?2 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?1)
      )`).bind(recibo.lancamento_id ?? null, reciboId),
      db.prepare(`UPDATE contas_areceber SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE lancamentos_id IN (SELECT id FROM lancamentos WHERE id = ?2 OR origem_id = ?1 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?2))
        OR id IN (SELECT conta_receber_id FROM reembolsos WHERE lancamento_origem_id = ?2)`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE reembolsos SET status_anterior = status, status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE lancamento_origem_id = ?`).bind(recibo.lancamento_id ?? null),
    ])
    return c.json({ ok: true, status: 'CANCELADO', reembolsos_afetados: reembolsoIds.length })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.post('/recibos/:id/reativar', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const reciboId = c.req.param('id')
    const body = await c.req.json<{ justificativa?: string }>().catch(() => ({} as { justificativa?: string }))
    const justificativa = String(body.justificativa ?? '').trim()
    if (justificativa.length < 5) return c.json({ error: 'justificativa_obrigatoria', code: 'justificativa_obrigatoria' }, 400)
    if (justificativa.length > 1000) return c.json({ error: 'justificativa_muito_longa', code: 'justificativa_muito_longa' }, 400)
    const recibo = await db.prepare('SELECT id, status, status_anterior, url_recibo, lancamento_id FROM recibos WHERE id = ?').bind(reciboId).first<Record<string, unknown>>()
    if (!recibo) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    if (String(recibo.status ?? '').toUpperCase() !== 'CANCELADO') return c.json({ error: 'recibo_nao_esta_cancelado', code: 'recibo_nao_esta_cancelado' }, 409)
    let restaurar = String(recibo.status_anterior ?? '').trim().toUpperCase()
    if (!restaurar || restaurar === 'CANCELADO') {
      const email = await db.prepare(`SELECT e.id FROM emails_enviados e LEFT JOIN recibo_anexos a ON a.id = e.referencia_id AND e.referencia_tipo = 'recibo'
        WHERE e.status = 'enviado' AND e.referencia_tipo = 'recibo' AND (e.referencia_id = ? OR a.recibo_id = ?) LIMIT 1`).bind(reciboId, reciboId).first().catch(() => null)
      restaurar = email ? 'EMAIL_ENVIADO' : recibo.url_recibo ? 'EMITIDO' : 'PDF_PENDENTE'
    }
    const userId = c.get('userId') || null
    const auditId = crypto.randomUUID()
    const resultados = await db.batch([
      db.prepare(`UPDATE recibos SET status = ?, status_anterior = NULL WHERE id = ? AND UPPER(COALESCE(status, '')) = 'CANCELADO'`).bind(restaurar, reciboId),
      db.prepare(`UPDATE lancamentos SET status = COALESCE(status_anterior, 'EM_ABERTO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP
        WHERE status = 'CANCELADO' AND (id = ? OR origem_id = ? OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?))`).bind(recibo.lancamento_id ?? null, reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE movimentos_holding SET status = COALESCE(status_anterior, 'EM_ABERTO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE status = 'CANCELADO' AND id IN (
          SELECT movimento_id FROM rateio_hold WHERE origem_id = ?1
          UNION SELECT cr.movimentos_id FROM contas_areceber cr INNER JOIN reembolsos r ON r.conta_receber_id = cr.id WHERE r.lancamento_origem_id = ?2
        )`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE rateio_despesas SET status = COALESCE(status_anterior, 'EM_ABERTO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE status = 'CANCELADO' AND lancamento_id IN (SELECT id FROM lancamentos WHERE id = ?2 OR origem_id = ?1 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?2))`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE rateio_hold SET status = COALESCE(status_anterior, 'EM_ABERTO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE status = 'CANCELADO' AND (origem_id = ?1 OR movimento_id IN (SELECT cr.movimentos_id FROM contas_areceber cr INNER JOIN reembolsos r ON r.conta_receber_id = cr.id WHERE r.lancamento_origem_id = ?2))`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE contas_apagar SET status = COALESCE(status_anterior, 'EM_ABERTO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE status = 'CANCELADO' AND lancamentos_id IN (SELECT id FROM lancamentos WHERE id = ?1 OR origem_id = ?2 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?1))`).bind(recibo.lancamento_id ?? null, reciboId),
      db.prepare(`UPDATE contas_areceber SET status = COALESCE(status_anterior, 'EM_ABERTO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE status = 'CANCELADO' AND (lancamentos_id IN (SELECT id FROM lancamentos WHERE id = ?2 OR origem_id = ?1 OR id IN (SELECT lancamento_cliente_id FROM reembolsos WHERE lancamento_origem_id = ?2)) OR id IN (SELECT conta_receber_id FROM reembolsos WHERE lancamento_origem_id = ?2))`).bind(reciboId, recibo.lancamento_id ?? null),
      db.prepare(`UPDATE reembolsos SET status = COALESCE(status_anterior, 'AGUARDANDO_REEMBOLSO'), status_anterior = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE status = 'CANCELADO' AND lancamento_origem_id = ?`).bind(recibo.lancamento_id ?? null),
      db.prepare(`INSERT INTO recibo_reativacoes (id, recibo_id, justificativa, status_restaurado, reativado_por) VALUES (?, ?, ?, ?, ?)`).bind(auditId, reciboId, justificativa, restaurar, userId),
    ])
    if (!resultados[0].meta.changes) return c.json({ error: 'recibo_nao_esta_cancelado', code: 'recibo_nao_esta_cancelado' }, 409)
    return c.json({ ok: true, id: reciboId, status: restaurar })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.post('/recibos/:id/reembolso', async (c) => {
  try {
    const recibo = await c.env.SHARE_DB.prepare('SELECT status FROM recibos WHERE id = ? AND tipo_recibo = \'recibo_reembolso\'').bind(c.req.param('id')).first<{ status: string }>()
    if (!recibo) return c.json({ error: 'recibo_reembolso_nao_encontrado' }, 404)
    if (String(recibo.status).toUpperCase() !== 'EMAIL_ENVIADO') return c.json({ error: 'recibo_precisa_ser_enviado_por_email' }, 409)
    const result = await programarReciboReembolso(
      c.env.SHARE_DB,
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
      c.get('userId') || null,
    )
    return c.json({ ok: true, ...result }, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/envios-pagamento', async (c) => {
  try {
    let input
    try {
      input = validatePaymentRequest(await c.req.json())
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'dados_de_envio_invalidos', code: 'dados_de_envio_invalidos' }, 400)
    }
    const result = await createPaymentRequest(c.env.SHARE_DB, input, c.get('userId') || null)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/envios-pagamento', async (c) => {
  const tipo = c.req.query('tipo')
  const query = `SELECT e.*, COALESCE(u.nome_exibicao, u.nome_completo, u.email, e.criado_por) AS solicitante_nome
    FROM envio_despesas e LEFT JOIN user_profiles u ON u.id = e.criado_por
    ${tipo ? 'WHERE e.tipo = ?' : ''} ORDER BY e.criado_em DESC LIMIT 200`
  const result = tipo ? await c.env.SHARE_DB.prepare(query).bind(tipo).all() : await c.env.SHARE_DB.prepare(query).all()
  return c.json({ envios: result.results ?? [] })
})

financeiroRoutes.get('/envios-pagamento/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/envios] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [fornecedores, fornecedoresCombustivel, aeronaves, voos, categorias, categoriasCliente] = await Promise.all([
    read('SELECT id, COALESCE(apelido, nome_completo) AS label FROM fornecedores_favoritos ORDER BY label'),
    read('SELECT * FROM fornecedores_combustivel ORDER BY nome_cidade, nome_fornecedor'),
    read('SELECT id, matricula_registro, fabricante, modelo FROM aeronave ORDER BY matricula_registro'),
    read("SELECT numero_voo, MAX(data_agendada) AS ultima_data, aeronave_id FROM solicitacoes_reserva_voo WHERE NULLIF(TRIM(numero_voo), '') IS NOT NULL GROUP BY numero_voo, aeronave_id ORDER BY ultima_data DESC, numero_voo"),
    read('SELECT id, nome, grupo_categoria, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_share ORDER BY nome'),
    read('SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM categoria_movimentacao_cliente ORDER BY nome'),
  ])
  return c.json({ fornecedores, fornecedores_combustivel: fornecedoresCombustivel, aeronaves, voos, categorias, categorias_cliente: categoriasCliente })
})

financeiroRoutes.get('/envios-pagamento/anexos-opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/anexos] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [recibos, relatorios, abastecimentos] = await Promise.all([
    read(`SELECT r.id, r.numero_recibo, r.descricao, r.descricao AS descricao_servico, r.data_emissao, COALESCE(a.id, r.id) AS anexo_id, a.nome_arquivo, a.tipo_arquivo, COALESCE(r.url_recibo, '/api/financeiro/recibos/anexos/' || a.id || '/arquivo') AS arquivo_url, (COUNT(a.id) + CASE WHEN r.url_recibo IS NOT NULL THEN 1 ELSE 0 END) AS quantidade_anexos FROM recibos r LEFT JOIN recibo_anexos a ON a.recibo_id = r.id AND (UPPER(COALESCE(a.finalidade, '')) = 'PDF' OR a.tipo_arquivo = 'application/pdf') WHERE a.id IS NOT NULL OR r.url_recibo IS NOT NULL GROUP BY r.id, r.numero_recibo, r.descricao, r.data_emissao, r.url_recibo, a.id, a.nome_arquivo, a.tipo_arquivo ORDER BY r.data_emissao DESC, r.numero_recibo LIMIT 300`),
    read(`SELECT r.id, r.numero_voo, r.numero_relatorio, COALESCE(r.pdf_url, '/api/financeiro/relatorios-despesa-viagem/' || r.id || '/pdf') AS arquivo_url, r.id AS anexo_id, 'relatorio.pdf' AS nome_arquivo, 'application/pdf' AS tipo_arquivo, 1 AS quantidade_anexos FROM relatorio_despesa_viagem r WHERE r.pdf_path IS NOT NULL OR r.pdf_url IS NOT NULL ORDER BY r.criado_em DESC, r.numero_relatorio LIMIT 300`),
    read(`SELECT a.id, a.numero_voo, a.trecho, a.data, a.numero_comanda, a.numero_nf, a.local, a.comanda_url, a.nota_url, a.boleto_url, ar.matricula_registro, COALESCE(cl.razao_social, hs.nome, a.cliente_id, a.socio_id, 'Cotista não informado') AS cotista_nome, (CASE WHEN a.comanda_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN a.nota_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN a.boleto_url IS NOT NULL THEN 1 ELSE 0 END) AS quantidade_anexos FROM abastecimentos a LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN cliente cl ON cl.id = a.cliente_id LEFT JOIN hold_socios hs ON hs.id = a.socio_id WHERE a.comanda_url IS NOT NULL OR a.nota_url IS NOT NULL OR a.boleto_url IS NOT NULL ORDER BY a.data DESC, a.numero_voo LIMIT 300`),
  ])
  return c.json({ recibos, relatorios, abastecimentos })
})
financeiroRoutes.post('/envios-pagamento/anexos', async (c) => {
  const arquivo = (await c.req.formData()).get('arquivo') as unknown
  if (!(arquivo instanceof File) || !arquivo.size) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  if (arquivo.size > 25 * 1024 * 1024) return c.json({ error: 'arquivo_excede_25mb' }, 413)
  if (!/^application\/pdf$|^image\//.test(arquivo.type)) return c.json({ error: 'somente_imagem_ou_pdf_permitido' }, 415)
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const userId = c.get('userId') || 'interno'
  const safeName = arquivo.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `share/nf-boletos-clients/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`
  await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
  const publicUrl = c.env.R2_PUBLIC_URL ? `${c.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}` : `${new URL(c.req.url).origin}/api/financeiro/envios-pagamento/anexos/arquivo?key=${encodeURIComponent(key)}`
  return c.json({ key, url: publicUrl }, 201)
})
financeiroRoutes.get('/envios-pagamento/anexos/arquivo', async (c) => {
  const key = c.req.query('key')
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!key || !bucket || !key.startsWith('share/nf-boletos-clients/')) return c.notFound()
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': 'inline' } })
})

financeiroRoutes.get('/envios-pagamento/aeronave/:id/cotistas', async (c) => {
  const result = await c.env.SHARE_DB.prepare(`
    SELECT ca.id, ca.aeronave_id, ca.cliente_id, ca.socio_id, ca.codigo_cliente,
           ca.percentual_sociedade,
           COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, 'Cotista não identificado') AS nome,
           COALESCE(cl.email_principal, hs.email_principal) AS email,
           CASE WHEN ca.socio_id IS NOT NULL THEN 1 ELSE 0 END AS eh_holding
      FROM cotista_aeronave ca
      LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
     WHERE ca.aeronave_id = ?
     ORDER BY COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente)
  `).bind(c.req.param('id')).all()
  return c.json({ cotistas: result.results ?? [] })
})

financeiroRoutes.patch('/envios-pagamento/:id', async (c) => {
  const body: { status?: string } = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
  const requested = String(body.status ?? '').toUpperCase()
  const id = c.req.param('id')
  const current = await c.env.SHARE_DB.prepare('SELECT id, tipo, status FROM envio_despesas WHERE id = ?').bind(id).first<{ id: string; tipo: string; status: string }>()
  if (!current) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  const currentStatus = String(current.status ?? '').toUpperCase()
  if (currentStatus === 'CONVERTIDO' && requested === 'EMAIL_ENVIADO') {
    await c.env.SHARE_DB.prepare(`UPDATE envio_despesas
      SET email_enviado = 1, email_enviado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'CONVERTIDO'`).bind(id).run()
    return c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first().then((row) => c.json(row))
  }
  const transitions: Record<string, string[]> = {
    PENDENTE: current.tipo === 'share' ? ['APROVADO', 'CANCELADO'] : ['EMAIL_ENVIADO', 'CANCELADO'],
    APROVADO: ['EMAIL_ENVIADO', 'CANCELADO'],
    EMAIL_ENVIADO: ['CANCELADO'],
    CONVERTIDO: [],
    CANCELADO: [],
  }
  if (!transitions[currentStatus]?.includes(requested)) {
    return c.json({ error: 'transicao_status_solicitacao_invalida', de: currentStatus, para: requested }, 409)
  }
  await c.env.SHARE_DB.prepare('UPDATE envio_despesas SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').bind(requested, id, current.status).run()
  return c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first().then((row) => c.json(row))
})

financeiroRoutes.post('/envios-pagamento/:id/aprovar', async (c) => {
  const db = c.env.SHARE_DB
  const id = c.req.param('id')
  const request = await db.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
  if (request.tipo !== 'share') return c.json({ error: 'somente_solicitacoes_de_compra_share_podem_ser_aprovadas' }, 409)
  const result = await db.prepare("UPDATE envio_despesas SET status = 'APROVADO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDENTE'").bind(id).run()
  if (!result.meta.changes) return c.json({ error: 'solicitacao_nao_pendente' }, 409)
  const userId = c.get('userId') || null
  const statements = mensagemFinanceiraStatements(db, String(request.criado_por ?? '') || null, userId, 'Solicitação de compra aprovada', `Sua solicitação “${String(request.descricao ?? '')}” foi aprovada e está sendo preparada para pagamento.`)
  if (statements.length) await db.batch(statements)
  try {
    const conversion = await convertPaymentRequest(db, { ...request, status: 'APROVADO' }, { createExpense, createReimbursement, createDirectExternalExpense, createClientExpenseRateios }, userId)
    if (request.solicitacao_compra_id) {
      await db.prepare("UPDATE solicitacoes_compra SET status = 'APROVADA', data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?").bind(request.solicitacao_compra_id).run()
    }
    return c.json({ ok: true, ...conversion, status: 'CONVERTIDO' })
  } catch (error) {
    return c.json({ ok: false, id, status: 'APROVADO', error: 'falha_ao_converter_solicitacao', detail: error instanceof Error ? error.message : 'Falha ao criar a conta a pagar.' }, 502)
  }
})

financeiroRoutes.post('/envios-pagamento/:id/converter', async (c) => {
  try {
    const request = await c.env.SHARE_DB.prepare('SELECT * FROM envio_despesas WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    if (!request) return c.json({ error: 'solicitacao_nao_encontrada' }, 404)
    if (request.tipo === 'share' && !['APROVADO', 'CONVERTIDO'].includes(String(request.status))) return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    if (request.tipo !== 'share' && !['PENDENTE', 'APROVADO', 'EMAIL_ENVIADO', 'CONVERTIDO'].includes(String(request.status))) return c.json({ error: 'solicitacao_nao_aprovada' }, 409)
    return c.json(await convertPaymentRequest(
      c.env.SHARE_DB,
      request,
      { createExpense, createReimbursement, createDirectExternalExpense, createClientExpenseRateios },
      c.get('userId') || null,
    ))
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/anexos', async (c) => {
  try {
    // O upload é uma etapa de arquivo. A criação do recibo permanece no
    // ReceiptAgent e o Worker não cria nem altera tabelas.
    await validateFinanceSchema(c.env.SHARE_DB)
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    const reciboId = String(form.recibo_id || '')
    if (!reciboId) return c.json({ error: 'recibo_id_obrigatorio' }, 400)
    const id = crypto.randomUUID()
    const key = `recibos/${reciboId}/original/${id}-${arquivo.name}`
    const publicUrl = publicStorageUrl(c, key)
    await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: arquivo.type || 'application/octet-stream' } })
    await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, arquivo.name, key, arquivo.type || 'application/octet-stream', arquivo.size, c.get('userId') || null, reciboId, 'ORIGINAL').run()
    return c.json({ id, url: publicUrl, nome_arquivo: arquivo.name, tipo_arquivo: arquivo.type, tamanho_arquivo: arquivo.size }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/demonstrativo', async (c) => {
  try {
    await validateFinanceSchema(c.env.SHARE_DB)
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    if (arquivo.size <= 0 || (arquivo.type && arquivo.type !== 'application/pdf')) return c.json({ error: 'arquivo_pdf_invalido' }, 400)
    const reciboId = String(form.recibo_id || '').trim() || null
    if (reciboId) {
      const recibo = await c.env.SHARE_DB.prepare('SELECT id FROM recibos WHERE id = ?').bind(reciboId).first<{ id: string }>()
      if (!recibo) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    }
    const id = crypto.randomUUID()
    const safeName = (arquivo.name || 'demonstrativo-rateado.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
    const key = `share/recibos/demonstrativos/${reciboId || 'avulso'}-${id}-${safeName}`
    const publicUrl = publicStorageUrl(c, key)
    await bucket.put(key, await arquivo.arrayBuffer(), { httpMetadata: { contentType: 'application/pdf' } })
    await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, arquivo.name || safeName, key, 'application/pdf', arquivo.size, c.get('userId') || null, reciboId, 'DEMONSTRATIVO').run()
    return c.json({ id, recibo_id: reciboId, caminho_arquivo: key, url: publicUrl, nome_arquivo: arquivo.name || safeName, tipo_arquivo: 'application/pdf', tamanho_arquivo: arquivo.size }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/recibos/:id/pdf', async (c) => {
  try {
    await validateFinanceSchema(c.env.SHARE_DB)
    const bucket = storage(c)
    if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
    const form = await c.req.parseBody()
    const arquivo = form.arquivo
    if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
    if (arquivo.size <= 0 || (arquivo.type && arquivo.type !== 'application/pdf')) return c.json({ error: 'arquivo_pdf_invalido' }, 400)
    const reciboId = c.req.param('id')
    const recibo = await c.env.SHARE_DB.prepare('SELECT status FROM recibos WHERE id = ?').bind(reciboId).first<{ status: string }>()
    if (!recibo) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    // Permite regenerar o PDF de um recibo já emitido sem criar novo recibo.
    if (!['CRIADO', 'PDF_PENDENTE', 'ANEXO_PENDENTE', 'ERRO_ANEXO', 'ERRO_PDF', 'EMITIDO'].includes(String(recibo.status).toUpperCase())) return c.json({ error: 'recibo_nao_aguarda_pdf', status_atual: recibo.status }, 409)
    const bytes = new Uint8Array(await arquivo.arrayBuffer())
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') return c.json({ error: 'conteudo_pdf_invalido' }, 400)
    // O comprovante original pode ser um PDF. Ele precisa permanecer separado
    // do PDF final (recibo + comprovante), por isso só reutilizamos o anexo
    // explicitamente marcado como PDF gerado.
    const anexoExistente = await c.env.SHARE_DB.prepare("SELECT id FROM recibo_anexos WHERE recibo_id = ? AND UPPER(COALESCE(finalidade, '')) = 'PDF' ORDER BY rowid DESC LIMIT 1").bind(reciboId).first<{ id: string }>()
    const anexoId = anexoExistente?.id || crypto.randomUUID()
    const key = `recibos/${reciboId}/gerado.pdf`
    const pdfUrl = publicStorageUrl(c, key)
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } })
    if (anexoExistente) {
      await c.env.SHARE_DB.prepare('UPDATE recibo_anexos SET nome_arquivo = ?, caminho_arquivo = ?, tipo_arquivo = ?, tamanho_arquivo = ?, enviado_por = ?, finalidade = ? WHERE id = ?').bind(arquivo.name || `${reciboId}.pdf`, key, 'application/pdf', arquivo.size, c.get('userId') || null, 'PDF', anexoId).run()
    } else {
      await c.env.SHARE_DB.prepare('INSERT INTO recibo_anexos (id, nome_arquivo, caminho_arquivo, tipo_arquivo, tamanho_arquivo, enviado_por, recibo_id, finalidade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(anexoId, arquivo.name || `${reciboId}.pdf`, key, 'application/pdf', arquivo.size, c.get('userId') || null, reciboId, 'PDF').run()
    }
    await c.env.SHARE_DB.prepare('UPDATE recibos SET url_recibo = ? WHERE id = ?').bind(pdfUrl, reciboId).run()
    await c.env.SHARE_DB.prepare("UPDATE recibos SET status = 'EMITIDO' WHERE id = ?").bind(reciboId).run()
    // O PDF deixa o recibo pronto para envio, mas não materializa lançamentos.
    // A criação financeira ocorre somente na programação após o e-mail.
    return c.json({ anexo_id: anexoId, pdf_url: pdfUrl, recibo_id: reciboId, status: 'EMITIDO' }, 201)
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/recibos/:id/pdf/arquivo', async (c) => {
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const row = await c.env.SHARE_DB.prepare(`
    SELECT caminho_arquivo, tipo_arquivo, nome_arquivo
      FROM recibo_anexos
     WHERE recibo_id = ?1 AND UPPER(COALESCE(finalidade, '')) = 'PDF'
     ORDER BY rowid DESC LIMIT 1
  `).bind(c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string; nome_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await bucket.get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, {
    'Content-Type': row.tipo_arquivo || 'application/pdf',
    'Content-Disposition': `inline; filename="${row.nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    'Cache-Control': 'private, max-age=3600',
  })
})

financeiroRoutes.get('/recibos/anexos/:id/arquivo', async (c) => {
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, tipo_arquivo FROM recibo_anexos WHERE id = ?').bind(c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await bucket.get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': row.tipo_arquivo, 'Cache-Control': 'private, max-age=3600' })
})
financeiroRoutes.get('/recibos/:id/anexo-original', async (c) => {
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const row = await c.env.SHARE_DB.prepare("SELECT caminho_arquivo, tipo_arquivo, nome_arquivo FROM recibo_anexos WHERE recibo_id = ? AND UPPER(COALESCE(finalidade, '')) = 'ORIGINAL' ORDER BY rowid DESC LIMIT 1").bind(c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string; nome_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await bucket.get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, {
    'Content-Type': row.tipo_arquivo || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${row.nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    'Cache-Control': 'private, max-age=3600',
  })
})
financeiroRoutes.post('/contas-apagar/:id/baixa', async (c) => {
  try {
    const result = await settlePayable(
      c.env.SHARE_DB,
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
      c.get('userId') || null,
    )
    return c.json(result)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/contas-areceber/:id/baixa', async (c) => {
  try {
    const result = await settleReceivable(
      c.env.SHARE_DB,
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
      c.get('userId') || null,
    )
    return c.json(result)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/fila', async (c) => {
  try {
    const body = await c.req.json()
    const result = await enqueueFinance(
      c.env.SHARE_DB,
      body.operacao,
      body.payload,
    )
    return c.json(result, 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

financeiroRoutes.post('/fila/processar', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const result = await processFinanceQueue(
      c.env.SHARE_DB,
      c.get('userId') || null,
      Number(body.limit || 20),
    )
    return c.json({ result })
  } catch (error) {
    return errorResponse(c, error)
  }
})
