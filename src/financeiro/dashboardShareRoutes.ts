import { Hono } from 'hono'
import { errorResponse } from './errorResponse'
import { dashboardCotistaRoutes } from './dashboardCotistaRoutes'
import { listar } from './repositories/d1'
import { enriquecerFornecedores } from './repositories/contas'
import { loadSchema, holdingMovementColumn } from './FinanceiroKernel'
import { selecionarColunaOpcional } from './schemaSql'
import { statusLancamentoFinanceiro } from './statuses'

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }

export const dashboardShareRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function camposDocumentaisRateioHolding(schema: Map<string, Set<string>>, aliasTabela: string, prefixo = '', incluirNumeroDoc = true): string {
  const campos: Array<[string, string[]]> = [
    ['numero_nf', ['numero_nf']],
    ['numero_recibo', ['numero_recibo']],
    ['numero_boleto', ['numero_boleto']],
    ['numero_demonstrativo', ['numero_demonstrativo']],
    ['url_nf', ['url_nf']],
    ['url_recibo', ['url_recibo']],
    ['url_boleto', ['url_boleto']],
    ['url_demonstrativo', ['url_demonstrativo']],
    ['url_doc', ['url_doc', 'documento_url']],
  ]
  if (incluirNumeroDoc) campos.push(['numero_doc', ['numero_doc', 'documento_numero']])
  return campos.map(([campo, alternativas]) => selecionarColunaOpcional(
    schema,
    'rateio_hold',
    aliasTabela,
    alternativas,
    `${prefixo}${campo}`,
  )).join(', ')
}


function periodoFinanceiro(periodo: string | undefined): { inicio?: string; fim?: string } {
  if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) return {}
  const [ano, mes] = periodo.split('-').map(Number)
  return {
    inicio: `${periodo}-01`,
    fim: new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10),
  }
}

function statusFinanceiro(status: unknown, dataVencimento?: unknown): string {
  const statusNormalizado = String(status ?? '').toUpperCase()
  if (['PENDENTE', 'ATRASADO', 'VENCIDO', 'APROVADO', 'EMAIL_ENVIADO'].includes(statusNormalizado)) return 'Pendente'
  if (statusNormalizado === 'EM_ATRASO') return 'Atrasado'
  if (['PAGO_DIRETAMENTE', 'REEMBOLSADO'].includes(statusNormalizado)) return 'Pago'
  const value = statusLancamentoFinanceiro(status, dataVencimento)
  if (value === 'EM_ATRASO') return 'Atrasado'
  if (value === 'EM_ABERTO') return 'Pendente'
  if (value === 'RECEBIDO') return 'Recebido'
  if (value === 'PAGO') return 'Pago'
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
  const saidas = lancamentos.filter(row => ['SAIDA', 'DESPESA'].includes(String(row.fluxo ?? '').toUpperCase()))
  const entradas = lancamentos.filter(row => ['ENTRADA', 'RECEITA'].includes(String(row.fluxo ?? '').toUpperCase()))
  const total = (rows: Record<string, unknown>[]) => rows.reduce((sum, row) => sum + valorReais(row), 0)
  const porMes = new Map<string, { mes: string; entradas: number; saidas: number; saldo: number }>()
  lancamentos.forEach(row => {
    const mes = String(row.data_emissao ?? row.criado_em ?? '').slice(0, 7)
    if (!mes) return
    const atual = porMes.get(mes) ?? { mes, entradas: 0, saidas: 0, saldo: 0 }
    const value = valorReais(row)
    if (['ENTRADA', 'RECEITA'].includes(String(row.fluxo ?? '').toUpperCase())) atual.entradas += value
    else atual.saidas += value
    atual.saldo = atual.entradas - atual.saidas
    porMes.set(mes, atual)
  })
  const payables = pagar.map(row => ({ id: row.id, vencimento: row.data_vencimento, descricao: row.descricao ?? row.lancamento_descricao, fornecedor: row.fornecedor_nome ?? 'Não informado', categoria: row.categoria_nome ?? 'Sem categoria', aeronave: row.aeronave ?? 'Todas', cotistaCliente: row.cotista_aeronave_id ?? 'Share Brasil', valor: valorReais(row), status: statusFinanceiro(row.status, row.data_vencimento), documento: row.numero_nf ?? row.numero_doc ?? '', banco: row.banco_pagamento_nome ?? null }))
  const receivables = receber.map(row => ({ id: row.id, vencimento: row.data_vencimento, descricao: row.descricao_real ?? 'Recebimento', cliente: row.cotista_id ?? 'Cliente não informado', categoria: row.categoria_nome ?? 'Sem categoria', aeronave: row.aeronave ?? 'Todas', valor: valorReais(row), status: statusFinanceiro(row.status, row.data_vencimento), banco: row.banco_recebimento ?? null, nf: row.numero_nf ?? row.numero_doc ?? null }))
  const reimbursements = reembolsos.map(row => {
    const totalCentavos = Number(row.valor_centavos ?? 0)
    const recebidoCentavos = Number(row.valor_recebido_centavos ?? 0)
    return { id: row.id, despesa: row.descricao ?? 'Reembolso', aeronave: row.aeronave ?? 'Todas', clienteCotista: row.cotista_nome ?? row.cotista_id ?? 'Não informado', valorTotal: totalCentavos / 100, valorDevido: totalCentavos / 100, valorRecebido: recebidoCentavos / 100, valorPendente: Math.max(0, totalCentavos - recebidoCentavos) / 100, status: statusFinanceiro(row.status), pagoPor: 'Share Brasil', origem: 'D1 / reembolsos' }
  })
  return c.json({
    live: true,
    kpis: [
      { label: 'A pagar', value: total(pagar).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${pagar.length} títulos`, helper: 'obrigações no D1', tone: 'warning' },
      { label: 'A receber', value: total(receber).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${receber.length} títulos`, helper: 'recebíveis no D1', tone: 'info' },
      { label: 'Reembolsos pendentes', value: total(reembolsos.filter(row => !['RECEBIDO', 'REEMBOLSADO'].includes(String(row.status).toUpperCase()))).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${reembolsos.length} registros`, helper: 'aptos para acompanhamento', tone: 'special' },
      { label: 'Entradas no período', value: total(entradas).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${entradas.length} lançamentos`, helper: 'caixa realizado', tone: 'success' },
      { label: 'Saídas no período', value: total(saidas).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), delta: `${saidas.length} lançamentos`, helper: 'despesas registradas', tone: 'default' },
    ],
    cashFlow: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)),
    categories: categorias.map((row, index) => ({ name: row.nome, value: Number(row.valor ?? 0) / 100, fill: ['var(--chart-cyan)', 'var(--chart-blue)', 'var(--chart-indigo)', 'var(--chart-violet)', 'var(--chart-slate)'][index % 5] })),
    payables, receivables, reimbursements, salaries: [],
  })
}

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

dashboardShareRoutes.get('/dashboard/financeiro', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const schema = await loadSchema(db)
    const holdingColumn = holdingMovementColumn(schema)
    const camposRateioHolding = camposDocumentaisRateioHolding(schema, 'rh', 'rateio_')
    const [receber, pagar, movimentacoes, movimentosHolding, rateiosDespesas, rateiosHold, emailsEnviados] = await Promise.all([
      listar(db, "SELECT ar.valor_centavos, ar.status FROM contas_areceber ar LEFT JOIN lancamentos l ON l.id = ar.lancamentos_id WHERE COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO' AND ar.status <> 'CANCELADO'"),
      listar(db, "SELECT cp.id, cp.lancamentos_id, cp.valor_centavos, cp.status, cp.data_vencimento FROM contas_apagar cp LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id WHERE COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO' AND cp.status <> 'CANCELADO'"),
      listar(db, `SELECT l.*, cl.email_principal AS destinatario_email, COALESCE(NULLIF(cl.codigo_cliente, ''), NULLIF(ca.codigo_cliente, ''), (SELECT NULLIF(ca_cliente.codigo_cliente, '') FROM cotista_aeronave ca_cliente WHERE ca_cliente.aeronave_id = l.aeronave_id AND ca_cliente.cliente_id = l.cliente_id LIMIT 1)) AS codigo_cliente FROM lancamentos l LEFT JOIN cliente cl ON cl.id = l.cliente_id LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id WHERE l.escopo_financeiro = 'FINANCEIRO' ORDER BY l.criado_em DESC LIMIT 100`),
      listar(db, `SELECT mh.*, h.nome AS holding_nome, hs.nome AS socio_nome, (SELECT ca.codigo_cliente FROM cotista_aeronave ca WHERE ca.aeronave_id = mh.aeronave_id AND ca.socio_id = mh.socio_id LIMIT 1) AS codigo_cliente FROM movimentos_holding mh LEFT JOIN holdings h ON h.id = mh.holding_id LEFT JOIN hold_socios hs ON hs.id = mh.socio_id WHERE mh.escopo_financeiro = 'FINANCEIRO' ORDER BY mh.criado_em DESC LIMIT 100`),
      listar(db, `SELECT l.*, e.id AS envio_id, e.tipo_caixa AS envio_tipo_caixa, COALESCE(l.id, e.id) AS origem_id, rd.id AS rateio_id, rd.cotista_id AS rateio_cotista_id, rd.data_emissao AS rateio_data_emissao, rd.data_vencimento AS rateio_data_vencimento, rd.categoria_nome AS rateio_categoria_nome, rd.tipo_rateio AS rateio_tipo_rateio, rd.percentual_sociedade AS rateio_percentual, rd.valor_rateado_centavos AS rateio_valor_centavos, rd.valor_pago_real_centavos AS rateio_valor_pago_centavos, rd.email_enviado_em AS rateio_email_enviado_em, rd.status AS rateio_status, rd.descricao_despesa AS rateio_descricao, rd.documento_numero AS rateio_documento, rd.numero_nf AS rateio_numero_nf, rd.numero_recibo AS rateio_numero_recibo, rd.numero_boleto AS rateio_numero_boleto, rd.numero_demonstrativo AS rateio_numero_demonstrativo, rd.numero_doc AS rateio_numero_doc, rd.url_nf AS rateio_url_nf, rd.url_recibo AS rateio_url_recibo, rd.url_boleto AS rateio_url_boleto, rd.url_demonstrativo AS rateio_url_demonstrativo, rd.url_doc AS rateio_url_doc, ca.codigo_cliente AS rateio_codigo_cliente, cl.razao_social AS rateio_participante_nome FROM rateio_despesas rd LEFT JOIN lancamentos l ON l.id = rd.lancamento_id LEFT JOIN envio_despesas e ON e.id = rd.lancamento_id LEFT JOIN cotista_aeronave ca ON ca.id = rd.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id WHERE COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO' AND UPPER(COALESCE(rd.status, '')) <> 'CANCELADO' ORDER BY rd.criado_em DESC LIMIT 300`),
      listar(db, `SELECT mh.*, e.tipo_caixa AS envio_tipo_caixa, rh.id AS rateio_id, rh.socio_id AS rateio_socio_id, rh.data_emissao AS rateio_data_emissao, rh.data_vencimento AS rateio_data_vencimento, rh.categoria_nome AS rateio_categoria_nome, rh.tipo_rateio AS rateio_tipo_rateio, rh.percentual_uso AS rateio_percentual, rh.valor_rateado_centavos AS rateio_valor_centavos, rh.valor_pago_real_centavos AS rateio_valor_pago_centavos, rh.email_enviado_em AS rateio_email_enviado_em, rh.status AS rateio_status, rh.descricao_despesa AS rateio_descricao, rh.documento_numero AS rateio_documento, ${camposRateioHolding}, hs.nome AS rateio_participante_nome FROM rateio_hold rh JOIN movimentos_holding mh ON mh.id = rh.${holdingColumn} LEFT JOIN envio_despesas e ON e.movimentos_holding_id = mh.id LEFT JOIN hold_socios hs ON hs.id = rh.socio_id WHERE mh.escopo_financeiro = 'FINANCEIRO' AND UPPER(COALESCE(rh.status, '')) <> 'CANCELADO' ORDER BY rh.criado_em DESC LIMIT 300`),
      listar(db, `SELECT e.id, e.destinatarios, e.assunto, e.status, e.anexos, e.erro_mensagem AS erro, e.criado_em, e.email_enviado_em FROM emails_enviados e WHERE (lower(COALESCE(e.referencia_tipo, '')) NOT IN ('nf_saida', 'recibo_saida', 'recibo_colaborador', 'despesa_empresa', 'solicitacao_compra') OR EXISTS (SELECT 1 FROM lancamentos l WHERE l.email_enviado_id = e.id AND l.escopo_financeiro = 'FINANCEIRO')) ORDER BY e.criado_em DESC LIMIT 200`),
    ])
    const contaPendente = (row: Record<string, unknown>) => {
      const status = String(row.status ?? '').toUpperCase()
      return status === 'EM_ATRASO' || statusLancamentoFinanceiro(status, row.data_vencimento) === 'EM_ATRASO' || status === 'EM_ABERTO'
    }
    const totalAReceber = receber.reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const totalPago = pagar.filter((row) => String(row.status).toUpperCase() === 'PAGO').reduce((total, row) => total + Number(row.valor_centavos || 0) / 100, 0)
    const lancamentosComFornecedor: Record<string, unknown>[] = (await enriquecerFornecedores(db, movimentacoes)).map((row): Record<string, unknown> => ({
      ...row,
      status: statusLancamentoFinanceiro(row.status, row.data_vencimento),
    }))
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
      email_enviado_em: row.rateio_email_enviado_em ?? row.email_enviado_em ?? null,
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
      email_enviado_em: row.rateio_email_enviado_em ?? row.email_enviado_em ?? null,
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


dashboardShareRoutes.get('/share', async c => {
  try { return await dashboardShare(c) } catch (error) { return errorResponse(c, error) }
})

dashboardShareRoutes.get('/cotista', async c => {
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
    if (periodo && /^\d{4}-\d{2}$/.test(periodo)) {
      const [ano, mes] = periodo.split('-').map(Number)
      url.searchParams.set('inicio', `${periodo}-01`)
      url.searchParams.set('fim', new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10))
    }
    url.searchParams.delete('aeronave')
    url.searchParams.delete('cotista')
    url.searchParams.delete('periodo')
    return dashboardCotistaRoutes.fetch(new Request(url, c.req.raw), c.env, c.executionCtx)
  } catch (error) { return errorResponse(c, error) }
})
