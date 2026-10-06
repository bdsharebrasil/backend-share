import { Hono } from 'hono'
import { createExpense } from './FinanceiroKernel'
import { mapConta } from './contas'
import { errorResponse } from './errorResponse'
import { enriquecerFornecedores } from './repositories/contas'
import { listar } from './repositories/d1'

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }

export const contasRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

async function consultarContas(c: any, table: 'contas_apagar' | 'contas_areceber') {
  const status = c.req.query('status')
  const cotistaId = c.req.query('cotistaId')
  const fornecedorId = c.req.query('fornecedorId')
  const vencidasAte = c.req.query('vencidasAte')
  const filtros: string[] = []
  const params: unknown[] = []
  const alias = table === 'contas_apagar' ? 'cp' : 'cr'
  const origem = table === 'contas_apagar' ? ' LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id' : ' LEFT JOIN lancamentos l ON l.id = cr.lancamentos_id'
  const joinsCotista = table === 'contas_areceber'
    ? ' LEFT JOIN cotista_aeronave ca ON ca.id = COALESCE(cr.cotista_id, l.cotista_aeronave_id) LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id'
    : ''
  const nomeCotista = table === 'contas_areceber'
    ? "COALESCE(NULLIF(TRIM(cl.razao_social), ''), NULLIF(TRIM(hs.nome), ''), NULLIF(TRIM(ca.codigo_cliente), '')) AS cotista_nome"
    : 'NULL AS cotista_nome'
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
  const rows = await listar(c.env.SHARE_DB, `SELECT ${alias}.*, l.data_emissao AS lancamento_data_emissao, l.numero_nf, l.numero_recibo, l.numero_doc, l.numero_demonstrativo, l.url_demonstrativo, l.url_nf, l.url_recibo, l.url_boleto, l.url_doc, ${nomeCotista} FROM ${table} ${alias}${origem}${joinsCotista}${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(${alias}.data_vencimento) ASC, ${alias}.criado_em DESC LIMIT 500`, ...params)
  const mapped = (await enriquecerFornecedores(c.env.SHARE_DB, rows)).map(mapConta)
  if (table !== 'contas_areceber') return mapped

  const lancamentoIds = [...new Set(mapped
    .map(conta => conta.lancamentoId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const rateios = lancamentoIds.length
    ? await listar(c.env.SHARE_DB,
      `SELECT id, lancamento_id, cotista_id, valor_rateado_centavos, valor_pago_real_centavos, status FROM rateio_despesas WHERE lancamento_id IN (${lancamentoIds.map(() => '?').join(', ')}) ORDER BY rowid`,
      ...lancamentoIds,
    )
    : []
  const rateiosPorLancamento = new Map<string, typeof rateios>()
  for (const rateio of rateios) {
    const lancamentoId = String(rateio.lancamento_id)
    const agrupados = rateiosPorLancamento.get(lancamentoId) ?? []
    agrupados.push(rateio)
    rateiosPorLancamento.set(lancamentoId, agrupados)
  }
  return mapped.map(conta => ({ ...conta, rateios: rateiosPorLancamento.get(String(conta.lancamentoId)) ?? [] }))
}

contasRoutes.get('/contas-apagar', async (c) => {
  try { return c.json(await consultarContas(c, 'contas_apagar')) } catch (error) { return errorResponse(c, error) }
})

contasRoutes.post('/contas-apagar', async (c) => {
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

contasRoutes.get('/contas-areceber', async (c) => {
  try { return c.json(await consultarContas(c, 'contas_areceber')) } catch (error) { return errorResponse(c, error) }
})
