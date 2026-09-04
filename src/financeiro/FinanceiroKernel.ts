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

async function columns(db: Database, table: string) {
  const result = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()
  return new Set((result.results || []).map(row => String(row.name)))
}

async function addColumn(db: Database, table: string, column: string, definition: string) {
  const existing = await columns(db, table).catch(() => new Set<string>())
  if (!existing.has(column)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run().catch(() => undefined)
}

export async function ensureFinanceKernel(db: Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS colaboradores (
    id TEXT PRIMARY KEY NOT NULL,
    user_profile_id TEXT UNIQUE,
    nome TEXT NOT NULL,
    cpf TEXT,
    pix TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS auditoria_financeira (
    id TEXT PRIMARY KEY NOT NULL,
    entidade TEXT NOT NULL,
    entidade_id TEXT NOT NULL,
    operacao TEXT NOT NULL,
    valor_anterior_centavos INTEGER,
    valor_novo_centavos INTEGER,
    usuario_id TEXT,
    motivo TEXT,
    idempotency_key TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS financeiro_fila (
    id TEXT PRIMARY KEY NOT NULL,
    operacao TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDENTE',
    tentativas INTEGER NOT NULL DEFAULT 0,
    erro TEXT,
    processado_em TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await addColumn(db, 'lancamentos', 'valor_centavos', 'INTEGER')
  await addColumn(db, 'lancamentos', 'competencia', 'TEXT')
  await addColumn(db, 'lancamentos', 'origem_tipo', 'TEXT')
  await addColumn(db, 'lancamentos', 'origem_id', 'TEXT')
  await addColumn(db, 'lancamentos', 'colaborador_ref_id', 'TEXT')
  await addColumn(db, 'lancamentos', 'idempotency_key', 'TEXT')
  await addColumn(db, 'contas_apagar', 'valor_centavos', 'INTEGER')
  await addColumn(db, 'contas_apagar', 'origem_tipo', 'TEXT')
  await addColumn(db, 'contas_apagar', 'origem_id', 'TEXT')
  await addColumn(db, 'contas_apagar', 'idempotency_key', 'TEXT')
  await addColumn(db, 'contas_areceber', 'valor_centavos', 'INTEGER')
  await addColumn(db, 'contas_areceber', 'origem_tipo', 'TEXT')
  await addColumn(db, 'contas_areceber', 'origem_id', 'TEXT')
  await addColumn(db, 'contas_areceber', 'idempotency_key', 'TEXT')
  await db.prepare(`CREATE TABLE IF NOT EXISTS contas_apagar (id TEXT PRIMARY KEY NOT NULL, data_vencimento TEXT NOT NULL, valor REAL NOT NULL DEFAULT 0, valor_centavos INTEGER, descricao TEXT, criado_por TEXT, colaborador_id TEXT, lancamento_id TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS contas_areceber (id TEXT PRIMARY KEY NOT NULL, data_vencimento TEXT NOT NULL, valor REAL NOT NULL DEFAULT 0, valor_centavos INTEGER, descricao TEXT, criado_por TEXT, cotista_id TEXT, lancamento_id TEXT, lancamentos_id TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS reembolsos (
    id TEXT PRIMARY KEY NOT NULL,
    lancamento_origem_id TEXT NOT NULL,
    conta_receber_id TEXT,
    colaborador_id TEXT,
    cotista_id TEXT,
    valor_centavos INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDENTE',
    recebido_em TEXT,
    idempotency_key TEXT UNIQUE,
    criado_por TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run()
  await db.prepare(`UPDATE lancamentos SET valor_centavos = CAST(ROUND(COALESCE(valor_centavos, valor_total, valor, 0) * CASE WHEN valor_centavos IS NULL THEN 100 ELSE 1 END) AS INTEGER) WHERE valor_centavos IS NULL`).run().catch(() => undefined)
  await db.prepare(`UPDATE contas_apagar SET valor_centavos = CAST(ROUND(COALESCE(valor_centavos, valor, 0) * CASE WHEN valor_centavos IS NULL THEN 100 ELSE 1 END) AS INTEGER) WHERE valor_centavos IS NULL`).run().catch(() => undefined)
  await db.prepare(`UPDATE contas_areceber SET valor_centavos = CAST(ROUND(COALESCE(valor_centavos, valor, 0) * CASE WHEN valor_centavos IS NULL THEN 100 ELSE 1 END) AS INTEGER) WHERE valor_centavos IS NULL`).run().catch(() => undefined)
}

async function audit(db: Database, entity: string, entityId: string, operation: string, userId: string | null, oldValue: number | null, newValue: number | null, reason: string | null, key: string | null) {
  await db.prepare(`INSERT INTO auditoria_financeira (id, entidade, entidade_id, operacao, valor_anterior_centavos, valor_novo_centavos, usuario_id, motivo, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), entity, entityId, operation, oldValue, newValue, userId, reason, key).run()
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

async function insertDynamic(db: Database, table: string, input: Row) {
  const available = await columns(db, table)
  const entries = Object.entries(input).filter(([key, value]) => available.has(key) && value !== undefined)
  if (!entries.length) throw new FinanceKernelError(`Schema incompatível: ${table}`, 'schema_incompativel', 500)
  const names = entries.map(([key]) => key)
  await db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).bind(...entries.map(([, value]) => value)).run()
}

export async function createExpense(db: Database, body: Row, userId: string | null) {
  await ensureFinanceKernel(db)
  const key = idempotency(body)
  if (key) { const old = await db.prepare('SELECT id FROM lancamentos WHERE idempotency_key = ?').bind(key).first<Row>(); if (old) return { id: old.id, idempotent: true } }
  const id = uuid(), amount = moneyCents(body), direct = Boolean(body.pagoDiretamente ?? body.pago_diretamente), collaboratorId = await collaborator(db, body)
  const status = direct || Boolean(body.pago ?? body.data_pagamento) ? 'PAGO' : 'PENDENTE'
  await insertDynamic(db, 'lancamentos', { id, descricao: text(body.descricao), fluxo: 'saida', categoria_nome: text(body.categoria_nome ?? body.categoria ?? 'SEM CATEGORIA'), categoria: text(body.categoria_nome ?? body.categoria ?? 'SEM CATEGORIA'), grupo_categoria: text(body.grupo_categoria ?? 'DESPESA'), valor_centavos: amount, valor_total: amount / 100, data_emissao: text(body.data_emissao ?? body.data ?? new Date().toISOString().slice(0, 10)), data: text(body.data ?? body.data_emissao ?? new Date().toISOString().slice(0, 10)), data_vencimento: body.data_vencimento ?? body.vencimento ?? null, prazo: body.prazo ?? body.vencimento ?? null, aeronave_id: body.aeronave_id ?? null, cotista_id: body.cotista_id ?? null, colaborador_ref_id: collaboratorId, idempotency_key: key, origem_tipo: text(body.origem_tipo ?? 'DESPESA'), origem_id: text(body.origem_id) || null, status, criado_por: userId, observacoes: body.observacoes ?? null })
  let contaId: string | null = null
  if (!direct) { contaId = uuid(); await insertDynamic(db, 'contas_apagar', { id: contaId, data_vencimento: body.data_vencimento ?? body.vencimento ?? text(body.data ?? new Date().toISOString().slice(0, 10)), valor_centavos: amount, valor: amount / 100, descricao: text(body.descricao), categoria_id: body.categoria_id ?? null, categoria_nome: text(body.categoria_nome ?? body.categoria), criado_por: userId, aeronave_id: body.aeronave_id ?? null, fornecedor_id: body.fornecedor_id ?? null, cotista_id: body.cotista_id ?? null, colaborador_id: collaboratorId, lancamento_id: id, origem_tipo: 'DESPESA', origem_id: id, idempotency_key: key, status: status === 'PAGO' ? 'PAGO' : 'PENDENTE' }) }
  await audit(db, 'lancamento', id, 'CRIACAO_DESPESA', userId, null, amount, text(body.motivo) || null, key)
  return { id, contaPagarId: contaId, valorCentavos: amount, status, idempotent: false }
}

export async function settlePayable(db: Database, id: string, body: Row, userId: string | null) {
  await ensureFinanceKernel(db); const row = await db.prepare('SELECT * FROM contas_apagar WHERE id = ?').bind(id).first<Row>(); if (!row) throw new FinanceKernelError('Conta a pagar não encontrada', 'nao_encontrado', 404)
  const current = text(row.status).toUpperCase(); if (current === 'PAGO') return { ...row, idempotent: true }; if (current === 'CANCELADO') throw new FinanceKernelError('Conta cancelada não pode ser paga', 'conta_cancelada')
  const date = text(body.dataPagamento ?? body.data_pagamento); if (!date) throw new FinanceKernelError('Data de pagamento obrigatória', 'data_pagamento_obrigatoria')
  const amount = Number(row.valor_centavos ?? Math.round(Number(row.valor || 0) * 100)); const linked = text(row.lancamento_id) || null
  const statements = [db.prepare(`UPDATE contas_apagar SET status='PAGO', valor_centavos=?, data_pagamento=?, banco_pagamento=?, comprovante_pagamento_url=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=? AND UPPER(status) NOT IN ('PAGO','CANCELADO')`).bind(amount, date, body.bancoPagamento ?? body.banco_pagamento ?? null, body.comprovantePagamentoUrl ?? body.comprovante_pagamento_url ?? null, id)]
  if (linked) statements.push(db.prepare(`UPDATE lancamentos SET status='pago', data_pagamento=?, valor_centavos=COALESCE(valor_centavos, ?), atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).bind(date, amount, linked))
  await db.batch(statements); await audit(db, 'conta_apagar', id, 'BAIXA', userId, amount, amount, text(body.motivo) || null, idempotency(body)); return { ...(await db.prepare('SELECT * FROM contas_apagar WHERE id=?').bind(id).first<Row>()), idempotent: false }
}

export async function issueRevenue(db: Database, body: Row, userId: string | null) {
  await ensureFinanceKernel(db); const key = idempotency(body); if (key) { const old = await db.prepare('SELECT id FROM contas_areceber WHERE idempotency_key=?').bind(key).first<Row>(); if (old) return { id: old.lancamento_id ?? old.lancamentos_id, contaReceberId: old.id, idempotent: true } }
  const amount = moneyCents(body), id = uuid(), accountId = uuid(); await insertDynamic(db, 'lancamentos', { id, descricao: text(body.descricao), fluxo: 'entrada', categoria_nome: text(body.categoria_nome ?? 'RECEITA'), categoria: text(body.categoria_nome ?? 'RECEITA'), grupo_categoria: 'RECEITA', valor_centavos: amount, valor_total: amount / 100, data_emissao: text(body.data_emissao ?? new Date().toISOString().slice(0, 10)), data: text(body.data_emissao ?? new Date().toISOString().slice(0, 10)), data_vencimento: body.data_vencimento ?? body.vencimento ?? null, prazo: body.data_vencimento ?? body.vencimento ?? null, cotista_id: body.cotista_id ?? null, origem_tipo: text(body.origem_tipo ?? 'RECEITA'), origem_id: text(body.origem_id) || null, idempotency_key: key, status: 'PENDENTE', criado_por: userId, observacoes: body.observacoes ?? null })
  await insertDynamic(db, 'contas_areceber', { id: accountId, data_vencimento: body.data_vencimento ?? body.vencimento ?? text(body.data_emissao ?? new Date().toISOString().slice(0, 10)), valor_centavos: amount, valor: amount / 100, descricao: text(body.descricao), categoria_id: body.categoria_id ?? null, categoria_nome: text(body.categoria_nome ?? 'RECEITA'), criado_por: userId, cotista_id: body.cotista_id ?? null, lancamento_id: id, lancamentos_id: id, origem_tipo: text(body.origem_tipo ?? 'RECEITA'), origem_id: text(body.origem_id) || id, idempotency_key: key, status: 'PENDENTE' }); await audit(db, 'lancamento', id, 'EMISSAO_RECEITA', userId, null, amount, text(body.motivo) || null, key); return { id, contaReceberId: accountId, valorCentavos: amount, status: 'PENDENTE', idempotent: false }
}

export async function settleReceivable(db: Database, id: string, body: Row, userId: string | null) {
  await ensureFinanceKernel(db); const row = await db.prepare('SELECT * FROM contas_areceber WHERE id=?').bind(id).first<Row>(); if (!row) throw new FinanceKernelError('Conta a receber não encontrada', 'nao_encontrado', 404); const current = text(row.status).toUpperCase(); if (current === 'RECEBIDO') return { ...row, idempotent: true }; if (current === 'CANCELADO') throw new FinanceKernelError('Conta cancelada não pode ser recebida', 'conta_cancelada'); const date = text(body.dataRecebimento ?? body.data_recebimento); if (!date) throw new FinanceKernelError('Data de recebimento obrigatória', 'data_recebimento_obrigatoria'); const linked = text(row.lancamentos_id ?? row.lancamento_id) || null; const amount = Number(row.valor_centavos ?? Math.round(Number(row.valor || 0) * 100)); const statements = [db.prepare(`UPDATE contas_areceber SET status='RECEBIDO', valor_centavos=?, data_recebimento=?, data_pagamento=?, banco_recebimento=?, comprovante_recebimento_url=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=? AND UPPER(status) NOT IN ('RECEBIDO','CANCELADO')`).bind(amount, date, date, body.bancoRecebimento ?? body.banco_recebimento ?? null, body.comprovanteRecebimentoUrl ?? body.comprovante_recebimento_url ?? null, id)]; if (linked) statements.push(db.prepare(`UPDATE lancamentos SET status='recebido', data_pagamento=?, valor_centavos=COALESCE(valor_centavos, ?), atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).bind(date, amount, linked)); await db.batch(statements); await audit(db, 'conta_areceber', id, 'BAIXA', userId, amount, amount, text(body.motivo) || null, idempotency(body)); return { ...(await db.prepare('SELECT * FROM contas_areceber WHERE id=?').bind(id).first<Row>()), idempotent: false }
}

export async function createReimbursement(db: Database, body: Row, userId: string | null) {
  await ensureFinanceKernel(db); const key = idempotency(body); if (key) { const old = await db.prepare('SELECT * FROM reembolsos WHERE idempotency_key=?').bind(key).first<Row>(); if (old) return { ...old, idempotent: true } } const amount = moneyCents(body), id = uuid(); const original = text(body.lancamentoOrigemId ?? body.lancamento_origem_id ?? body.lancamento_id); if (!original) throw new FinanceKernelError('Lançamento de origem obrigatório', 'lancamento_origem_obrigatorio'); await insertDynamic(db, 'reembolsos', { id, lancamento_origem_id: original, colaborador_id: body.colaborador_id ?? null, cotista_id: body.cotista_id ?? null, valor_centavos: amount, idempotency_key: key, criado_por: userId, status: 'PENDENTE' }); const receivable = await issueRevenue(db, { ...body, valorCentavos: amount, origem_tipo: 'REEMBOLSO', origem_id: id, idempotencyKey: `${key || id}:receita` }, userId); await db.prepare('UPDATE reembolsos SET conta_receber_id=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?').bind(receivable.contaReceberId, id).run(); return { id, contaReceberId: receivable.contaReceberId, valorCentavos: amount, status: 'PENDENTE', idempotent: false }
}

export async function enqueueFinance(db: Database, operation: FinanceOperation, payload: Row) { await ensureFinanceKernel(db); const id = uuid(); await db.prepare('INSERT INTO financeiro_fila (id, operacao, payload_json) VALUES (?, ?, ?)').bind(id, operation, JSON.stringify(payload)).run(); return { id, status: 'PENDENTE' } }

export async function processFinanceQueue(db: Database, userId: string | null, limit = 20) { await ensureFinanceKernel(db); const rows = await db.prepare("SELECT * FROM financeiro_fila WHERE status='PENDENTE' ORDER BY criado_em LIMIT ?").bind(limit).all<Row>(); const result = []; for (const row of rows.results || []) { try { const payload = JSON.parse(String(row.payload_json)); let output: any; if (row.operacao === 'DESPESA') output = await createExpense(db, payload, userId); else if (row.operacao === 'RECEITA') output = await issueRevenue(db, payload, userId); else output = await createReimbursement(db, payload, userId); await db.prepare("UPDATE financeiro_fila SET status='PROCESSADO', processado_em=CURRENT_TIMESTAMP, tentativas=tentativas+1 WHERE id=? AND status='PENDENTE'").bind(row.id).run(); result.push({ id: row.id, status: 'PROCESSADO', output }); } catch (error) { await db.prepare("UPDATE financeiro_fila SET status='ERRO', erro=?, tentativas=tentativas+1 WHERE id=? AND status='PENDENTE'").bind(text(error instanceof Error ? error.message : error), row.id).run(); result.push({ id: row.id, status: 'ERRO' }); } } return result }
