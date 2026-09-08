type Row = Record<string, any>
type Database = D1Database

export type FinanceFlow = 'ENTRADA' | 'SAIDA'
export type FinanceOperation = 'DESPESA' | 'RECEITA' | 'REEMBOLSO'

export class FinanceKernelError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 400) {
    super(message)
    this.name = 'FinanceKernelError'
  }
}

const text = (value: unknown) => value == null ? '' : String(value).trim()
const flag = (value: unknown) => value === true || value === 1 || ['1', 'true', 'sim', 'yes'].includes(text(value).toLowerCase())
const positive = (value: unknown) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new FinanceKernelError('Valor deve ser maior que zero', 'valor_invalido')
  return n
}
const moneyCents = (body: Row) => body.valorCentavos != null || body.valor_centavos != null
  ? Math.round(positive(body.valorCentavos ?? body.valor_centavos))
  : Math.round(positive(body.valor_total ?? body.valor) * 100)
const idempotency = (body: Row) => text(body.idempotencyKey ?? body.idempotency_key ?? body.reference_id) || null
const uuid = () => crypto.randomUUID()
const dateOf = (body: Row) => text(body.data_emissao ?? body.data ?? new Date().toISOString().slice(0, 10))
const upper = (value: unknown, fallback: string) => text(value || fallback).toUpperCase()

async function columns(db: Database, table: string) {
  const result = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()
  return new Set((result.results || []).map(row => String(row.name)))
}

async function insertDynamic(db: Database, table: string, input: Row) {
  const available = await columns(db, table)
  const entries = Object.entries(input).filter(([key, value]) => available.has(key) && value !== undefined)
  if (!entries.length) throw new FinanceKernelError(`Schema incompatível: ${table}`, 'schema_incompativel', 500)
  const names = entries.map(([key]) => key)
  await db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).bind(...entries.map(([, value]) => value)).run()
}

async function audit(db: Database, entity: string, entityId: string, operation: string, userId: string | null, oldValue: number | null, newValue: number | null, reason: string | null, key: string | null) {
  await db.prepare('INSERT INTO auditoria_financeira (id, entidade, entidade_id, operacao, valor_anterior_centavos, valor_novo_centavos, usuario_id, motivo, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(uuid(), entity, entityId, operation, oldValue, newValue, userId, reason, key).run()
}

async function collaborator(db: Database, body: Row) {
  const userProfileId = text(body.userProfileId ?? body.user_profile_id ?? body.colaborador_id) || null
  if (!userProfileId) return null
  const existing = await db.prepare('SELECT id FROM colaboradores WHERE user_profile_id = ?').bind(userProfileId).first<{ id: string }>()
  if (existing) return existing.id
  const profile = await db.prepare('SELECT nome_completo, cpf, pix FROM user_profiles WHERE id = ?').bind(userProfileId).first<Row>().catch(() => null)
  const id = uuid()
  await db.prepare('INSERT INTO colaboradores (id, user_profile_id, nome, cpf, pix) VALUES (?, ?, ?, ?, ?)').bind(id, userProfileId, text(profile?.nome_completo) || text(body.colaborador_nome) || 'Colaborador', profile?.cpf ?? null, profile?.pix ?? null).run()
  return id
}

function rateioType(value: unknown) {
  const normalized = text(value).toUpperCase().replaceAll(' ', '_')
  return ['FIXO', 'VARIAVEL_POR_VOO', 'VARIAVEL_POR_HORA', 'EXTRA'].includes(normalized) ? normalized : 'FIXO'
}

function rateioLines(body: Row, amount: number) {
  const supplied = Array.isArray(body.rateio_linhas) ? body.rateio_linhas : Array.isArray(body.rateios) ? body.rateios : []
  if (supplied.length) return supplied.map((line: Row) => ({
    cotista_id: text(line.cotista_id ?? line.cotistaId), socio_id: text(line.socio_id ?? line.socioId) || null,
    holding_id: text(line.holding_id ?? line.holdingId) || null, nome: text(line.nome) || 'Cotista',
    percentual: Number(line.percentual ?? line.percentual_sociedade ?? 0), valorCentavos: line.valor_centavos != null ? Math.round(Number(line.valor_centavos)) : Math.round(Number(line.valor ?? 0) * 100),
    pago_por: text(line.pago_por ?? line.pagoPor) || null, pago_diretamente: flag(line.pago_diretamente ?? line.pagoDiretamente),
  }))
  const cotistaId = text(body.cotista_id ?? body.cotista_aeronave_id)
  return cotistaId ? [{ cotista_id: cotistaId, socio_id: text(body.socio_id) || null, holding_id: text(body.holding_id) || null, nome: 'Cotista', percentual: 100, valorCentavos: amount, pago_por: text(body.pago_por) || null, pago_diretamente: flag(body.pago_diretamente ?? body.pagoDiretamente) }] : []
}

async function holdingContext(db: Database, body: Row, lines: Row[]) {
  if (text(body.socio_id ?? body.socioId ?? body.holding_id ?? body.holdingId)) return { socioId: text(body.socio_id ?? body.socioId) || null, holdingId: text(body.holding_id ?? body.holdingId) || null }
  const cotistaId = text(body.cotista_id ?? body.cotista_aeronave_id) || text(lines.find(line => line.socio_id)?.cotista_id)
  if (!cotistaId) return { socioId: null, holdingId: null }
  const row = await db.prepare('SELECT ca.socio_id, hs.holding_id FROM cotista_aeronave ca LEFT JOIN hold_socios hs ON hs.id=ca.socio_id WHERE ca.id=?').bind(cotistaId).first<Row>().catch(() => null)
  return { socioId: text(row?.socio_id) || null, holdingId: text(row?.holding_id) || null }
}

async function createAllocationRows(db: Database, body: Row, sourceId: string | null, movementId: string | null, amount: number, userId: string | null, direct: boolean, holding: boolean, data: string, suppliedLines?: Row[]) {
  const lines = suppliedLines ?? rateioLines(body, amount)
  if (!lines.length) return []
  const type = rateioType(body.tipo_rateio)
  const ids: string[] = []
  for (const line of lines) {
    const id = uuid(); ids.push(id)
    const value = line.valorCentavos > 0 ? line.valorCentavos : Math.round(amount * Number(line.percentual || 0) / 100)
    const paidDirect = direct || line.pago_diretamente ? 1 : 0
    if (holding || line.socio_id) {
      await insertDynamic(db, 'rateio_hold', {
        id, movimento_holding_id: movementId, cotista_id: line.cotista_id || null, socio_id: line.socio_id || null, holding_id: line.holding_id || body.holding_id || null,
        aeronave_id: body.aeronave_id ?? null, categoria_id: body.categoria_id ?? null, categoria_nome: text(body.categoria_nome ?? body.categoria), tipo_rateio: type,
        percentual_sociedade: line.percentual || null, percentual_uso: line.percentual || null, valor_total_centavos: amount, valor_rateado_centavos: value,
        valor_total: amount / 100, valor_rateado: value / 100, pago_por_socio_id: line.pago_por || null, pago_diretamente: paidDirect,
        status: paidDirect ? 'PAGO' : 'EM_ABERTO', data_pagamento: paidDirect ? (body.data_pagamento ?? data) : null, descricao_despesa: text(body.descricao), observacoes: body.observacoes ?? null, criado_por: userId,
      })
    } else {
      await insertDynamic(db, 'rateio_despesas', {
        id, lancamento_id: sourceId, cotista_id: line.cotista_id || null, aeronave_id: body.aeronave_id ?? null, fornecedor_id: body.fornecedor_id ?? null,
        categoria_id: body.categoria_id ?? null, categoria_nome: text(body.categoria_nome ?? body.categoria), tipo_rateio: type, percentual_sociedade: line.percentual || null, percentual_uso: line.percentual || null,
        valor_total_centavos: amount, valor_rateado_centavos: value, valor_total: amount / 100, valor_rateado: value / 100, pago_por_cotista_id: line.pago_por || null, pago_por: line.pago_por || null,
        pago_diretamente: paidDirect, status: paidDirect ? 'PAGO_DIRETAMENTE' : 'PENDENTE', data_pagamento: paidDirect ? (body.data_pagamento ?? data) : null, descricao_despesa: text(body.descricao), observacoes: body.observacoes ?? null,
      })
    }
  }
  return ids
}

export async function createExpense(db: Database, body: Row, userId: string | null) {
  const key = idempotency(body)
  if (key) {
    const old = await db.prepare('SELECT id FROM lancamentos WHERE idempotency_key=?').bind(key).first<Row>().catch(() => null)
    if (old) return { id: old.id, idempotent: true }
    if ((await columns(db, 'movimentos_holding')).has('idempotency_key')) {
      const oldHolding = await db.prepare('SELECT id FROM movimentos_holding WHERE idempotency_key=?').bind(key).first<Row>()
      if (oldHolding) return { id: oldHolding.id, idempotent: true }
    }
  }
  const amount = moneyCents(body), direct = flag(body.pagoDiretamente ?? body.pago_diretamente), data = dateOf(body)
  let lines = rateioLines(body, amount), context = await holdingContext(db, body, lines)
  const holding = Boolean(context.socioId || context.holdingId || lines.some(line => line.socio_id))
  if (holding) lines = lines.map(line => ({ ...line, socio_id: line.socio_id || context.socioId, holding_id: line.holding_id || context.holdingId }))
  const reembolsavel = flag(body.reembolsavel)
  const statusInformado = upper(body.status, '')
  const status = ['EM_ABERTO', 'AGUARDANDO_REEMBOLSO', 'REEMBOLSADO', 'PAGO'].includes(statusInformado) ? statusInformado : direct ? 'PAGO' : 'EM_ABERTO'
  const collaboratorId = await collaborator(db, body)
  let lancamentoId: string | null = null, movementId: string | null = null, contaId: string | null = null

  if (holding) {
    movementId = text(body.id) || uuid()
    await insertDynamic(db, 'movimentos_holding', { id: movementId, holding_id: context.holdingId || null, socio_id: context.socioId || null, cotista_id: body.cotista_id ?? null, aeronave_id: body.aeronave_id ?? null, data: data, data_movimento: data, descricao: text(body.descricao), fornecedor_nome: body.fornecedor_nome ?? body.fornecedor ?? null, categoria_id: body.categoria_id ?? null, categoria_nome: body.categoria_nome ?? body.categoria ?? null, grupo_categoria: body.grupo_categoria ?? 'DESPESAS EMPRESA', fluxo: 'SAIDA', natureza: reembolsavel ? 'REEMBOLSO' : 'DESPESA', valor_centavos: amount, pago_diretamente: direct ? 1 : 0, status, criado_por: userId, observacoes: body.observacoes ?? null, idempotency_key: key })
    await createAllocationRows(db, body, null, movementId, amount, userId, direct, true, data, lines)
  } else if (!direct) {
    lancamentoId = text(body.id) || uuid()
    await insertDynamic(db, 'lancamentos', { id: lancamentoId, aeronave_id: body.aeronave_id ?? null, cotista_aeronave_id: body.cotista_id ?? body.cotista_aeronave_id ?? null, descricao: text(body.descricao), fornecedor_nome: body.fornecedor_nome ?? body.fornecedor ?? null, categoria_id: body.categoria_id ?? null, categoria_nome: body.categoria_nome ?? body.categoria ?? 'SEM CATEGORIA', grupo_categoria: body.grupo_categoria ?? (reembolsavel ? 'DESPESAS REEMBOLSÁVEIS' : 'DESPESAS EMPRESA'), fluxo: 'SAIDA', natureza: 'DESPESA', tipo_caixa: 'SHARE', valor_centavos: amount, valor_total: amount / 100, valor: amount / 100, status, data_lancamento: data, data_emissao: data, data_vencimento: body.data_vencimento ?? body.vencimento ?? null, pago_diretamente: 0, reembolsavel: reembolsavel ? 1 : 0, reembolso_quitado: 0, colaborador_ref_id: collaboratorId, origem_tipo: text(body.origem_tipo ?? 'DESPESA'), origem_id: text(body.origem_id) || null, idempotency_key: key, criado_por: userId, observacoes: body.observacoes ?? null })
    contaId = uuid()
    await insertDynamic(db, 'contas_apagar', { id: contaId, data_vencimento: body.data_vencimento ?? body.vencimento ?? data, valor_centavos: amount, valor: amount / 100, descricao: text(body.descricao), categoria_id: body.categoria_id ?? null, categoria_nome: body.categoria_nome ?? body.categoria ?? null, criado_por: userId, aeronave_id: body.aeronave_id ?? null, fornecedor_id: body.fornecedor_id ?? null, cotista_id: body.cotista_id ?? null, colaborador_id: collaboratorId, lancamento_id: lancamentoId, origem_tipo: 'DESPESA', origem_id: lancamentoId, idempotency_key: key, status: status === 'PAGO' ? 'PAGO' : 'EM_ABERTO' })
    await createAllocationRows(db, body, lancamentoId, null, amount, userId, false, false, data, lines)
  } else {
    await createAllocationRows(db, body, null, null, amount, userId, true, false, data, lines)
  }
  const id = lancamentoId || movementId
  if (!id) throw new FinanceKernelError('Despesa sem origem financeira', 'origem_financeira_ausente', 500)
  await audit(db, holding ? 'movimentos_holding' : direct ? 'rateio_despesas' : 'lancamento', id, 'CRIACAO_DESPESA', userId, null, amount, text(body.motivo) || null, key)
  return { id, contaPagarId: contaId, movimentoHoldingId: movementId, rateioIds: [], valorCentavos: amount, status, idempotent: false }
}

export async function createReimbursement(db: Database, body: Row, userId: string | null) {
  const key = idempotency(body), original = text(body.lancamentoOrigemId ?? body.lancamento_origem_id ?? body.lancamento_id)
  if (!original) throw new FinanceKernelError('Lançamento de origem obrigatório', 'lancamento_origem_obrigatorio')
  const amount = moneyCents(body), id = uuid(), accountId = uuid(), data = dateOf(body), cotistaId = text(body.cotista_id ?? body.cotista_aeronave_id) || null
  await insertDynamic(db, 'reembolsos', { id, lancamento_origem_id: original, colaborador_id: body.colaborador_id ?? null, cotista_id: cotistaId, valor_centavos: amount, idempotency_key: key, criado_por: userId, status: 'PENDENTE' })
  const shareId = uuid(), clientId = cotistaId ? uuid() : null
  await insertDynamic(db, 'lancamentos', { id: shareId, aeronave_id: body.aeronave_id ?? null, cotista_aeronave_id: cotistaId, descricao: text(body.descricao ?? 'Reembolso de despesa'), categoria_nome: 'REEMBOLSOS ENTRADAS', grupo_categoria: 'REEMBOLSOS ENTRADAS', fluxo: 'ENTRADA', natureza: 'REEMBOLSO', tipo_caixa: 'SHARE', valor_centavos: amount, valor_total: amount / 100, valor: amount / 100, status: 'AGUARDANDO_REEMBOLSO', data_lancamento: data, data_emissao: data, data_vencimento: body.data_vencimento ?? data, origem_tipo: 'REEMBOLSO', origem_id: id, criado_por: userId, observacoes: body.observacoes ?? null })
  if (clientId) await insertDynamic(db, 'lancamentos', { id: clientId, aeronave_id: body.aeronave_id ?? null, cotista_aeronave_id: cotistaId, descricao: text(body.descricao ?? 'Reembolso de despesa'), categoria_nome: body.categoria_cliente_nome ?? 'REEMBOLSO', grupo_categoria: 'REEMBOLSO', fluxo: 'SAIDA', natureza: 'DESPESA', tipo_caixa: 'CLIENTE', valor_centavos: amount, valor_total: amount / 100, valor: amount / 100, status: 'EM_ABERTO', data_lancamento: data, data_emissao: data, data_vencimento: body.data_vencimento ?? data, origem_tipo: 'REEMBOLSO', origem_id: id, criado_por: userId })
  await insertDynamic(db, 'contas_areceber', { id: accountId, data_vencimento: body.data_vencimento ?? data, valor_centavos: amount, valor: amount / 100, descricao: text(body.descricao ?? 'Reembolso de despesa'), categoria_nome: 'REEMBOLSOS ENTRADAS', aeronave_id: body.aeronave_id ?? null, cotista_id: cotistaId, lancamento_receita_id: shareId, lancamento_id: shareId, lancamentos_id: shareId, lancamento_cliente_id: clientId, origem_tipo: 'REEMBOLSO', origem_id: id, idempotency_key: `${key || id}:receber`, criado_por: userId, status: 'EM_ABERTO' })
  await db.prepare('UPDATE reembolsos SET conta_receber_id=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(accountId, id).run()
  return { id, contaReceberId: accountId, lancamentoId: shareId, lancamentoClienteId: clientId, valorCentavos: amount, status: 'EM_ABERTO', idempotent: false }
}

export async function settlePayable(db: Database, id: string, body: Row, userId: string | null) {
  const row = await db.prepare('SELECT * FROM contas_apagar WHERE id=?').bind(id).first<Row>(); if (!row) throw new FinanceKernelError('Conta a pagar não encontrada', 'nao_encontrado', 404)
  if (upper(row.status, '') === 'PAGO') return { ...row, idempotent: true }
  if (upper(row.status, '') === 'CANCELADO') throw new FinanceKernelError('Conta cancelada não pode ser paga', 'conta_cancelada')
  const date = text(body.dataPagamento ?? body.data_pagamento); if (!date) throw new FinanceKernelError('Data de pagamento obrigatória', 'data_pagamento_obrigatoria')
  const amount = Number(row.valor_centavos ?? Math.round(Number(row.valor || 0) * 100)), linked = text(row.lancamento_id) || null
  await db.prepare("UPDATE contas_apagar SET status='PAGO', valor_centavos=?, data_pagamento=?, banco_pagamento=?, comprovante_pagamento_url=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(amount, date, body.bancoPagamento ?? body.banco_pagamento ?? null, body.comprovantePagamentoUrl ?? body.comprovante_pagamento_url ?? null, id).run()
  if (linked) await db.prepare("UPDATE lancamentos SET status='PAGO', data_pagamento=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(date, linked).run()
  const source = linked ? await db.prepare('SELECT * FROM lancamentos WHERE id=?').bind(linked).first<Row>() : null
  let reimbursement: Row | null = null
  if (source && flag(source.reembolsavel) && !flag(source.reembolso_quitado)) {
    const existing = await db.prepare('SELECT id, conta_receber_id FROM reembolsos WHERE lancamento_origem_id=? ORDER BY criado_em DESC LIMIT 1').bind(linked).first<Row>()
    reimbursement = existing ? { id: existing.id, contaReceberId: existing.conta_receber_id, idempotent: true } : await createReimbursement(db, { lancamento_id: linked, cotista_id: source.cotista_aeronave_id ?? source.cotista_id, aeronave_id: source.aeronave_id, descricao: source.descricao, valorCentavos: amount, data: date, data_vencimento: source.data_vencimento }, userId)
    await db.prepare("UPDATE rateio_despesas SET status='AGUARDANDO_REEMBOLSO' WHERE lancamento_id=? AND status NOT IN ('CANCELADO','REEMBOLSADO')").bind(linked).run().catch(() => undefined)
  }
  await audit(db, 'conta_apagar', id, 'BAIXA', userId, amount, amount, text(body.motivo) || null, idempotency(body))
  return { ...(await db.prepare('SELECT * FROM contas_apagar WHERE id=?').bind(id).first<Row>()), reimbursement, idempotent: false }
}

export async function issueRevenue(db: Database, body: Row, userId: string | null) {
  const key = idempotency(body)
  if (key) {
    const old = await db.prepare('SELECT id, lancamento_receita_id, lancamento_id, lancamentos_id FROM contas_areceber WHERE idempotency_key=?').bind(key).first<Row>()
    if (old) return { id: old.lancamento_receita_id ?? old.lancamento_id ?? old.lancamentos_id, contaReceberId: old.id, idempotent: true }
  }
  const amount = moneyCents(body), id = uuid(), accountId = uuid(), data = dateOf(body), cotistaId = text(body.cotista_id ?? body.cotista_aeronave_id) || null
  const clientId = cotistaId && body.criar_lancamento_cliente !== false ? uuid() : null
  await insertDynamic(db, 'lancamentos', { id, descricao: text(body.descricao), fluxo: 'ENTRADA', natureza: 'RECEITA', tipo_caixa: upper(body.tipo_caixa ?? body.caixa, 'SHARE'), valor_centavos: amount, valor_total: amount / 100, valor: amount / 100, categoria_id: body.categoria_id ?? null, categoria_nome: body.categoria_nome ?? 'RECEITA', grupo_categoria: 'RECEITA', cotista_aeronave_id: cotistaId, data_emissao: data, data_vencimento: body.data_vencimento ?? body.vencimento ?? data, origem_tipo: body.origem_tipo ?? 'RECEITA', origem_id: body.origem_id ?? null, status: 'EM_ABERTO', criado_por: userId })
  if (clientId) await insertDynamic(db, 'lancamentos', { id: clientId, descricao: text(body.descricao), fluxo: 'SAIDA', natureza: 'DESPESA', tipo_caixa: 'CLIENTE', valor_centavos: amount, valor_total: amount / 100, valor: amount / 100, categoria_id: body.categoria_cliente_id ?? body.categoria_id ?? null, categoria_nome: body.categoria_cliente_nome ?? body.categoria_nome ?? 'CAIXA CLIENTE', grupo_categoria: body.grupo_categoria_cliente ?? 'CAIXA CLIENTE', cotista_aeronave_id: cotistaId, data_emissao: data, data_vencimento: body.data_vencimento ?? body.vencimento ?? data, origem_tipo: body.origem_tipo ?? 'RECEITA', origem_id: id, status: 'EM_ABERTO', criado_por: userId })
  await insertDynamic(db, 'contas_areceber', { id: accountId, data_vencimento: body.data_vencimento ?? body.vencimento ?? data, valor_centavos: amount, valor: amount / 100, descricao: text(body.descricao), categoria_id: body.categoria_id ?? null, categoria_nome: body.categoria_nome ?? 'RECEITA', cotista_id: cotistaId, lancamento_receita_id: id, lancamento_cliente_id: clientId, lancamento_id: id, lancamentos_id: id, origem_tipo: body.origem_tipo ?? 'RECEITA', origem_id: body.origem_id ?? id, idempotency_key: key, criado_por: userId, status: 'EM_ABERTO' })
  return { id, contaReceberId: accountId, lancamentoClienteId: clientId, valorCentavos: amount, status: 'EM_ABERTO', idempotent: false }
}

export async function settleReceivable(db: Database, id: string, body: Row, userId: string | null) {
  const row = await db.prepare('SELECT * FROM contas_areceber WHERE id=?').bind(id).first<Row>(); if (!row) throw new FinanceKernelError('Conta a receber não encontrada', 'nao_encontrado', 404)
  if (upper(row.status, '') === 'RECEBIDO') return { ...row, idempotent: true }
  const date = text(body.dataRecebimento ?? body.data_recebimento); if (!date) throw new FinanceKernelError('Data de recebimento obrigatória', 'data_recebimento_obrigatoria')
  const amount = Number(row.valor_centavos ?? Math.round(Number(row.valor || 0) * 100)), linked = text(row.lancamentos_id ?? row.lancamento_id), client = text(row.lancamento_cliente_id)
  await db.prepare("UPDATE contas_areceber SET status='RECEBIDO', data_recebimento=?, data_pagamento=?, banco_recebimento=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(date, date, body.bancoRecebimento ?? body.banco_recebimento ?? null, id).run()
  if (linked) await db.prepare("UPDATE lancamentos SET status='RECEBIDO', data_pagamento=? WHERE id=?").bind(date, linked).run()
  if (client) await db.prepare("UPDATE lancamentos SET status='PAGO', data_pagamento=? WHERE id=?").bind(date, client).run()
  const reimbursement = await db.prepare('SELECT * FROM reembolsos WHERE conta_receber_id=?').bind(id).first<Row>().catch(() => null)
  if (reimbursement) { await db.prepare("UPDATE reembolsos SET status='RECEBIDO', recebido_em=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(date, reimbursement.id).run(); await db.prepare('UPDATE lancamentos SET reembolso_quitado=1 WHERE id=?').bind(reimbursement.lancamento_origem_id).run(); await db.prepare("UPDATE rateio_despesas SET status='REEMBOLSADO', data_pagamento=? WHERE lancamento_id=?").bind(date, reimbursement.lancamento_origem_id).run().catch(() => undefined) }
  await audit(db, 'conta_areceber', id, 'BAIXA', userId, amount, amount, text(body.motivo) || null, idempotency(body))
  return { ...(await db.prepare('SELECT * FROM contas_areceber WHERE id=?').bind(id).first<Row>()), idempotent: false }
}

export async function enqueueFinance(db: Database, operation: FinanceOperation, payload: Row) { const id = uuid(); await db.prepare('INSERT INTO financeiro_fila (id, operacao, payload_json) VALUES (?, ?, ?)').bind(id, operation, JSON.stringify(payload)).run(); return { id, status: 'PENDENTE' } }

export async function processFinanceQueue(db: Database, userId: string | null, limit = 20) {
  const rows = await db.prepare("SELECT * FROM financeiro_fila WHERE status='PENDENTE' ORDER BY criado_em LIMIT ?").bind(limit).all<Row>(), result: Row[] = []
  for (const row of rows.results || []) { try { const payload = JSON.parse(String(row.payload_json)); const output = row.operacao === 'DESPESA' ? await createExpense(db, payload, userId) : row.operacao === 'RECEITA' ? await issueRevenue(db, payload, userId) : await createReimbursement(db, payload, userId); await db.prepare("UPDATE financeiro_fila SET status='PROCESSADO', processado_em=CURRENT_TIMESTAMP, tentativas=tentativas+1 WHERE id=? AND status='PENDENTE'").bind(row.id).run(); result.push({ id: row.id, status: 'PROCESSADO', output }) } catch (error) { await db.prepare("UPDATE financeiro_fila SET status='ERRO', erro=?, tentativas=tentativas+1 WHERE id=? AND status='PENDENTE'").bind(text(error instanceof Error ? error.message : error), row.id).run(); result.push({ id: row.id, status: 'ERRO' }) } }
  return result
}

// Migrated from the former LancamentoService: all financial read-model operations live in the kernel.
export class FinanceValidationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'FinanceValidationError'
  }
}



export interface RateioFinanceiro {
  id: string
  cotista: string
  valorCentavos: number
}

export interface LancamentoFinanceiro {
  id: string
  descricao: string
  fluxo: 'ENTRADA' | 'SAIDA'
  categoria: string
  grupoCategoria: string
  valorCentavos: number
  data: string
  prazo: string | null
  status: string
  caixa: string
  tipo: string | null
  fornecedor: string | null
  documento: string | null
  observacoes: string | null
  rateios: RateioFinanceiro[]
}

export interface BalancoFinanceiro {
  lancamentos: LancamentoFinanceiro[]
  saldos: Array<Record<string, any>>
  matrizCompensacao: Record<string, any>
  holdings: Array<Record<string, any> & { socios: Array<Record<string, any>> }>
}

function texto(value: unknown): string {
  return value == null ? '' : String(value)
}

function centavos(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 100)
}

function fluxo(value: unknown): 'ENTRADA' | 'SAIDA' {
  return texto(value).toUpperCase() === 'ENTRADA' ? 'ENTRADA' : 'SAIDA'
}

function normalizarRateio(row: Row): RateioFinanceiro {
  return {
    id: texto(row.id),
    cotista: texto(row.cotista_nome ?? row.nome ?? row.cotista_id ?? 'Cotista não identificado'),
    valorCentavos: centavos(row.valor_rateado ?? row.valor ?? 0),
  }
}

function normalizarLancamento(row: Row, rateios: RateioFinanceiro[] = []): LancamentoFinanceiro {
  return {
    id: texto(row.id),
    descricao: texto(row.descricao),
    fluxo: fluxo(row.fluxo),
    categoria: texto(row.categoria_nome ?? row.categoria ?? 'SEM CATEGORIA'),
    grupoCategoria: texto(row.grupo_categoria ?? row.grupo ?? ''),
    valorCentavos: centavos(row.valor_total ?? row.valor_centavos / 100),
    data: texto(row.data_emissao ?? row.data_emissao_nf ?? row.data ?? row.criado_em ?? '').slice(0, 10),
    prazo: row.data_vencimento ?? row.vencimento ?? null,
    status: texto(row.status || 'PENDENTE').toUpperCase(),
    caixa: texto(row.tipo_caixa ?? row.caixa ?? 'SHARE').toUpperCase(),
    tipo: row.tipo ?? row.tipo_despesa ?? null,
    fornecedor: row.fornecedor_nome ?? row.fornecedor ?? null,
    documento: row.numero_doc ?? row.documento ?? null,
    observacoes: row.observacoes ?? null,
    rateios,
  }
}

export function normalizarLancamentoInput(body: Row, criadoPor?: string): Row {
  const descricao = texto(body.descricao).trim()
  if (!descricao) throw new FinanceValidationError('Descrição é obrigatória', 'descricao_obrigatoria')

  const valor = Number(body.valor_total ?? body.valor ?? 0)
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new FinanceValidationError('Valor deve ser maior que zero', 'valor_invalido')
  }

  const lancamento = {
    id: crypto.randomUUID(),
    descricao,
    fluxo: fluxo(body.fluxo).toLowerCase(),
    categoria_nome: texto(body.categoria_nome ?? body.categoria ?? 'SEM CATEGORIA'),
    grupo_categoria: texto(body.grupo_categoria),
    valor_total: valor,
    valor_rateado: Number(body.valor_rateado ?? valor),
    data_emissao: texto(body.data_emissao ?? body.data ?? new Date().toISOString().slice(0, 10)),
    data_vencimento: body.data_vencimento ?? body.vencimento ?? null,
    aeronave_id: body.aeronave_id ?? null,
    cotista_id: body.cotista_id ?? null,
    colaborador_id: body.colaborador_id ?? null,
    reembolsavel: body.reembolsavel ? 1 : 0,
    reembolso_quitado: body.reembolso_quitado ? 1 : 0,
    status: texto(body.status || 'pendente').toLowerCase(),
    fornecedor_nome: body.fornecedor_nome ?? body.fornecedor ?? null,
    numero_doc: body.numero_doc ?? body.documento ?? null,
    observacoes: body.observacoes ?? null,
    criado_por: criadoPor ?? body.criado_por ?? null,
    pago_diretamente: body.pago_diretamente ? 1 : 0,
    tipo_caixa: texto(body.tipo_caixa ?? body.caixa ?? 'share').toLowerCase(),
    pago_por: body.pago_por ?? null,
    reference_type: body.reference_type ?? null,
    reference_id: body.reference_id ?? null,
  }
  return lancamento
}

export async function prepararFinanceiro(_db: Database): Promise<FinanceiroService> {
  return new FinanceiroService(_db)
}

export class FinanceiroService {
  constructor(private readonly db: Database) {}

  async registrarLancamento(input: Row): Promise<{ lancamento: LancamentoFinanceiro }> {
    const schema = await this.db.prepare("SELECT name FROM pragma_table_info('lancamentos')").all<{ name: string }>()
    const existentes = new Set((schema.results || []).map((column) => String(column.name)))
    const dados = { ...input }
    if (!existentes.has('data_emissao') && existentes.has('data_emissao_nf') && dados.data_emissao !== undefined) {
      dados.data_emissao_nf = dados.data_emissao
      delete dados.data_emissao
    }
    if (!existentes.has('tipo_caixa') && existentes.has('caixa') && dados.tipo_caixa !== undefined) {
      dados.caixa = dados.tipo_caixa
      delete dados.tipo_caixa
    }
    const columns = Object.keys(dados).filter((column) => column !== 'id' && existentes.has(column))
    if (!existentes.has('id') || columns.length === 0) throw new Error('schema_lancamentos_incompativel')
    await this.db.prepare(
      `INSERT INTO lancamentos (id, ${columns.join(', ')}) VALUES (?1, ${columns.map((_, index) => `?${index + 2}`).join(', ')})`,
    ).bind(dados.id, ...columns.map((column) => dados[column])).run()
    const row = await this.db.prepare('SELECT * FROM lancamentos WHERE id = ?1').bind(input.id).first<Row>()
    if (!row) throw new Error('lancamento_nao_criado')
    return { lancamento: normalizarLancamento(row) }
  }

  async listarLancamentos(inicio?: string, fim?: string, caixa?: string): Promise<LancamentoFinanceiro[]> {
    const schema = await this.db.prepare("SELECT name FROM pragma_table_info('lancamentos')").all<{ name: string }>()
    const existentes = new Set((schema.results || []).map((column) => String(column.name)))
    const dataLancamento = existentes.has('data_emissao')
      ? 'data_emissao'
      : existentes.has('data_emissao_nf')
        ? 'data_emissao_nf'
        : 'criado_em'
    const caixaLancamento = existentes.has('tipo_caixa')
      ? 'tipo_caixa'
      : existentes.has('caixa')
        ? 'caixa'
        : null
    const conditions: string[] = []
    const values: unknown[] = []
    if (inicio) { conditions.push(`date(${dataLancamento}) >= ?`); values.push(inicio) }
    if (fim) { conditions.push(`date(${dataLancamento}) <= ?`); values.push(fim) }
    if (caixa && caixaLancamento) { conditions.push(`upper(COALESCE(${caixaLancamento}, 'SHARE')) = upper(?)`); values.push(caixa) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.db.prepare(`SELECT * FROM lancamentos ${where} ORDER BY date(${dataLancamento}) DESC, criado_em DESC`).bind(...values).all<Row>()
    const result: LancamentoFinanceiro[] = []
    for (const row of rows.results) {
      const rateios = await this.db.prepare('SELECT * FROM rateio_despesas WHERE lancamentos_id = ?1').bind(row.id).all<Row>().catch(() => ({ results: [] as Row[] }))
      result.push(normalizarLancamento(row, rateios.results.map(normalizarRateio)))
    }
    return result
  }

  async obterConsolidadoBalanco(inicio?: string, fim?: string): Promise<BalancoFinanceiro> {
    const lancamentos = await this.listarLancamentos(inicio, fim)
    const saldos = [{ caixa: 'SHARE', saldoCentavos: lancamentos.filter((item) => item.caixa === 'SHARE').reduce((total, item) => total + (item.fluxo === 'ENTRADA' ? item.valorCentavos : -item.valorCentavos), 0) }]
    return { lancamentos, saldos, matrizCompensacao: {}, holdings: [] }
  }
}
