import { uuid } from '../lib/strings'

type ContaAReceberValues = Record<string, unknown>

type ExistingContaAReceber = {
  id: string
  status: string | null
  valor_centavos: number | null
  data_recebimento?: string | null
  data_pagamento?: string | null
  comprovante_recebimento_url?: string | null
  valor_pago_real_centavos?: number | null
  valor_recebido_centavos?: number | null
}

type EnsureRelatorioContaAReceberResult =
  | { status: 'created' | 'existing'; id: string; statement: D1PreparedStatement }
  | { status: 'reconciliation_required'; ids: string[] }
  | { status: 'cancelled'; ids: string[] }

export type EnsureRelatorioContaAReceberInput = {
  reportId: string
  cotistaId: string
  values: ContaAReceberValues
  /** Only set when the customer/holding is being formally communicated. */
  communicated?: boolean
}

/**
 * Ensures a single receivable for a travel report and its debtor.
 * Existing payment state is never reset. Multiple active matches are returned
 * for manual reconciliation rather than selecting an arbitrary account.
 */
export async function ensureRelatorioContaAReceber(
  db: D1Database,
  input: EnsureRelatorioContaAReceberInput,
): Promise<EnsureRelatorioContaAReceberResult> {
  const { reportId, cotistaId, values } = input
  if (!reportId || !cotistaId) throw new Error('relatorio_e_devedor_obrigatorios_para_conta_receber')

  const canonicalKey = `RELATORIO_DESPESA_VIAGEM:${reportId}:CONTA_RECEBER`
  const legacyRouteKey = `RELATORIO_DESPESA_VIAGEM:${reportId}:REEMBOLSO_CLIENTE:CONTA_RECEBER`
  const recognizedKeys = [canonicalKey, legacyRouteKey]
  const placeholders = recognizedKeys.map((_, index) => `?${index + 1}`).join(', ')
  const debtorIndex = recognizedKeys.length + 1
  const reportIndex = debtorIndex + 1
  const matches = await db.prepare(`SELECT * FROM contas_areceber
    WHERE cotista_id = ?${debtorIndex}
      AND ((origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?${reportIndex})
        OR idempotency_key IN (${placeholders}))`)
    .bind(...recognizedKeys, cotistaId, reportId)
    .all<ExistingContaAReceber>()

  const rows = matches.results || []
  const active = rows.filter((row) => String(row.status || '').toUpperCase() !== 'CANCELADO')
  if (active.length > 1) {
    return { status: 'reconciliation_required', ids: active.map((row) => String(row.id)) }
  }
  if (active.length === 0 && rows.length > 0) {
    return { status: 'cancelled', ids: rows.map((row) => String(row.id)) }
  }

  const columnsResult = await db.prepare("SELECT name FROM pragma_table_info('contas_areceber')").all<{ name: string }>()
  const columns = new Set((columnsResult.results || []).map((item) => String(item.name)))
  if (!columns.size) throw new Error('tabela_financeira_ausente:contas_areceber')

  if (active.length === 1) {
    const row = active[0]
    const status = String(row.status || '').toUpperCase()
    const hasPaymentStatus = ['RECEBIDO', 'PAGO'].includes(status)
    const hasPaymentMetadata = Boolean(row.data_recebimento || row.data_pagamento || row.comprovante_recebimento_url
      || Number(row.valor_pago_real_centavos || 0) > 0 || Number(row.valor_recebido_centavos || 0) > 0)
    let hasPaymentRows = false
    const paymentTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rateio_pagamentos' LIMIT 1").first<{ name: string }>()
    if (paymentTable?.name) {
      const payment = await db.prepare(`SELECT 1 AS encontrado FROM rateio_pagamentos
        WHERE conta_receber_id = ?1 AND UPPER(COALESCE(status, '')) = 'CONFIRMADO' LIMIT 1`).bind(row.id).first<{ encontrado: number }>()
      hasPaymentRows = Boolean(payment)
    }
    const hasPayments = hasPaymentStatus || hasPaymentMetadata || hasPaymentRows
    const updates: Record<string, unknown> = {
      origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
      origem_id: reportId,
      idempotency_key: canonicalKey,
    }

    if (input.communicated) {
      for (const column of ['data_vencimento', 'lancamentos_id', 'movimentos_id']) {
        if (columns.has(column) && Object.prototype.hasOwnProperty.call(values, column)) updates[column] = values[column]
      }
    }
    if (!hasPayments) {
      for (const column of ['valor_centavos', 'categoria_id', 'categoria_nome', 'descricao', 'aeronave_id', 'criado_por']) {
        if (columns.has(column) && Object.prototype.hasOwnProperty.call(values, column)) updates[column] = values[column]
      }
    }

    const entries = Object.entries(updates).filter(([column]) => columns.has(column))
    const statement = db.prepare(`UPDATE contas_areceber SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .bind(...entries.map(([, value]) => value ?? null), row.id)
    return { status: 'existing', id: String(row.id), statement }
  }

  const id = String(values.id || uuid())
  const row = {
    ...values,
    id,
    cotista_id: cotistaId,
    origem_tipo: 'RELATORIO_DESPESA_VIAGEM',
    origem_id: reportId,
    idempotency_key: canonicalKey,
  }
  const entries = Object.entries(row).filter(([column, value]) => columns.has(column) && value !== undefined)
  if (!entries.length) throw new Error('tabela_financeira_sem_colunas:contas_areceber')
  // A cláusula sem alvo específico continua válida antes da migração; após o
  // índice parcial, ela suprime atomicamente a inserção concorrente duplicada.
  const statement = db.prepare(`INSERT INTO contas_areceber (${entries.map(([column]) => column).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})
    ON CONFLICT DO NOTHING`)
    .bind(...entries.map(([, value]) => value ?? null))
  return { status: 'created', id, statement }
}

export function repairRelatorioContaReceberLinkStatements(
  db: D1Database,
  reportId: string,
  cotistaId: string,
): D1PreparedStatement[] {
  const canonicalKey = `RELATORIO_DESPESA_VIAGEM:${reportId}:CONTA_RECEBER`
  const legacyKey = `RELATORIO_DESPESA_VIAGEM:${reportId}:REEMBOLSO_CLIENTE:CONTA_RECEBER`
  return [
    db.prepare(`DELETE FROM financeiro_vinculos
      WHERE origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND origem_id = ?
        AND destino_tipo = 'CONTA_RECEBER'
        AND (
          destino_id IN (SELECT cr.id FROM contas_areceber cr
            WHERE cr.cotista_id = ? AND (
              (cr.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND cr.origem_id = ?)
              OR cr.idempotency_key IN (?, ?)
            ))
          OR NOT EXISTS (SELECT 1 FROM contas_areceber cr WHERE cr.id = financeiro_vinculos.destino_id)
        )`).bind(reportId, cotistaId, reportId, canonicalKey, legacyKey),
    db.prepare(`INSERT OR IGNORE INTO financeiro_vinculos
      (id, origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
      SELECT lower(hex(randomblob(16))), 'RELATORIO_DESPESA_VIAGEM', ?, 'CONTA_RECEBER', cr.id, 'RELATORIO_CONTA_RECEBER'
      FROM contas_areceber cr
      WHERE cr.origem_tipo = 'RELATORIO_DESPESA_VIAGEM' AND cr.origem_id = ? AND cr.cotista_id = ?
        AND UPPER(COALESCE(cr.status, '')) <> 'CANCELADO'
      LIMIT 1`).bind(reportId, reportId, cotistaId),
  ]
}
