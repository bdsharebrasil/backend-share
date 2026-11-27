import { Hono } from 'hono'
import {
  createExpense,
  createReimbursement,
  allocateCentsByPercentages,
  enqueueFinance,
  issueRevenue,
  processFinanceQueue,
  settlePayable,
  settleShareExpense,
  settleShareRevenue,
  settleReceivable,
  contextoBaixaCotista,
  pagamentosContextoBaixa,
  settleCotista,
  validateFinanceSchema,
} from './financeiro/FinanceiroKernel'
import { pagamentosFolhaRoutes } from './financeiro/pagamentosFolhaRoutes'
import { configuracoesRoutes } from './financeiro/configuracoesRoutes'
import { errorResponse } from './financeiro/errorResponse'
import { listar } from './financeiro/repositories/d1'
import { contasRoutes } from './financeiro/contasRoutes'
import { mapConta } from './financeiro/contas'
import { documentosRelatorio, colunaAnexosLancamento } from './financeiro/documentosRelatorio'
import { enriquecerFornecedores } from './financeiro/repositories/contas'
import { balancoMensalRoutes } from './financeiro/balancoMensalRoutes'
import { dashboardCotistaRoutes } from './financeiro/dashboardCotistaRoutes'
import { dashboardShareRoutes } from './financeiro/dashboardShareRoutes'
import { notasSaidaRoutes } from './financeiro/notasSaidaRoutes'
import { recibosSaidaRoutes } from './financeiro/recibosSaidaRoutes'
import { movimentosHoldingRoutes } from './financeiro/movimentosHoldingRoutes'
import { demonstrativoIARoutes } from './financeiro/demonstrativoIARoutes'
import { recibosRoutes } from './financeiro/recibosRoutes'
import { enviosPagamentoRoutes } from './financeiro/enviosPagamentoRoutes'
import { STATUS_LANCAMENTO } from './financeiro/statuses'
import { requireCaixaShareAccess } from './financeiro/access'
import { portalClienteRoutes } from './financeiro/portalClienteRoutes'
import { portalBaixasRoutes } from './financeiro/portalBaixasRoutes'

type Bindings = {
  SHARE_DB: D1Database
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
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
financeiroRoutes.route('/', configuracoesRoutes)
financeiroRoutes.route('/', contasRoutes)
financeiroRoutes.route('/', dashboardCotistaRoutes)
financeiroRoutes.route('/', balancoMensalRoutes)
financeiroRoutes.route('/', dashboardShareRoutes)
financeiroRoutes.route('/', notasSaidaRoutes)
financeiroRoutes.route('/', recibosSaidaRoutes)
financeiroRoutes.route('/', movimentosHoldingRoutes)
financeiroRoutes.route('/', demonstrativoIARoutes)
financeiroRoutes.route('/', recibosRoutes)
financeiroRoutes.route('/', enviosPagamentoRoutes)
financeiroRoutes.route('/', portalClienteRoutes)
financeiroRoutes.route('/', portalBaixasRoutes)

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

financeiroRoutes.get('/solicitacoes-compra', async (c) => {
  try {
    const rows = await listar(c.env.SHARE_DB, `SELECT sc.*, e.id AS envio_id, e.status AS envio_status, e.valor, e.vencimento, e.tipo_caixa,
        e.lancamento_id, e.movimentacao_id, e.movimentos_holding_id,
        COALESCE(u.nome_exibicao, u.nome_completo, u.email, sc.solicitante_nome, sc.user_id) AS solicitante_nome
      FROM solicitacoes_compra sc
      LEFT JOIN envio_despesas e ON e.solicitacao_compra_id = sc.id
      LEFT JOIN user_profiles u ON u.id = sc.user_id
      ORDER BY datetime(COALESCE(sc.data_solicitacao, sc.data_criacao)) DESC LIMIT 500`)
    return c.json({ solicitacoes: rows })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.get('/solicitacoes-pagamento', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const anexosLancamento = await colunaAnexosLancamento(db)
    const [envios, reembolsos, holdings] = await Promise.all([
      listar(db, `SELECT l.*,
          'cliente' AS tipo,
          CAST(l.valor_centavos AS REAL) / 100 AS valor,
          l.data_emissao AS data_despesa,
          l.data_vencimento AS vencimento,
          l.id AS lancamento_id,
          cp_pagar.id AS conta_a_pagar_id,
          cp_pagar.status AS conta_a_pagar_status,
          l.fornecedores_favoritos_id AS fornecedor_id,
          COALESCE(NULLIF(TRIM(l.fornecedor_nome), ''), NULLIF(TRIM(ff.apelido), ''), NULLIF(TRIM(ff.nome_completo), ''), NULLIF(TRIM(fc.nome_fornecedor), ''), NULLIF(TRIM(fc.nome_cidade), '')) AS lancamento_fornecedor_nome,
          COALESCE(NULLIF(TRIM(cat_cliente.nome), ''), NULLIF(TRIM(cat_share.nome), ''), NULLIF(TRIM(l.categoria_nome), '')) AS lancamento_categoria_nome,
          a.matricula_registro AS aeronave_matricula,
          COALESCE(NULLIF(TRIM(voo.numero_voo), ''), NULLIF(TRIM(l.numero_voo), '')) AS numero_voo_exibicao,
          COALESCE(NULLIF(TRIM(cl.razao_social), ''), NULLIF(TRIM(hs.nome), ''), NULLIF(TRIM(ca.codigo_cliente), '')) AS cliente_razao_social,
          COALESCE(NULLIF(TRIM(u.nome_exibicao), ''), NULLIF(TRIM(u.nome_completo), ''), NULLIF(TRIM(u.email), '')) AS solicitante_nome
        FROM lancamentos l
        LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id
        LEFT JOIN cliente cl ON cl.id = COALESCE(l.cliente_id, ca.cliente_id)
        LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
        LEFT JOIN aeronave a ON a.id = l.aeronave_id
        LEFT JOIN solicitacoes_reserva_voo voo ON voo.id = l.numero_voo
        LEFT JOIN categoria_movimentacao_cliente cat_cliente ON cat_cliente.id = l.categoria_cliente_id
        LEFT JOIN categoria_movimentacao_share cat_share ON cat_share.id = l.categoria_share_id
        LEFT JOIN fornecedores_favoritos ff ON ff.id = l.fornecedores_favoritos_id
        LEFT JOIN fornecedores_combustivel fc ON fc.id = l.fornecedores_favoritos_id
        LEFT JOIN user_profiles u ON u.id = l.criado_por
        LEFT JOIN contas_apagar cp_pagar ON cp_pagar.id = (
          SELECT cp.id FROM contas_apagar cp
          WHERE cp.lancamentos_id = l.id
            AND NULLIF(TRIM(cp.colaborador_id), '') IS NULL
          ORDER BY CASE WHEN UPPER(COALESCE(cp.status, '')) IN ('PAGO', 'CANCELADO') THEN 1 ELSE 0 END, cp.criado_em DESC
          LIMIT 1
        )
        WHERE UPPER(COALESCE(l.fluxo, '')) = 'SAIDA'
          AND UPPER(COALESCE(l.tipo_caixa, '')) = 'SHARE'
          AND COALESCE(l.reembolsavel, 0) = 1
          AND COALESCE(l.pago_diretamente, 0) = 0
          AND NULLIF(TRIM(l.colaborador_id), '') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM contas_apagar cp_colaborador
            WHERE cp_colaborador.lancamentos_id = l.id
              AND NULLIF(TRIM(cp_colaborador.colaborador_id), '') IS NOT NULL
          )
        ORDER BY date(l.data_emissao) DESC, l.criado_em DESC LIMIT 500`),
      listar(db, `SELECT cp.*, l.fornecedor_nome, l.numero_doc, l.numero_nf, l.numero_recibo, l.numero_demonstrativo,
          l.comprovante_url, a.matricula_registro,
          l.data_emissao AS lancamento_data_emissao, ${anexosLancamento}, l.origem_tipo AS lancamento_origem_tipo, l.origem_id AS lancamento_origem_id, l.url_doc, l.url_demonstrativo, l.url_nf, l.url_recibo, l.url_boleto,
          COALESCE(NULLIF(TRIM(voo.numero_voo), ''), NULLIF(TRIM(l.numero_voo), '')) AS numero_voo,
          l.aeronave_id, a.matricula_registro AS aeronave, l.cotista_aeronave_id, l.descricao AS lancamento_descricao,
          COALESCE(NULLIF(TRIM(cat.nome), ''), NULLIF(TRIM(l.categoria_nome), ''), NULLIF(TRIM(cp.categoria_nome), '')) AS lancamento_categoria_nome,
          COALESCE(NULLIF(TRIM(cl.razao_social), ''), NULLIF(TRIM(hs.nome), ''), NULLIF(TRIM(ca.codigo_cliente), '')) AS cotista_nome,
          mh.holding_id, CASE WHEN cp.movimentos_id IS NOT NULL THEN 'HOLDING' ELSE COALESCE(l.tipo_caixa, 'SHARE') END AS tipo_caixa,
          COALESCE(NULLIF(TRIM(u.nome_exibicao), ''), NULLIF(TRIM(u.nome_completo), ''), NULLIF(TRIM(u.email), '')) AS solicitante_nome
        FROM contas_apagar cp
        LEFT JOIN lancamentos l ON l.id = cp.lancamentos_id
        LEFT JOIN categoria_movimentacao_share cat ON cat.id = l.categoria_share_id
        LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
        LEFT JOIN solicitacoes_reserva_voo voo ON voo.id = l.numero_voo
        LEFT JOIN movimentos_holding mh ON mh.id = cp.movimentos_id
        LEFT JOIN aeronave a ON a.id = cp.aeronave_id
        LEFT JOIN user_profiles u ON u.id = cp.colaborador_id
        WHERE (COALESCE(l.reembolsavel, 0) = 1
          OR UPPER(COALESCE(cp.origem_tipo, '')) = 'RELATORIO_DESPESA_VIAGEM'
          OR UPPER(COALESCE(cp.categoria_nome, '')) LIKE '%REEMBOLS%')
          AND NULLIF(TRIM(cp.colaborador_id), '') IS NOT NULL
          AND UPPER(cp.status) NOT IN ('PAGO', 'CANCELADO')
        ORDER BY date(cp.data_vencimento) ASC LIMIT 500`),
      listar(db, `SELECT mh.id, mh.id AS movimento_holding_id, mh.holding_id, h.nome AS holding_nome,
          mh.socio_id, hs.nome AS socio_nome, mh.aeronave_id, a.matricula_registro AS aeronave_matricula,
          mh.data_emissao, mh.data_vencimento, mh.data_vencimento AS vencimento,
          mh.descricao, mh.categoria_nome, mh.valor_centavos,
          CAST(mh.valor_centavos AS REAL) / 100 AS valor, mh.status, mh.fornecedor_nome,
          mh.fornecedor_id, mh.conta_bancaria_id, mh.pago_diretamente, mh.comprovante_url,
          'HOLDING' AS tipo_caixa, NULL AS lancamento_id, NULL AS conta_a_pagar_id,
          NULL AS conta_a_pagar_status, mh.criado_por, mh.criado_em
        FROM movimentos_holding mh
        LEFT JOIN holdings h ON h.id = mh.holding_id
        LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
        LEFT JOIN aeronave a ON a.id = mh.aeronave_id
        WHERE mh.tipo_caixa = 'HOLD' AND UPPER(mh.fluxo) = 'SAIDA'
          AND UPPER(mh.status) IN ('EM_ABERTO', 'EM_ATRASO', 'AGUARDANDO_REEMBOLSO')
          AND COALESCE(mh.pago_diretamente, 0) = 0
        ORDER BY date(mh.data_vencimento) ASC, mh.criado_em DESC LIMIT 500`),
    ])
    return c.json({ envios: await documentosRelatorio(db, envios), holdings, reembolsos: (await documentosRelatorio(db, reembolsos)).map((row) => ({
      ...mapConta(row),
      lancamentoId: row.lancamentos_id ?? null,
      descricao: row.lancamento_descricao ?? null,
      matricula_registro: row.matricula_registro ?? null,
      aeronave_matricula: row.matricula_registro ?? null,
      comprovante_url: row.comprovante_url ?? null,
      url_doc: row.url_doc ?? null,
      url_demonstrativo: row.url_demonstrativo ?? null,
      url_nf: row.url_nf ?? null,
      url_recibo: row.url_recibo ?? null,
      url_boleto: row.url_boleto ?? null,
    })) })
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
        ? listar(db, `SELECT id, banco, numero_conta, NULL AS tipo_conta, holding_id, tipo_caixa, ativo FROM contas_bancarias ${filtroConta} ORDER BY banco`, ...parametrosConta)
        : listar(db, 'SELECT id, banco, numero_conta, NULL AS tipo_conta, holding_id, tipo_caixa, ativo FROM contas_bancarias WHERE ativo = 1 ORDER BY banco'),
      listar(db, 'SELECT id, razao_social, cnpj FROM empresa ORDER BY razao_social'),
      listar(db, `SELECT id, COALESCE(NULLIF(TRIM(apelido), ''), NULLIF(TRIM(nome_completo), '')) AS nome, cidade, uf, 'fornecedores_favoritos' AS origem FROM fornecedores_favoritos
        UNION ALL SELECT id, NULLIF(TRIM(nome_fornecedor), '') AS nome, nome_cidade AS cidade, NULL AS uf, 'fornecedores_combustivel' AS origem FROM fornecedores_combustivel
        UNION ALL SELECT id, COALESCE(NULLIF(TRIM(razao_social), ''), NULLIF(TRIM(empresa), ''), NULLIF(TRIM(nome_contato_responsavel), '')) AS nome, cidade, uf, 'agenda_contatos_fornecedores' AS origem FROM agenda_contatos_fornecedores
        ORDER BY nome COLLATE NOCASE`),
    ]
    const [categorias, contas, empresas, fornecedores] = await Promise.all(consultas)
    return c.json({ categorias, contas_bancarias: contas, empresas, fornecedores })
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.get('/lancamentos', async (c) => {
  try {
    const inicio = c.req.query('inicio')
    const fim = c.req.query('fim')
    const caixa = c.req.query('caixa')
    const filtros: string[] = []
    const params: unknown[] = []
    if (inicio) { filtros.push('date(COALESCE(l.data_emissao, l.criado_em)) >= date(?)'); params.push(inicio) }
    if (fim) { filtros.push('date(COALESCE(l.data_emissao, l.criado_em)) <= date(?)'); params.push(fim) }
    if (caixa) { filtros.push('l.tipo_caixa = ?'); params.push(caixa.toUpperCase()) }
    const rows = await listar(c.env.SHARE_DB, `SELECT l.*, cb.banco AS banco_pagamento_nome FROM lancamentos l LEFT JOIN contas_bancarias cb ON cb.id = l.conta_bancaria_id${filtros.length ? ` WHERE ${filtros.join(' AND ')}` : ''} ORDER BY date(COALESCE(l.data_emissao, l.criado_em)) DESC, l.criado_em DESC LIMIT 500`, ...params)
    return c.json({ lancamentos: await documentosRelatorio(c.env.SHARE_DB, await enriquecerFornecedores(c.env.SHARE_DB, rows)) })
  } catch (error) { return errorResponse(c, error) }
})


async function origemRateio(db: D1Database, origemTipo: string, origemId: string) {
  if (origemTipo === 'lancamentos') {
    const lancamento = await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(origemId).first<Record<string, unknown>>()
    if (lancamento) return { kind: 'cliente' as const, source: lancamento, movimentoId: null, origemTipo, envioConvertido: false }
    const envio = await db.prepare('SELECT * FROM envio_despesas WHERE id = ? OR lancamento_id = ? LIMIT 1').bind(origemId, origemId).first<Record<string, unknown>>()
    if (!envio) return null
    const source: Record<string, unknown> = {
      ...envio,
      valor_centavos: Math.round(Number(envio.valor_total_despesa ?? envio.valor ?? 0) * 100),
      data_emissao: envio.data_despesa ?? null,
      data_vencimento: envio.vencimento ?? null,
    }
    return { kind: 'cliente' as const, source, movimentoId: null, origemTipo, envioConvertido: String(envio.status ?? '').toUpperCase() === 'CONVERTIDO' }
  }
  if (origemTipo === 'abastecimentos') {
    const abastecimento = await db.prepare(`SELECT a.*, f.nome_fornecedor AS fornecedor_nome
      FROM abastecimentos a LEFT JOIN fornecedores_combustivel f ON f.id = a.fornecedor_id
      WHERE a.id = ?`).bind(origemId).first<Record<string, unknown>>()
    if (!abastecimento) return null
    return { kind: 'cliente' as const, source: { ...abastecimento, valor_centavos: Math.round(Number(abastecimento.valor_total || 0) * 100), descricao: abastecimento.observacao || 'Abastecimento', categoria_nome: 'Combustível', data_emissao: abastecimento.data }, movimentoId: null, origemTipo, envioConvertido: false }
  }
  if (origemTipo === 'movimentos_holding') {
    const movimento = await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(origemId).first<Record<string, unknown>>()
    if (!movimento) return null
    return { kind: 'holding' as const, source: movimento, movimentoId: origemId, origemTipo, envioConvertido: false }
  }
  if (origemTipo === 'rateio_hold') {
    const rateio = await db.prepare('SELECT * FROM rateio_hold WHERE id = ?').bind(origemId).first<Record<string, unknown>>()
    if (!rateio) return null
    const movimentoId = String(rateio.movimento_id ?? rateio.movimentos_id ?? '').trim()
    const movimento = movimentoId ? await db.prepare('SELECT * FROM movimentos_holding WHERE id = ?').bind(movimentoId).first<Record<string, unknown>>() : null
    if (!movimento) return null
    return { kind: 'holding' as const, source: movimento, movimentoId, origemTipo, envioConvertido: false }
  }
  return null
}

financeiroRoutes.get('/dashboard/financeiro/movimentacoes/:origemTipo/:origemId/rateio-opcoes', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const origem = await origemRateio(db, c.req.param('origemTipo'), c.req.param('origemId'))
    if (!origem) return c.json({ error: 'movimentacao_nao_encontrada' }, 404)
    if (origem.envioConvertido) return c.json({ error: 'rateio_ja_existente' }, 409)
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
    if (origem.envioConvertido) return c.json({ error: 'rateio_ja_existente' }, 409)
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
    const categoriaId = origem.source.categoria_share_id ?? origem.source.categoria_id ?? null
    const categoriaNome = origem.source.categoria_nome ?? null
    if (origem.origemTipo === 'abastecimentos') {
      const resultado = await createExpense(db, {
        idempotency_key: `abastecimento-rateio:${c.req.param('origemId')}`,
        abastecimentos_id: c.req.param('origemId'),
        aeronave_id: aeronaveId,
        descricao,
        data: dataEmissao,
        data_emissao: dataEmissao,
        data_vencimento: dataVencimento,
        fornecedor_id: origem.source.fornecedor_id ?? null,
        fornecedor_nome: origem.source.fornecedor_nome ?? null,
        categoria_id: categoriaId,
        categoria_nome: categoriaNome,
        tipo_caixa: 'CLIENTE',
        tipo_rateio: tipoRateio,
        periodicidade,
        reembolsavel: false,
        rateio_linhas: linhas.map((linha) => ({
          cotista_id: String(linha.cotista_id ?? ''),
          percentual: Number(linha.percentual),
          valor_centavos: Math.round(valorTotal * Number(linha.percentual) / 100),
        })),
      }, c.get('userId') || null, { internal: true })
      return c.json({ ok: true, lancamento_id: resultado.lancamento_id ?? resultado.id, rateio_ids: resultado.rateio_ids ?? [] }, 201)
    }
    const rateioIds: string[] = []
    const statements: D1PreparedStatement[] = []
    const valoresRateados = allocateCentsByPercentages(valorTotal, linhas.map((linha) => Number(linha.percentual)))
    for (const [index, linha] of linhas.entries()) {
      const id = crypto.randomUUID(); rateioIds.push(id)
      const percentual = Number(linha.percentual); const rateado = valoresRateados[index]
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
    const consultaAbastecimentosPendentes = `SELECT a.id, a.numero_voo, a.data, a.numero_nf, a.nota_url, a.numero_comanda, a.local, a.trecho, a.litros, a.valor_total, a.status, ar.matricula_registro, f.nome_fornecedor AS fornecedor_nome, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, a.cliente_id, a.socio_id, 'Cotista não informado') AS cotista_nome FROM abastecimentos a LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN fornecedores_combustivel f ON f.id = a.fornecedor_id LEFT JOIN cliente cl ON cl.id = a.cliente_id LEFT JOIN hold_socios hs ON hs.id = a.socio_id LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = a.aeronave_id AND (ca.cliente_id = a.cliente_id OR ca.socio_id = a.socio_id) WHERE lower(trim(COALESCE(a.status, ''))) = 'gerado pré voo' AND (NULLIF(trim(COALESCE(a.numero_nf, '')), '') IS NULL OR NULLIF(trim(COALESCE(a.nota_url, '')), '') IS NULL) ORDER BY date(a.data) ASC, a.id ASC LIMIT 1000`
    if (c.req.query('somente') === 'abastecimentos_pendentes') {
      const abastecimentosPendentes = await listar(db, consultaAbastecimentosPendentes)
      return c.json({ abastecimentos_pendentes: abastecimentosPendentes })
    }
    const [abastecimentos, recibos, reembolsos, relatorios, abastecimentosPendentes] = await Promise.all([
      listar(db, `SELECT a.id, a.numero_voo, a.data, a.numero_nf, a.numero_comanda, a.valor_total, a.status, COALESCE(NULLIF(TRIM(a.observacao), ''), 'Abastecimento') AS descricao, f.nome_fornecedor AS fornecedor_nome, 'abastecimento' AS origem, COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, a.cliente_id, a.socio_id, 'Cotista não informado') AS cotista_nome, 'CLIENTE' AS tipo_caixa FROM abastecimentos a LEFT JOIN fornecedores_combustivel f ON f.id = a.fornecedor_id LEFT JOIN cliente cl ON cl.id = a.cliente_id LEFT JOIN hold_socios hs ON hs.id = a.socio_id LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = a.aeronave_id AND (ca.cliente_id = a.cliente_id OR ca.socio_id = a.socio_id) ORDER BY date(a.data) DESC, a.id DESC LIMIT 1000`),
      listar(db, `SELECT r.id, NULL AS numero_voo, r.data_emissao AS data, COALESCE(r.numero_documento_anexo, r.numero_recibo) AS numero_doc, r.descricao, r.valor, r.status, r.tipo_caixa, 'recibo' AS origem, COALESCE(cl.razao_social, hs.nome, r.nome_pagador, 'Cotista não informado') AS cotista_nome FROM recibos r LEFT JOIN cliente cl ON cl.id = r.pagador_id AND r.pagador_tipo = 'cotista_aeronave' LEFT JOIN hold_socios hs ON hs.id = r.pagador_id AND r.pagador_tipo = 'cotista_aeronave' WHERE EXISTS (SELECT 1 FROM lancamentos l WHERE l.origem_id = r.id AND l.escopo_financeiro = 'FINANCEIRO') ORDER BY date(r.data_emissao) DESC, r.id DESC LIMIT 1000`),
      listar(db, `SELECT r.id, NULL AS numero_voo, r.criado_em AS data, NULL AS numero_doc, 'Reembolso' AS descricao, r.valor_centavos, r.status, 'CLIENTE' AS tipo_caixa, 'reembolso' AS origem, COALESCE(cl.razao_social, hs.nome, r.cotista_id, 'Cotista não informado') AS cotista_nome FROM reembolsos r LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id LEFT JOIN cliente cl ON cl.id = ca.cliente_id LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE EXISTS (SELECT 1 FROM lancamentos l WHERE l.id = r.lancamento_origem_id AND l.escopo_financeiro = 'FINANCEIRO') ORDER BY date(r.criado_em) DESC, r.id DESC LIMIT 1000`),
      listar(db, `SELECT r.id, r.numero_voo, r.data_inicio AS data, r.numero_relatorio AS numero_doc, 'Relatório de despesa de viagem' AS descricao, r.total_valor AS valor, r.status, 'CLIENTE' AS tipo_caixa, 'relatorio_despesa_viagem' AS origem, CASE WHEN r.socio_id IS NOT NULL THEN COALESCE(NULLIF(hs.nome, ''), ca.codigo_cliente) ELSE COALESCE(NULLIF(cl.razao_social, ''), NULLIF(h.nome, ''), NULLIF(hs_holding.nome, ''), ca.codigo_cliente) END AS cotista_nome FROM relatorio_despesa_viagem r LEFT JOIN cliente cl ON cl.id = r.cliente_id LEFT JOIN holdings h ON h.id = r.cliente_id LEFT JOIN cotista_aeronave ca ON ca.aeronave_id = r.aeronave_id AND ((r.socio_id IS NOT NULL AND ca.socio_id = r.socio_id) OR (r.cliente_id IS NOT NULL AND (ca.cliente_id = r.cliente_id OR ca.id = r.cliente_id))) LEFT JOIN hold_socios hs ON hs.id = COALESCE(r.socio_id, ca.socio_id) LEFT JOIN holdings hs_holding ON hs_holding.id = hs.holding_id WHERE EXISTS (SELECT 1 FROM lancamentos l WHERE l.origem_id = r.id AND l.escopo_financeiro = 'FINANCEIRO') ORDER BY date(r.data_inicio) DESC, r.id DESC LIMIT 1000`),
      listar(db, consultaAbastecimentosPendentes),
    ])
    const rows: Record<string, unknown>[] = [
      ...abastecimentos.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor_total || 0), numero_doc: row.numero_nf || row.numero_comanda || null })),
      ...recibos.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor || 0) / 100 })),
      ...reembolsos.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor_centavos || 0) / 100 })),
      ...relatorios.map((row): Record<string, unknown> => ({ ...row, valor: Number(row.valor || 0) })),
    ]
    const pastas = new Map<string, { id: string; nome: string; quantidade: number; voos: Map<string, { id: string; numero_voo: string; periodo: string | null; quantidade: number; despesas: Record<string, unknown>[] }> }>()
    for (const row of rows) {
      // O voo é opcional no controle de abastecimento. Ainda assim, o registro
      // precisa chegar ao financeiro para permitir o envio e o rateio.
      const numeroVooInformado = String(row.numero_voo || '').trim()
      const numeroVoo = numeroVooInformado || 'Sem número de voo'
      const dataMovimentacao = String(row.data || '').slice(0, 10)
      const periodoChave = /^(\d{4})-(\d{2})/.exec(dataMovimentacao)
      const periodo = periodoChave ? `${periodoChave[2]}/${periodoChave[1]}` : 'Período não informado'
      const nome = String(row.cotista_nome || 'Cotista não informado').trim() || 'Cotista não informado'
      const pastaId = nome.toLocaleLowerCase()
      let pasta = pastas.get(pastaId)
      if (!pasta) { pasta = { id: pastaId, nome, quantidade: 0, voos: new Map() }; pastas.set(pastaId, pasta) }
      const vooKey = numeroVooInformado ? `voo:${numeroVooInformado}` : `sem-voo:${periodo}`
      let voo = pasta.voos.get(vooKey)
      if (!voo) {
        voo = { id: `${pastaId}:${vooKey}`, numero_voo: numeroVoo, periodo: numeroVooInformado ? null : periodo, quantidade: 0, despesas: [] }
        pasta.voos.set(vooKey, voo)
      }
      voo.despesas.push({ ...row, email: 'NÃO INFORMADO', valor: Number(row.valor || 0), data: row.data || null }); voo.quantidade += 1; pasta.quantidade += 1
    }
    return c.json({ pastas: [...pastas.values()].map((pasta) => ({ ...pasta, voos: [...pasta.voos.values()] })), abastecimentos_pendentes: abastecimentosPendentes })
  } catch (error) { return errorResponse(c, error) }
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

async function entidadeLancamentoFinanceiro(db: D1Database, id: string) {
  const rateio = await db.prepare('SELECT id, "rateio_despesas" AS origem FROM rateio_despesas WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (rateio) return rateio
  const rateioPai = await db.prepare('SELECT lancamento_id AS id, "rateio_despesas_pai" AS origem FROM rateio_despesas WHERE lancamento_id = ? LIMIT 1').bind(id).first<Record<string, unknown>>()
  if (rateioPai) return rateioPai
  const rateioHold = await db.prepare('SELECT id, "rateio_hold" AS origem FROM rateio_hold WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (rateioHold) return rateioHold
  const lancamento = await db.prepare('SELECT id, "lancamentos" AS origem FROM lancamentos WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (lancamento) return lancamento
  const movimento = await db.prepare('SELECT id, "movimentos_holding" AS origem FROM movimentos_holding WHERE id = ?').bind(id).first<Record<string, unknown>>()
  return movimento
}

async function atualizacoesDescricaoVinculada(
  db: D1Database,
  origem: string,
  id: string,
  descricao: string,
  lancamentoPaiId: string,
): Promise<D1PreparedStatement[]> {
  const atualizacoes: D1PreparedStatement[] = []
  let lancamento: Record<string, unknown> | null = null

  if (origem === 'rateio_despesas') {
    lancamento = await db.prepare('SELECT id, tipo_caixa, origem_tipo, origem_id FROM lancamentos WHERE id = ?')
      .bind(lancamentoPaiId).first<Record<string, unknown>>()
    const envio = await db.prepare('SELECT id FROM envio_despesas WHERE id = ?')
      .bind(lancamentoPaiId).first<{ id: string }>()
    if (lancamento) {
      atualizacoes.push(db.prepare('UPDATE lancamentos SET descricao = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(descricao, lancamentoPaiId))
    }
    if (envio) {
      atualizacoes.push(db.prepare('UPDATE envio_despesas SET descricao = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(descricao, lancamentoPaiId))
    }
  } else if (origem === 'lancamentos') {
    lancamento = await db.prepare('SELECT id, tipo_caixa, origem_tipo, origem_id FROM lancamentos WHERE id = ?')
      .bind(id).first<Record<string, unknown>>()
    atualizacoes.push(
      db.prepare('UPDATE contas_apagar SET descricao = ?, atualizado_em = CURRENT_TIMESTAMP WHERE lancamentos_id = ?').bind(descricao, id),
    )
  }

  const tipoCaixa = String(lancamento?.tipo_caixa ?? '').toUpperCase()
  const tipoOrigem = String(lancamento?.origem_tipo ?? '').toUpperCase()
  const lancamentoShareId = tipoCaixa === 'CLIENTE' && ['NF_SAIDA', 'RECIBO_SAIDA'].includes(tipoOrigem)
    ? String(lancamento?.origem_id ?? '').trim()
    : ''

  if (lancamentoShareId) {
    atualizacoes.push(db.prepare('UPDATE lancamentos SET descricao = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(descricao, lancamentoShareId))
  }

  const idsRecebiveis = [...new Set([origem === 'rateio_despesas' ? lancamentoPaiId : id, lancamentoShareId].filter(Boolean))]
  if (idsRecebiveis.length) {
    atualizacoes.push(db.prepare(`UPDATE contas_areceber SET descricao = ?, atualizado_em = CURRENT_TIMESTAMP WHERE lancamentos_id IN (${idsRecebiveis.map(() => '?').join(', ')})`)
      .bind(descricao, ...idsRecebiveis))
  }

  return atualizacoes
}

financeiroRoutes.patch('/lancamentos/:id', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>()
    const entidade = await entidadeLancamentoFinanceiro(db, id)
    if (!entidade) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    const ehRateioPai = String(entidade.origem) === 'rateio_despesas_pai'
    const origem = ehRateioPai ? 'rateio_despesas' : String(entidade.origem)
    const rateioIndividual = origem === 'rateio_despesas' && !ehRateioPai
      ? await db.prepare('SELECT lancamento_id FROM rateio_despesas WHERE id = ?').bind(id).first<{ lancamento_id: string | null }>()
      : null
    const lancamentoPaiId = ehRateioPai ? id : String(rateioIndividual?.lancamento_id ?? id)
    const atualizarGrupoRateio = origem === 'rateio_despesas' && (ehRateioPai || Boolean(rateioIndividual?.lancamento_id))
    const tabelas: Record<string, { descricao: string; data: string; valor: string }> = {
      rateio_despesas: { descricao: 'descricao_despesa', data: 'data_emissao', valor: 'valor_rateado_centavos' },
      rateio_hold: { descricao: 'descricao_despesa', data: 'data_emissao', valor: 'valor_rateado_centavos' },
      lancamentos: { descricao: 'descricao', data: 'data_emissao', valor: 'valor_centavos' },
      movimentos_holding: { descricao: 'descricao', data: 'data_emissao', valor: 'valor_centavos' },
    }
    const meta = tabelas[origem]
    const campos: Array<[string, unknown]> = []
    if (body.descricao != null) campos.push([meta.descricao, String(body.descricao).trim()])
    if (body.data != null || body.data_emissao != null) campos.push([meta.data, body.data ?? body.data_emissao])
    if (body.data_vencimento !== undefined) campos.push(['data_vencimento', body.data_vencimento || null])
    if (body.periodicidade !== undefined && origem !== 'lancamentos') campos.push(['periodicidade', body.periodicidade || null])
    if (body.observacoes !== undefined) campos.push(['observacoes', body.observacoes || null])
    if (origem === 'lancamentos') {
      const camposLegados = ['data_pagamento', 'status', 'categoria_nome', 'grupo_categoria', 'fornecedor_nome', 'periodicidade', 'numero_doc', 'numero_nf', 'numero_recibo', 'numero_boleto', 'numero_demonstrativo', 'url_doc', 'url_nf', 'url_recibo', 'url_boleto', 'url_demonstrativo', 'comprovante_url', 'forma_pagamento', 'conta_bancaria_id', 'pago_por', 'aeronave_id', 'cotista_aeronave_id']
      for (const campo of camposLegados) if (Object.prototype.hasOwnProperty.call(body, campo)) campos.push([campo, body[campo] ?? null])
      if (body.data_pagamento != null && body.data_pagamento !== '') {
        const dataPagamento = String(body.data_pagamento)
        const dataConvertida = /^\d{4}-\d{2}-\d{2}$/.test(dataPagamento) ? new Date(`${dataPagamento}T00:00:00Z`) : null
        const dataValida = Boolean(dataConvertida && Number.isFinite(dataConvertida.getTime()) && dataConvertida.toISOString().slice(0, 10) === dataPagamento)
        if (!dataValida) return c.json({ error: 'data_pagamento_invalida' }, 400)
      }
      if (Object.prototype.hasOwnProperty.call(body, 'categoria_id') || Object.prototype.hasOwnProperty.call(body, 'categoria_share_id')) {
        campos.push(['categoria_share_id', body.categoria_share_id ?? body.categoria_id ?? null])
      }
      if (Object.prototype.hasOwnProperty.call(body, 'categoria_cliente_id')) campos.push(['categoria_cliente_id', body.categoria_cliente_id || null])
      if (Object.prototype.hasOwnProperty.call(body, 'fornecedor_id') || Object.prototype.hasOwnProperty.call(body, 'fornecedores_favoritos_id')) {
        campos.push(['fornecedores_favoritos_id', body.fornecedores_favoritos_id ?? body.fornecedor_id ?? null])
      }
      if (body.status != null && !STATUS_LANCAMENTO.includes(String(body.status).toUpperCase() as (typeof STATUS_LANCAMENTO)[number])) return c.json({ error: 'status_lancamento_invalido' }, 400)
    }
    if (origem === 'movimentos_holding') {
      for (const campo of ['numero_doc', 'url_doc', 'numero_nf', 'url_nf', 'numero_recibo', 'url_recibo', 'numero_boleto', 'url_boleto', 'numero_demonstrativo', 'url_demonstrativo', 'comprovante_url']) {
        if (Object.prototype.hasOwnProperty.call(body, campo)) campos.push([campo, body[campo] ?? null])
      }
    }
    if (body.valor_centavos != null || body.valorCentavos != null) {
      const valor = Number(body.valor_centavos ?? body.valorCentavos)
      if (!Number.isInteger(valor) || valor <= 0) return c.json({ error: 'valor_centavos_invalido' }, 400)
      campos.push([meta.valor, valor])
    }
    if (!campos.length) return c.json({ error: 'nenhum_campo_para_atualizar' }, 400)
    const colunaId = atualizarGrupoRateio ? 'lancamento_id' : 'id'
    const idAtualizacao = atualizarGrupoRateio ? lancamentoPaiId : id
    const atualizacaoPrincipal = db.prepare(`UPDATE ${origem} SET ${campos.map(([campo]) => `${campo} = ?`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE ${colunaId} = ?`).bind(...campos.map(([, valor]) => valor), idAtualizacao)
    const atualizacoesBaixa: D1PreparedStatement[] = []
    if (origem === 'lancamentos') {
      const baixaEditada = ['data_pagamento', 'conta_bancaria_id', 'comprovante_url'].some((campo) => Object.prototype.hasOwnProperty.call(body, campo))
      if (baixaEditada) {
        const data = Object.prototype.hasOwnProperty.call(body, 'data_pagamento') ? body.data_pagamento ?? null : undefined
        const conta = Object.prototype.hasOwnProperty.call(body, 'conta_bancaria_id') ? body.conta_bancaria_id ?? null : undefined
        const comprovante = Object.prototype.hasOwnProperty.call(body, 'comprovante_url') ? body.comprovante_url ?? null : undefined
        const camposPagar: Array<[string, unknown]> = []
        const camposReceber: Array<[string, unknown]> = []
        if (data !== undefined) { camposPagar.push(['data_pagamento', data]); camposReceber.push(['data_recebimento', data], ['data_pagamento', data]) }
        if (conta !== undefined) { camposPagar.push(['banco_pagamento', conta]); camposReceber.push(['banco_recebimento', conta]) }
        if (comprovante !== undefined) { camposPagar.push(['comprovante_pagamento_url', comprovante]); camposReceber.push(['comprovante_recebimento_url', comprovante]) }
        atualizacoesBaixa.push(
          db.prepare(`UPDATE contas_apagar SET ${camposPagar.map(([campo]) => `${campo} = ?`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE lancamentos_id = ?`).bind(...camposPagar.map(([, valor]) => valor), id),
          db.prepare(`UPDATE contas_areceber SET ${camposReceber.map(([campo]) => `${campo} = ?`).join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE lancamentos_id = ?`).bind(...camposReceber.map(([, valor]) => valor), id),
        )
      }
    }
    if (body.descricao != null) {
      const relacionadas = await atualizacoesDescricaoVinculada(db, origem, id, String(body.descricao).trim(), lancamentoPaiId)
      await db.batch([atualizacaoPrincipal, ...relacionadas, ...atualizacoesBaixa])
    } else if (atualizacoesBaixa.length) {
      await db.batch([atualizacaoPrincipal, ...atualizacoesBaixa])
    } else {
      await atualizacaoPrincipal.run()
    }
    const valorAtualizado = campos.find(([campo]) => campo === 'valor_centavos')?.[1]
    if (origem === 'lancamentos' && valorAtualizado != null) await db.batch([
      db.prepare('UPDATE contas_apagar SET valor_centavos = ? WHERE lancamentos_id = ?').bind(valorAtualizado, id),
      db.prepare('UPDATE contas_areceber SET valor_centavos = ? WHERE lancamentos_id = ?').bind(valorAtualizado, id),
    ])
    if (ehRateioPai) return c.json({ lancamento_id: id, rateios: (await db.prepare('SELECT * FROM rateio_despesas WHERE lancamento_id = ? ORDER BY rowid').bind(id).all()).results ?? [] })
    return c.json(await db.prepare(`SELECT * FROM ${origem} WHERE id = ?`).bind(id).first())
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.delete('/lancamentos/:id', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const entidade = await entidadeLancamentoFinanceiro(db, id)
    if (!entidade) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    const ehRateioPai = String(entidade.origem) === 'rateio_despesas_pai'
    const origem = ehRateioPai ? 'rateio_despesas' : String(entidade.origem)
    if (ehRateioPai) {
      await db.batch([
        db.prepare("UPDATE rateio_despesas SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE lancamento_id = ?").bind(id),
        db.prepare("UPDATE lancamentos SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
      ])
      return c.json({ ok: true, id, status: 'CANCELADO', origem })
    }
    await db.prepare(`UPDATE ${origem} SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run()
    return c.json({ ok: true, id, status: 'CANCELADO', origem })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.get('/lancamentos/:id/contexto-baixa', async (c) => {
  try {
    const contexto = await contextoBaixaCotista(c.env.SHARE_DB, c.req.param('id'))
    if (contexto.natureza === 'RECEBIMENTO_SHARE') { const denied = await requireCaixaShareAccess(c); if (denied) return denied }
    const pagamentos = await pagamentosContextoBaixa(c.env.SHARE_DB, contexto)
    return c.json({ ...contexto, pagamentos })
  }
  catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.post('/lancamentos/:id/baixa-conciliada', async (c) => {
  try {
    const contexto = await contextoBaixaCotista(c.env.SHARE_DB, c.req.param('id'))
    if (contexto.natureza === 'RECEBIMENTO_SHARE') { const denied = await requireCaixaShareAccess(c); if (denied) return denied }
    return c.json(await settleCotista(c.env.SHARE_DB, c.req.param('id'), await c.req.json<Record<string, unknown>>(), c.get('userId') || null))
  }
  catch (error) { return errorResponse(c, error) }
})

// Pagamento da despesa Share, independente do recebimento do reembolso do cliente.
financeiroRoutes.post('/lancamentos/:id/pagamento-share', async (c) => {
  const denied = await requireCaixaShareAccess(c)
  if (denied) return denied
  try {
    return c.json(await settleShareExpense(c.env.SHARE_DB, c.req.param('id'),
      await c.req.json<Record<string, unknown>>(), c.get('userId') || null))
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/lancamentos/:id/recebimento-share', async (c) => {
  const denied = await requireCaixaShareAccess(c)
  if (denied) return denied
  try {
    return c.json(await settleShareRevenue(c.env.SHARE_DB, c.req.param('id'),
      await c.req.json<Record<string, unknown>>(), c.get('userId') || null))
  } catch (error) { return errorResponse(c, error) }
})

financeiroRoutes.post('/lancamentos/:id/baixa', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const id = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const entidade = await entidadeLancamentoFinanceiro(db, id)
    if (!entidade) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    // Client/allocated obligations must use the same ledger as Share receipts.
    const principal = await db.prepare('SELECT tipo_caixa, origem_tipo, reembolsavel, fluxo FROM lancamentos WHERE id = ?').bind(id).first<Record<string, unknown>>()
    if (principal && (principal.reembolsavel === 1 || principal.reembolsavel === '1' || principal.reembolsavel === true)) {
      return c.json({ error: 'lancamento_reembolsavel_nao_pode_ser_baixado' }, 409)
    }
    if (['rateio_despesas', 'rateio_despesas_pai'].includes(String(entidade.origem)) || principal?.tipo_caixa === 'CLIENTE' || ['RECIBO_SAIDA', 'NF_SAIDA'].includes(String(principal?.origem_tipo))) {
      const contexto = await contextoBaixaCotista(db, id)
      if (contexto.natureza === 'RECEBIMENTO_SHARE') { const denied = await requireCaixaShareAccess(c); if (denied) return denied }
      return c.json(await settleCotista(db, id, body, c.get('userId') || null))
    }
    const ehRateioPai = String(entidade.origem) === 'rateio_despesas_pai'
    const origem = ehRateioPai ? 'rateio_despesas' : String(entidade.origem)
    const data = String(body.data_pagamento ?? body.dataPagamento ?? new Date().toISOString().slice(0, 10))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return c.json({ error: 'data_pagamento_invalida' }, 400)
    if (ehRateioPai) {
      const sets = ["status = 'PAGO'", 'data_pagamento = ?', 'valor_pago_real_centavos = valor_rateado_centavos', 'atualizado_em = CURRENT_TIMESTAMP']
      const values: unknown[] = [data]
      if (body.pago_por || body.pagoPor) { sets.push('pago_por = ?'); values.push(body.pago_por ?? body.pagoPor) }
      await db.prepare(`UPDATE rateio_despesas SET ${sets.join(', ')} WHERE lancamento_id = ? AND UPPER(COALESCE(status, '')) <> 'CANCELADO'`).bind(...values, id).run()
      return c.json({ ok: true, id, origem, status: 'PAGO', data_pagamento: data })
    }
    const valor = body.valor_pago_real_centavos ?? body.valorPagoRealCentavos
    const tabela = ['rateio_despesas', 'rateio_hold'].includes(origem) ? origem : origem === 'movimentos_holding' ? origem : 'lancamentos'
    const sets = ['status = ?', 'data_pagamento = ?', 'atualizado_em = CURRENT_TIMESTAMP']
    const values: unknown[] = ['PAGO', data]
    if (['rateio_despesas', 'rateio_hold'].includes(origem)) {
      const pago = valor == null ? undefined : Number(valor)
      if (pago !== undefined && (!Number.isInteger(pago) || pago < 0)) return c.json({ error: 'valor_pago_real_centavos_invalido' }, 400)
      sets.push('valor_pago_real_centavos = ?')
      values.push(pago ?? Number((await db.prepare(`SELECT valor_rateado_centavos FROM ${tabela} WHERE id = ?`).bind(id).first<{ valor_rateado_centavos: number }>())?.valor_rateado_centavos ?? 0))
      if (body.pago_por !== undefined || body.pagoPor !== undefined) { sets.push('pago_por = ?'); values.push(body.pago_por ?? body.pagoPor ?? null) }
    } else if (origem === 'lancamentos') {
      if (String(principal?.tipo_caixa).toUpperCase() === 'SHARE' && ['ENTRADA', 'RECEITA'].includes(String(principal?.fluxo).toUpperCase())) sets.push('pago_diretamente = 1')
      if (body.pago_por !== undefined || body.pagoPor !== undefined) { sets.push('pago_por = ?'); values.push(body.pago_por ?? body.pagoPor ?? null) }
    }
    await db.prepare(`UPDATE ${tabela} SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id).run()
    return c.json({ ok: true, id, origem, status: 'PAGO', data_pagamento: data })
  } catch (error) { return errorResponse(c, error) }
})
financeiroRoutes.post('/lancamentos/:id/duplicar', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const source = await db.prepare('SELECT * FROM lancamentos WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    if (!source) return c.json({ error: 'lancamento_nao_encontrado' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const payload = { descricao: body.descricao ?? source.descricao, data: body.data ?? source.data_emissao, data_emissao: body.data_emissao ?? body.data ?? source.data_emissao, data_vencimento: body.data_vencimento ?? source.data_vencimento, valor_centavos: body.valor_centavos ?? source.valor_centavos, categoria_id: source.categoria_share_id, categoria_nome: source.categoria_nome, grupo_categoria: source.grupo_categoria, fornecedor_nome: source.fornecedor_nome, aeronave_id: source.aeronave_id, cotista_aeronave_id: source.cotista_aeronave_id, tipo_caixa: source.tipo_caixa, reembolsavel: source.reembolsavel, idempotency_key: `duplicado:${source.id}:${crypto.randomUUID()}` }
    const result = String(source.fluxo).toUpperCase() === 'ENTRADA' ? await issueRevenue(db, payload, c.get('userId') || null) : await createExpense(db, payload, c.get('userId') || null)
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

financeiroRoutes.post('/contas-apagar/:id/comprovante-upload', async (c) => {
  const denied = await requireCaixaShareAccess(c)
  if (denied) return denied
  const id = c.req.param('id')
  const conta = await c.env.SHARE_DB.prepare(
    'SELECT id, colaborador_id, lancamentos_id, status FROM contas_apagar WHERE id = ?',
  ).bind(id).first<{ id: string; colaborador_id: string | null; lancamentos_id: string | null; status: string }>()
  if (!conta) return c.json({ error: 'conta_a_pagar_nao_encontrada' }, 404)
  if (['PAGO', 'CANCELADO'].includes(String(conta.status).toUpperCase())) return c.json({ error: 'comprovante_nao_pode_ser_alterado' }, 409)
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'armazenamento_de_anexos_indisponivel' }, 503)
  const form = await c.req.formData()
  const valorArquivo = form.get('arquivo') as unknown
  if (!valorArquivo || typeof valorArquivo !== 'object' || !('arrayBuffer' in valorArquivo) || !('type' in valorArquivo) || !('size' in valorArquivo)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const arquivo = valorArquivo as File
  const formatos: Record<string, { extensao: string; assinatura: (bytes: Uint8Array) => boolean }> = {
    'application/pdf': { extensao: 'pdf', assinatura: (bytes) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 },
    'image/jpeg': { extensao: 'jpg', assinatura: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    'image/png': { extensao: 'png', assinatura: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
    'image/webp': { extensao: 'webp', assinatura: (bytes) => String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' },
  }
  const formato = formatos[arquivo.type]
  if (!formato) return c.json({ error: 'formato_de_comprovante_nao_permitido' }, 415)
  if (arquivo.size < 1 || arquivo.size > 10 * 1024 * 1024) return c.json({ error: 'comprovante_deve_ter_ate_10_mb' }, 413)
  const bytes = new Uint8Array(await arquivo.arrayBuffer())
  if (!formato.assinatura(bytes)) return c.json({ error: 'conteudo_do_comprovante_invalido' }, 415)
  const key = `financeiro/reembolsos/${id}/comprovante/${crypto.randomUUID()}.${formato.extensao}`
  await bucket.put(key, bytes, { httpMetadata: { contentType: arquivo.type, contentDisposition: 'inline' } })
  const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  const url = publicBase
    ? `${publicBase}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
    : `/api/financeiro/contas-apagar/${encodeURIComponent(id)}/comprovante/arquivo?key=${encodeURIComponent(key)}`
  // Anexar um comprovante não altera status, saldo, rateio nem realiza baixa.
  // Usa o vínculo real da conta: nunca confunde ID de conta ou de rateio com lançamento.
  try {
    if (conta.lancamentos_id) {
      await c.env.SHARE_DB.prepare(
        'UPDATE lancamentos SET comprovante_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?',
      ).bind(url, conta.lancamentos_id).run()
    }
  } catch (error) {
    await bucket.delete(key).catch(() => undefined)
    return errorResponse(c, error)
  }
  return c.json({ url }, 201)
})
financeiroRoutes.get('/contas-apagar/:id/comprovante/arquivo', async (c) => {
  const denied = await requireCaixaShareAccess(c)
  if (denied) return denied
  const id = c.req.param('id')
  const key = c.req.query('key') || ''
  const prefixo = `financeiro/reembolsos/${id}/comprovante/`
  if (!key.startsWith(prefixo) || !/^[a-f0-9-]+\.(pdf|jpg|png|webp)$/i.test(key.slice(prefixo.length))) return c.notFound()
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'armazenamento_de_anexos_indisponivel' }, 503)
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' })
})

financeiroRoutes.post('/contas-areceber/:id/comprovante-upload', async (c) => {
  const denied = await requireCaixaShareAccess(c)
  if (denied) return denied
  const id = c.req.param('id')
  const conta = await c.env.SHARE_DB.prepare('SELECT id, status FROM contas_areceber WHERE id = ?')
    .bind(id).first<{ id: string; status: string }>()
  if (!conta) return c.json({ error: 'conta_a_receber_nao_encontrada' }, 404)
  if (['RECEBIDO', 'CANCELADO'].includes(String(conta.status).toUpperCase())) {
    return c.json({ error: 'comprovante_nao_pode_ser_alterado' }, 409)
  }
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'armazenamento_de_anexos_indisponivel' }, 503)
  const form = await c.req.formData()
  const valorArquivo = form.get('arquivo') as unknown
  if (!valorArquivo || typeof valorArquivo !== 'object' || !('arrayBuffer' in valorArquivo) || !('type' in valorArquivo) || !('size' in valorArquivo)) {
    return c.json({ error: 'arquivo_obrigatorio' }, 400)
  }
  const arquivo = valorArquivo as File
  const formatos: Record<string, { extensao: string; assinatura: (bytes: Uint8Array) => boolean }> = {
    'application/pdf': { extensao: 'pdf', assinatura: (bytes) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 },
    'image/jpeg': { extensao: 'jpg', assinatura: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    'image/png': { extensao: 'png', assinatura: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
    'image/webp': { extensao: 'webp', assinatura: (bytes) => String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' },
  }
  const formato = formatos[arquivo.type]
  if (!formato) return c.json({ error: 'formato_de_comprovante_nao_permitido' }, 415)
  if (arquivo.size < 1 || arquivo.size > 10 * 1024 * 1024) return c.json({ error: 'comprovante_deve_ter_ate_10_mb' }, 413)
  const bytes = new Uint8Array(await arquivo.arrayBuffer())
  if (!formato.assinatura(bytes)) return c.json({ error: 'conteudo_do_comprovante_invalido' }, 415)
  const key = `financeiro/contas-areceber/${id}/comprovante/${crypto.randomUUID()}.${formato.extensao}`
  await bucket.put(key, bytes, { httpMetadata: { contentType: arquivo.type, contentDisposition: 'inline' } })
  const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  const url = publicBase
    ? `${publicBase}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
    : `/api/financeiro/contas-areceber/${encodeURIComponent(id)}/comprovante/arquivo?key=${encodeURIComponent(key)}`
  return c.json({ url }, 201)
})

financeiroRoutes.get('/contas-areceber/:id/comprovante/arquivo', async (c) => {
  const denied = await requireCaixaShareAccess(c)
  if (denied) return denied
  const id = c.req.param('id')
  const key = c.req.query('key') || ''
  const prefixo = `financeiro/contas-areceber/${id}/comprovante/`
  if (!key.startsWith(prefixo) || !/^[a-f0-9-]+\.(pdf|jpg|png|webp)$/i.test(key.slice(prefixo.length))) return c.notFound()
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return c.json({ error: 'armazenamento_de_anexos_indisponivel' }, 503)
  const object = await bucket.get(key)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' })
})

financeiroRoutes.post('/contas-areceber/:id/baixa', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
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
