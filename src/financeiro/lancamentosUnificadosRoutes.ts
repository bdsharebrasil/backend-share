import { Hono } from 'hono'
import { createExpense, issueRevenue, settlePayable, settleReceivable, settleCotista } from './FinanceiroKernel'
import { errorResponse } from './errorResponse'

type Row = Record<string, unknown>
type Env = { Bindings: { SHARE_DB: D1Database }; Variables: { userId: string | null } }
const routes = new Hono<Env>()

function norm(value: unknown): string { return String(value ?? '').trim() }
function toCents(body: Row): number | null {
  const cents = body.valor_centavos ?? body.valorCentavos
  if (cents != null && cents !== '') {
    const parsed = Number(cents)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  const raw = body.valor ?? body.valor_total
  if (raw == null || raw === '') return null
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.'))
  const result = Math.round(parsed * 100)
  return Number.isFinite(result) && Number.isSafeInteger(result) && result > 0 ? result : null
}
function canonicalStatus(status: unknown, due: unknown, today = new Date().toISOString().slice(0, 10)): string {
  const value = norm(status).toUpperCase()
  if (value === 'CANCELADO') return 'CANCELADO'
  if (value === 'PAGO' || value === 'RECEBIDO') return 'PAGO'
  if (due && norm(due).slice(0, 10) < today) return 'ATRASADO'
  return 'PENDENTE'
}

routes.get('/lancamentos-unificados', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const page = Math.max(1, Math.min(100_000, Number(c.req.query('pagina') || 1) || 1))
    const limit = Math.max(1, Math.min(200, Number(c.req.query('limite') || c.req.query('por_pagina') || 50) || 50))
    const offset = (page - 1) * limit
    const clauses: string[] = []
    const params: unknown[] = []
    const fluxo = norm(c.req.query('fluxo')).toUpperCase()
    const caixa = norm(c.req.query('caixa')).toUpperCase()
    const status = norm(c.req.query('status')).toUpperCase()
    const inicio = norm(c.req.query('inicio'))
    const fim = norm(c.req.query('fim'))
    const busca = norm(c.req.query('q'))
    if (fluxo) { if (!['ENTRADA', 'SAIDA'].includes(fluxo)) return c.json({ error: 'fluxo_invalido' }, 400); clauses.push('fluxo = ?'); params.push(fluxo) }
    if (caixa) { if (!['SHARE', 'CLIENTE'].includes(caixa)) return c.json({ error: 'caixa_invalido' }, 400); clauses.push('caixa = ?'); params.push(caixa) }
    if (status) {
      if (!['PENDENTE', 'ATRASADO', 'PAGO', 'CANCELADO'].includes(status)) return c.json({ error: 'status_invalido' }, 400)
      if (status === 'ATRASADO') clauses.push("status = 'PENDENTE' AND data_vencimento IS NOT NULL AND date(data_vencimento) < date('now')")
      else { clauses.push('status = ?'); params.push(status) }
    }
    if (inicio) { clauses.push('date(COALESCE(data_lancamento, criado_em)) >= date(?)'); params.push(inicio) }
    if (fim) { clauses.push('date(COALESCE(data_lancamento, criado_em)) <= date(?)'); params.push(fim) }
    if (busca) {
      clauses.push('(descricao LIKE ? OR categoria LIKE ? OR favorecido LIKE ? OR numero_documento LIKE ? OR origem_id LIKE ?)')
      const pattern = `%${busca}%`; params.push(pattern, pattern, pattern, pattern, pattern)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const [count, result] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS total FROM lancamentos_unificados ${where}`).bind(...params).first<{ total: number }>(),
      db.prepare(`SELECT * FROM lancamentos_unificados ${where} ORDER BY date(COALESCE(data_vencimento,data_lancamento,criado_em)) DESC, criado_em DESC, id DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<Row>(),
    ])
    const lancamentos = (result.results || []).map((row) => ({ ...row, situacao: canonicalStatus(row.status, row.data_vencimento) }))
    return c.json({ lancamentos, total: Number(count?.total || 0), pagina: page, por_pagina: limit })
  } catch (error) { return errorResponse(c, error) }
})

routes.post('/lancamentos-unificados', async (c) => {
  try {
    const body = await c.req.json<Row>()
    const fluxo = norm(body.fluxo).toUpperCase()
    const caixa = norm(body.caixa ?? body.tipo_caixa).toUpperCase() || 'SHARE'
    const valorCentavos = toCents(body)
    if (!['ENTRADA', 'SAIDA'].includes(fluxo)) return c.json({ error: 'fluxo_invalido' }, 400)
    if (!['SHARE', 'CLIENTE'].includes(caixa)) return c.json({ error: 'caixa_invalido' }, 400)
    if (!valorCentavos) return c.json({ error: 'valor_centavos_invalido' }, 400)
    const command: Row = {
      ...body,
      fluxo,
      tipo_caixa: caixa,
      valor_centavos: valorCentavos,
      descricao: norm(body.descricao),
      data: body.data ?? body.data_lancamento ?? body.data_emissao,
      data_emissao: body.data_lancamento ?? body.data_emissao ?? body.data,
      data_vencimento: body.data_vencimento ?? null,
      categoria_id: body.categoria_id ?? body.categoriaId,
      categoria_nome: body.categoria ?? body.categoria_nome,
      fornecedor: body.favorecido ?? body.fornecedor,
      fornecedor_nome: body.favorecido ?? body.fornecedor_nome ?? body.fornecedor,
      conta_bancaria_id: body.conta_bancaria_id ?? body.contaBancariaId,
      cotista_aeronave_id: body.cotista_id ?? body.cotista_aeronave_id,
      reembolsavel: body.reembolsavel === true || body.reembolsavel === 1 ? 1 : 0,
      idempotency_key: body.idempotency_key ?? body.idempotencyKey,
    }
    const userId = c.get('userId') || null
    const result = fluxo === 'ENTRADA'
      ? await issueRevenue(c.env.SHARE_DB, command, userId)
      : await createExpense(c.env.SHARE_DB, command, userId)
    const sourceId = norm(result.lancamento_id ?? result.id)
    const canonical = sourceId
      ? await c.env.SHARE_DB.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(sourceId).first<Row>()
      : null
    return c.json({ ...result, lancamento_unificado: canonical }, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

const PATCH_FIELDS: Record<string, string> = {
  descricao: 'descricao', categoria: 'categoria', categoria_id: 'categoria_id', favorecido: 'favorecido',
  conta_bancaria_id: 'conta_bancaria_id', data_lancamento: 'data_lancamento', data_vencimento: 'data_vencimento',
  valor_centavos: 'valor_centavos', reembolsavel: 'reembolsavel', cotista_id: 'cotista_id',
  numero_documento: 'numero_documento', nf_url: 'nf_url', boleto_url: 'boleto_url', observacoes: 'observacoes',
}
routes.patch('/lancamentos-unificados/:id', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const existing = await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>()
    if (!existing) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    if (existing.status !== 'PENDENTE') return c.json({ error: 'somente_lancamento_pendente_pode_ser_editado' }, 409)
    const body = await c.req.json<Row>()
    const origin = norm(existing.origem_tipo)
    if (!['lancamentos', 'contas_apagar', 'contas_areceber'].includes(origin)) return c.json({ error: 'origem_edicao_indisponivel', detalhe: 'Solicitações devem ser alteradas pelo fluxo de aprovação.' }, 409)
    const changes: Array<[string, unknown]> = []
    for (const [key, column] of Object.entries(PATCH_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue
      const value = body[key]
      if (key === 'valor_centavos' && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) return c.json({ error: 'valor_centavos_invalido' }, 400)
      if (key === 'reembolsavel' && ![true, false, 0, 1].includes(value as boolean | number)) return c.json({ error: 'reembolsavel_invalido' }, 400)
      changes.push([column, key === 'reembolsavel' ? (value === true || value === 1 ? 1 : 0) : value])
    }
    if (!changes.length) return c.json({ error: 'nenhum_campo_para_atualizar' }, 400)
    const update = async (table: string, where: string, value: string | null, mapped: Array<[string, unknown]>) => {
      if (!value || !mapped.length) return null
      return db.prepare(`UPDATE ${table} SET ${mapped.map(([column]) => `${column} = ?`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE ${where}`).bind(...mapped.map(([, item]) => item), value)
    }
    const statements: D1PreparedStatement[] = []
    if (origin === 'lancamentos') {
      const mapped: Array<[string, unknown]> = []
      const client = norm(existing.caixa) === 'CLIENTE'
      const columns: Record<string, string> = { descricao: 'descricao', categoria: 'categoria_nome', categoria_id: client ? 'categoria_cliente_id' : 'categoria_share_id', favorecido: 'fornecedor_nome', conta_bancaria_id: 'conta_bancaria_id', data_lancamento: 'data_emissao', data_vencimento: 'data_vencimento', valor_centavos: 'valor_centavos', reembolsavel: 'reembolsavel', cotista_id: 'cotista_aeronave_id', numero_documento: 'numero_doc', nf_url: 'url_nf', boleto_url: 'url_boleto', observacoes: 'observacoes' }
      for (const [key, value] of changes) mapped.push([columns[key], value])
      const primary = await update('lancamentos', 'id = ?', norm(existing.lancamento_id), mapped)
      if (primary) statements.push(primary)
      const linkedId = norm(existing.lancamento_id)
      const payableChanges = mapped.filter(([column]) => ['descricao', 'categoria_nome', 'categoria_id', 'data_vencimento', 'valor_centavos'].includes(column))
      const receiveChanges = payableChanges
      for (const statement of [
        await update('contas_apagar', 'lancamentos_id = ?', linkedId, payableChanges),
        await update('contas_areceber', 'lancamentos_id = ?', linkedId, receiveChanges),
      ]) if (statement) statements.push(statement)
    } else if (origin === 'contas_apagar') {
      const columns: Record<string, string> = { descricao: 'descricao', categoria: 'categoria_nome', categoria_id: 'categoria_id', conta_bancaria_id: 'banco_pagamento', data_lancamento: 'data_lancamento', data_vencimento: 'data_vencimento', valor_centavos: 'valor_centavos', cotista_id: 'cotista_id', boleto_url: 'boleto_url', nf_url: 'nf_url' }
      const mapped = changes.filter(([key]) => columns[key]).map(([key, value]) => [columns[key], value] as [string, unknown])
      const statement = await update('contas_apagar', 'id = ?', norm(existing.conta_a_pagar_id), mapped)
      if (statement) statements.push(statement)
    } else {
      const columns: Record<string, string> = { descricao: 'descricao', categoria: 'categoria_nome', categoria_id: 'categoria_id', conta_bancaria_id: 'banco_recebimento', data_vencimento: 'data_vencimento', valor_centavos: 'valor_centavos', cotista_id: 'cotista_id', nf_url: 'nf_url' }
      const mapped = changes.filter(([key]) => columns[key]).map(([key, value]) => [columns[key], value] as [string, unknown])
      const statement = await update('contas_areceber', 'id = ?', norm(existing.conta_a_receber_id), mapped)
      if (statement) statements.push(statement)
    }
    if (!statements.length) return c.json({ error: 'campos_nao_aplicaveis_a_origem' }, 400)
    await db.batch(statements)
    return c.json(await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>())
  } catch (error) { return errorResponse(c, error) }
})

routes.delete('/lancamentos-unificados/:id', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const row = await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>()
    if (!row) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    if (row.status === 'PAGO') return c.json({ error: 'lancamento_pago_nao_pode_ser_cancelado' }, 409)
    const statements: D1PreparedStatement[] = []
    if (row.lancamento_id) {
      statements.push(db.prepare("UPDATE lancamentos SET status='CANCELADO', atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(row.lancamento_id))
      statements.push(db.prepare("UPDATE contas_apagar SET status='CANCELADO', atualizado_em=CURRENT_TIMESTAMP WHERE lancamentos_id=? AND status<>'PAGO'").bind(row.lancamento_id))
      statements.push(db.prepare("UPDATE contas_areceber SET status='CANCELADO', atualizado_em=CURRENT_TIMESTAMP WHERE lancamentos_id=? AND status NOT IN ('PAGO','RECEBIDO')").bind(row.lancamento_id))
    } else if (row.conta_a_pagar_id) statements.push(db.prepare("UPDATE contas_apagar SET status='CANCELADO', atualizado_em=CURRENT_TIMESTAMP WHERE id=? AND status<>'PAGO'").bind(row.conta_a_pagar_id))
    else if (row.conta_a_receber_id) statements.push(db.prepare("UPDATE contas_areceber SET status='CANCELADO', atualizado_em=CURRENT_TIMESTAMP WHERE id=? AND status NOT IN ('PAGO','RECEBIDO')").bind(row.conta_a_receber_id))
    else return c.json({ error: 'origem_cancelamento_indisponivel' }, 409)
    await db.batch(statements)
    return c.json(await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>())
  } catch (error) { return errorResponse(c, error) }
})

routes.post('/lancamentos-unificados/:id/baixa', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const row = await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>()
    if (!row) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    const body = await c.req.json<Row>().catch(() => ({} as Row))
    const userId = c.get('userId') || null
    if (row.conta_a_pagar_id) return c.json(await settlePayable(db, String(row.conta_a_pagar_id), body, userId))
    if (row.conta_a_receber_id) return c.json(await settleReceivable(db, String(row.conta_a_receber_id), body, userId))
    const launchId = norm(row.lancamento_id)
    if (launchId && row.caixa === 'CLIENTE') {
      return c.json(await settleCotista(db, launchId, body, userId))
    }
    if (launchId) {
      const source = await db.prepare('SELECT fluxo, status, reembolsavel FROM lancamentos WHERE id = ?').bind(launchId).first<Row>()
      if (!source) return c.json({ error: 'lancamento_origem_nao_encontrado' }, 404)
      if (norm(source.status).toUpperCase() === 'CANCELADO') return c.json({ error: 'lancamento_cancelado_nao_pode_ser_baixado' }, 409)
      if (source.reembolsavel === 1 || source.reembolsavel === true || source.reembolsavel === '1') return c.json({ error: 'lancamento_reembolsavel_nao_pode_ser_baixado' }, 409)
      if (['PAGO', 'RECEBIDO'].includes(norm(source.status).toUpperCase())) return c.json({ ...(await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>()), idempotent: true })
      const paidDate = norm(body.data_pagamento ?? body.dataPagamento ?? new Date().toISOString().slice(0, 10))
      const parsedDate = new Date(`${paidDate}T00:00:00Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== paidDate) return c.json({ error: 'data_pagamento_invalida' }, 400)
      const incoming = ['ENTRADA', 'RECEITA'].includes(norm(source.fluxo).toUpperCase())
      await db.prepare(`UPDATE lancamentos SET status = ?, data_pagamento = ?,
        conta_bancaria_id = COALESCE(?, conta_bancaria_id), comprovante_url = COALESCE(?, comprovante_url),
        forma_pagamento = COALESCE(?, forma_pagamento), pago_diretamente = CASE WHEN ? = 1 THEN 1 ELSE pago_diretamente END,
        atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(incoming ? 'RECEBIDO' : 'PAGO', paidDate, body.conta_bancaria_id ?? null,
          body.comprovante_url ?? body.comprovante_pagamento_url ?? null, body.forma_pagamento ?? null,
          incoming ? 1 : 0, launchId).run()
      return c.json({ ...(await db.prepare('SELECT * FROM lancamentos_unificados WHERE id = ?').bind(id).first<Row>()), idempotent: false })
    }
    return c.json({ error: 'origem_baixa_indisponivel' }, 409)
  } catch (error) { return errorResponse(c, error) }
})

export { routes as lancamentosUnificadosRoutes, canonicalStatus, toCents }
