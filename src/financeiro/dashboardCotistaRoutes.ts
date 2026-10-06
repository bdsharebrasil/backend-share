import { Hono } from 'hono'
import {
  holdingMovementColumn,
  loadSchema,
} from './FinanceiroKernel'
import { calcularCompensacaoBalanco, resumirHoldings } from './cotistaDashboard'
import { calcularMediasCotista, calcularMediasCotistaPorMes, type VooMediasCotista } from './mediasCotista'
import { errorResponse } from './errorResponse'
import { listar, listarTodos } from './repositories/d1'
import { selecionarColunaOpcional } from './schemaSql'
import { statusLancamentoFinanceiro } from './statuses'

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }

export const dashboardCotistaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

dashboardCotistaRoutes.get('/cotista/dashboard', async (c) => {
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
      const cotista = await db.prepare('SELECT cliente_id, socio_id FROM cotista_aeronave WHERE id = ?').bind(cotistaId).first<{ cliente_id: string | null; socio_id: string | null }>()
      if (cotista?.socio_id) {
        cotistaSocioId = cotista.socio_id
        cotistaClienteId = undefined
      } else if (cotista?.cliente_id) {
        cotistaClienteId = cotista.cliente_id
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
    const rows = await listar(db, `
      SELECT r.id, r.aeronave_id, r.cotista_id AS participante_id, r.data_emissao AS data, r.descricao_despesa AS descricao,
             COALESCE(r.numero_nf, r.numero_recibo, r.numero_demonstrativo, r.numero_doc, r.documento_numero) AS numero_doc,
             r.numero_nf, r.numero_recibo, r.numero_demonstrativo, r.url_doc, r.url_demonstrativo, r.url_nf, r.url_recibo, r.url_boleto,
             r.fornecedor_id, r.categoria_nome, r.tipo_rateio AS grupo_categoria, r.periodicidade,
             r.data_vencimento, r.data_pagamento, 'SAIDA' AS fluxo, r.valor_rateado_centavos AS valor_centavos,
             r.valor_rateado_centavos AS valor_rateado_centavos, r.valor_pago_real_centavos, r.percentual_sociedade, r.percentual_uso, r.pago_por,
             r.pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado, r.status, r.observacoes,
             l.email_enviado_em, 'rateio_despesas' AS origem_rateio, NULL AS local,
             COALESCE(cl.razao_social, ca.codigo_cliente, r.cotista_id) AS participante_nome
        FROM rateio_despesas r
        LEFT JOIN lancamentos l ON l.id = r.lancamento_id
        LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        WHERE ${[...filtrosCliente, "UPPER(COALESCE(r.status, '')) <> 'CANCELADO'"].join(' AND ')}
      UNION ALL
      SELECT r.id, r.aeronave_id, r.socio_id AS participante_id, r.data_emissao AS data, r.descricao_despesa AS descricao,
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['numero_nf', 'numero_recibo', 'numero_demonstrativo', 'numero_doc', 'documento_numero'], 'numero_doc')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['numero_nf'], 'numero_nf')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['numero_recibo'], 'numero_recibo')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['numero_demonstrativo'], 'numero_demonstrativo')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['url_doc', 'documento_url'], 'url_doc')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['url_demonstrativo'], 'url_demonstrativo')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['url_nf'], 'url_nf')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['url_recibo'], 'url_recibo')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['url_boleto'], 'url_boleto')},
             NULL AS fornecedor_id, r.categoria_nome, r.tipo_rateio AS grupo_categoria, r.periodicidade,
             r.data_vencimento, r.data_pagamento, 'SAIDA' AS fluxo, r.valor_rateado_centavos AS valor_centavos,
             r.valor_rateado_centavos AS valor_rateado_centavos, r.valor_pago_real_centavos, r.percentual_sociedade, r.percentual_uso, r.pago_por,
             r.pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado, r.status, r.observacoes,
             mh.email_enviado_em, 'rateio_hold' AS origem_rateio, NULL AS local,
             COALESCE(hs.nome, r.socio_id) AS participante_nome
        FROM rateio_hold r
        LEFT JOIN movimentos_holding mh ON mh.id = r.${holdingColumn}
        LEFT JOIN hold_socios hs ON hs.id = r.socio_id
        WHERE ${[...filtrosHolding, "UPPER(COALESCE(r.status, '')) <> 'CANCELADO'"].join(' AND ')}
      UNION ALL
      SELECT l.id, l.aeronave_id, l.cotista_aeronave_id AS participante_id, l.data_emissao AS data,
             COALESCE(l.numero_nf, l.numero_recibo, l.numero_demonstrativo, l.numero_doc) AS numero_doc,
             l.numero_nf, l.numero_recibo, l.numero_demonstrativo, l.url_doc, l.url_demonstrativo, l.url_nf, l.url_recibo, l.url_boleto,
             l.fornecedores_favoritos_id AS fornecedor_id, l.categoria_nome, l.grupo_categoria, l.periodicidade,
             l.data_vencimento, l.data_pagamento, l.fluxo, l.valor_centavos, l.valor_centavos AS valor_rateado_centavos,
             0 AS valor_pago_real_centavos, NULL AS percentual_sociedade, NULL AS percentual_uso, l.pago_por,
             l.pago_diretamente, l.reembolsavel, l.reembolso_quitado,
             l.status, l.observacoes,
             l.email_enviado_em, 'lancamentos' AS origem_rateio, NULL AS local,
             COALESCE(cl.razao_social, ca.codigo_cliente, l.cotista_aeronave_id) AS participante_nome
        FROM lancamentos l
        LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
       WHERE ${[...filtrosLancamentos, lancamentoSemRateio].join(' AND ')}
      UNION ALL
      SELECT mh.id, mh.aeronave_id, mh.socio_id AS participante_id, mh.data_emissao AS data,
             COALESCE(mh.numero_nf, mh.numero_recibo, mh.numero_demonstrativo, mh.numero_doc) AS numero_doc,
             mh.numero_nf, mh.numero_recibo, mh.numero_demonstrativo, mh.url_doc, mh.url_demonstrativo, mh.url_nf, mh.url_recibo, mh.url_boleto,
             mh.fornecedor_id, mh.categoria_nome, mh.grupo_categoria, mh.periodicidade, mh.data_vencimento, mh.data_pagamento,
             CASE WHEN UPPER(mh.fluxo) IN ('ENTRADA', 'APORTE', 'ESTORNO') THEN 'ENTRADA' ELSE 'SAIDA' END AS fluxo,
             mh.valor_centavos, mh.valor_centavos AS valor_rateado_centavos, 0 AS valor_pago_real_centavos,
             NULL AS percentual_sociedade, NULL AS percentual_uso, NULL AS pago_por,
             mh.pago_diretamente, 0 AS reembolsavel,
             0 AS reembolso_quitado, mh.status, mh.observacoes, mh.email_enviado_em, 'movimentos_holding' AS origem_rateio,
             NULL AS local, COALESCE(hs.nome, mh.socio_id) AS participante_nome
        FROM movimentos_holding mh
        LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
       WHERE ${[...filtrosMovimento, movimentoHoldingSemRateio].join(' AND ')}
      ORDER BY 4 DESC, 1 DESC LIMIT 1000
    `, ...paramsCliente, ...paramsHolding, ...paramsLancamentos, ...paramsMovimento)
    const aeronaveIds = [...new Set(rows.map(row => String(row.aeronave_id ?? '').trim()).filter(Boolean))]
    const aeronavesPorId = new Map<string, string>()
    if (aeronaveIds.length) {
      const aeronaves = await listar(db, `SELECT id, matricula_registro FROM aeronave WHERE id IN (${aeronaveIds.map(() => '?').join(', ')})`, ...aeronaveIds)
      aeronaves.forEach(row => { if (row.id && row.matricula_registro) aeronavesPorId.set(String(row.id), String(row.matricula_registro)) })
    }
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
      sociosHolding.map(row => ({ holdingId: String(row.holding_id), holdingName: String(row.holding_nome), bankAccount: row.conta_bancaria ? String(row.conta_bancaria) : null, socioId: String(row.socio_id), socioName: String(row.socio_nome), percentage: Number(row.percentual || 0) })),
      movimentosHolding.map(row => ({ id: String(row.id), holding_id: row.holding_id ? String(row.holding_id) : null, socio_id: row.socio_id ? String(row.socio_id) : null, fluxo: row.fluxo ? String(row.fluxo) : null, status: row.status ? String(row.status) : null, valor_centavos: row.valor_centavos as number | string | null, pago_diretamente: row.pago_diretamente as number | boolean | null })),
      rateiosHolding.map(row => ({ movimento_id: row.movimento_id ? String(row.movimento_id) : null, socio_id: String(row.socio_id), status: row.status ? String(row.status) : null, pago_diretamente: row.pago_diretamente as number | boolean | null, valor_rateado_centavos: row.valor_rateado_centavos as number | string | null, valor_pago_real_centavos: row.valor_pago_real_centavos as number | string | null })),
    )
    const lancamentos = rows.map(row => ({ id: row.id, aeronaveId: row.aeronave_id ?? null, aeronaveNome: aeronavesPorId.get(String(row.aeronave_id ?? '')) ?? null, participanteId: row.participante_id ?? null, participanteNome: row.participante_nome ?? null, data: row.data, descricao: row.descricao, documento: row.numero_doc ?? null, numeroNf: row.numero_nf ?? null, numeroRecibo: row.numero_recibo ?? null, numeroDemonstrativo: row.numero_demonstrativo ?? null, numeroDoc: row.numero_doc ?? null, fornecedor: row.fornecedor_id ?? null, categoria: row.categoria_nome ?? 'SEM CATEGORIA', grupoCategoria: row.grupo_categoria ?? '', tipo: row.origem_rateio ?? null, periodicidade: row.periodicidade ?? null, prazo: row.data_vencimento ?? null, dataPagamento: row.data_pagamento ?? null, fluxo: String(row.fluxo ?? 'SAIDA').toUpperCase(), valorCentavos: Number(row.valor_centavos || row.valor_rateado_centavos || 0), valorRateadoCentavos: Number(row.valor_rateado_centavos || row.valor_centavos || 0), valorPagoRealCentavos: Number(row.valor_pago_real_centavos || row.valor_centavos || 0), percentualSociedade: row.percentual_sociedade == null ? null : Number(row.percentual_sociedade), percentualUso: row.percentual_uso == null ? null : Number(row.percentual_uso), pagoPor: row.pago_por ?? '', caixa: row.tipo_caixa ?? 'SHARE', pagoDiretamente: Boolean(row.pago_diretamente), reembolsavel: Boolean(row.reembolsavel), reembolsoQuitado: Boolean(row.reembolso_quitado), status: row.origem_rateio === 'lancamentos' ? statusLancamentoFinanceiro(row.status, row.data_vencimento) : row.status ?? 'EM_ABERTO', observacoes: row.observacoes ?? null, urlDoc: row.url_doc ?? null, urlDemonstrativo: row.url_demonstrativo ?? null, urlNf: row.url_nf ?? null, urlRecibo: row.url_recibo ?? null, urlBoleto: row.url_boleto ?? null, emailEnviadoEm: row.email_enviado_em ?? null, local: row.local ?? null, rateios: [] }))
    const extratoHolding = movimentosHolding.slice(0, 1000).map(row => ({ id: String(row.id), holdingId: row.holding_id ? String(row.holding_id) : null, holdingNome: row.holding_nome ? String(row.holding_nome) : null, socioId: row.socio_id ? String(row.socio_id) : null, socioNome: row.socio_nome ? String(row.socio_nome) : null, aeronaveId: row.aeronave_id ? String(row.aeronave_id) : null, data: row.data ? String(row.data) : '', dataPagamento: row.data_pagamento ? String(row.data_pagamento) : null, descricao: String(row.descricao ?? ''), categoria: row.categoria_nome ? String(row.categoria_nome) : null, fluxo: String(row.fluxo ?? '').toUpperCase(), valorCentavos: Number(row.valor_centavos || 0), status: String(row.status ?? 'EM_ABERTO').toUpperCase(), contaBancaria: row.conta_bancaria ? String(row.conta_bancaria) : null, diretamentePago: Boolean(row.pago_diretamente) }))
    const entradas = lancamentos.filter(row => row.fluxo === 'ENTRADA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const saidas = lancamentos.filter(row => row.fluxo === 'SAIDA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const porMes = new Map<string, { mes: string; entradas: number; saidas: number; custoRateado: number; lancamentos: number; saldo: number; mediaPorLancamento: number }>()
    const porCategoria = new Map<string, { valor: number; quantidade: number; grupo: string }>()
    rows.forEach(row => {
      const mes = String(row.data ?? '').slice(0, 7)
      if (mes) { const atual = porMes.get(mes) ?? { mes, entradas: 0, saidas: 0, custoRateado: 0, lancamentos: 0, saldo: 0, mediaPorLancamento: 0 }; const valor = Number(row.valor_centavos || 0) / 100; if (String(row.fluxo).toUpperCase() === 'ENTRADA') atual.entradas += valor; else { atual.saidas += valor; atual.custoRateado += Number(row.valor_rateado_centavos || row.valor_centavos || 0) / 100; } atual.lancamentos += 1; atual.saldo = atual.entradas - atual.saidas; atual.mediaPorLancamento = atual.lancamentos ? atual.saidas / atual.lancamentos : 0; porMes.set(mes, atual) }
      if (String(row.fluxo).toUpperCase() !== 'SAIDA') return; const categoria = String(row.categoria_nome ?? 'SEM CATEGORIA'); const atual = porCategoria.get(categoria) ?? { valor: 0, quantidade: 0, grupo: String(row.grupo_categoria ?? '') }; atual.valor += Number(row.valor_centavos || 0) / 100; atual.quantidade += 1; porCategoria.set(categoria, atual)
    })
    const participantesPermitidos = aeronaveId
      ? new Set((await listar(db, 'SELECT id, socio_id FROM cotista_aeronave WHERE aeronave_id = ?', aeronaveId)).flatMap(row => [String(row.id), row.socio_id ? String(row.socio_id) : null].filter(Boolean) as string[]))
      : undefined
    const compensacao = calcularCompensacaoBalanco(rows, participantesPermitidos)
    const filtrosVoos: string[] = ['l.aeronave_id = ?']
    const paramsVoos: unknown[] = [aeronaveId]
    if (inicio) { filtrosVoos.push('date(l.data_registro) >= date(?)'); paramsVoos.push(inicio) }
    if (fim) { filtrosVoos.push('date(l.data_registro) <= date(?)'); paramsVoos.push(fim) }
    if (cotistaClienteId) { filtrosVoos.push('l.cliente_id = ?'); paramsVoos.push(cotistaClienteId) }
    if (cotistaSocioId) { filtrosVoos.push('l.socio_id = ?'); paramsVoos.push(cotistaSocioId) }
    const voosMedias = aeronaveId
      ? await listar(db, `SELECT l.data_registro, l.tempo_total, l.pousos_total FROM lancamentos_diario_bordo l WHERE ${filtrosVoos.join(' AND ')}`, ...paramsVoos)
      : []
    const medias = calcularMediasCotista(voosMedias as VooMediasCotista[], Math.round(saidas * 100))
    const custosPorMes = new Map<string, number>()
    for (const row of rows) {
      if (String(row.fluxo ?? 'SAIDA').toUpperCase() !== 'SAIDA') continue
      const mes = String(row.data ?? '').slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(mes)) continue
      custosPorMes.set(mes, (custosPorMes.get(mes) ?? 0) + Number(row.valor_centavos || row.valor_rateado_centavos || 0))
    }
    const mediasMensais = calcularMediasCotistaPorMes(voosMedias as VooMediasCotista[], custosPorMes)
    return c.json({ lancamentos, ...compensacao, holdings, movimentos_holding: extratoHolding, medias, medias_mensais: mediasMensais, resumo: { entradas, saidas, saldo: entradas - saidas, custo_rateado: [...porMes.values()].reduce((total, item) => total + item.custoRateado, 0), pendentes: lancamentos.filter(row => ['EM_ABERTO', 'EM_ATRASO'].includes(String(row.status).toUpperCase())).length, media_mensal: porMes.size ? saidas / porMes.size : 0, media_lancamento: lancamentos.length ? saidas / lancamentos.length : 0 }, fechamento_mensal: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)), ranking_gastos: [...porCategoria.entries()].map(([categoria, value]) => ({ categoria, ...value })).sort((a, b) => b.valor - a.valor), ranking_cotistas: [] })
  } catch (error) { return errorResponse(c, error) }
})

dashboardCotistaRoutes.get('/cotista/voos-emprestimos', async (c) => {
  try {
    const cotistaId = String(c.req.query('cotista_id') || '').trim()
    const tipo = String(c.req.query('tipo') || 'cliente').trim().toLowerCase()
    const aeronaveExcluida = String(c.req.query('excluir_aeronave_id') || '').trim()
    const inicio = String(c.req.query('inicio') || '').trim()
    const fim = String(c.req.query('fim') || '').trim()
    if (!cotistaId || !['cliente', 'socio'].includes(tipo)) return c.json({ voos_emprestimos: [] })
    const filtros = [`a.voo_emprestado = 1`, `a.${tipo === 'socio' ? 'socio_id' : 'cliente_id'} = ?`]
    const params: unknown[] = [cotistaId]
    if (aeronaveExcluida) { filtros.push('a.aeronave_id <> ?'); params.push(aeronaveExcluida) }
    if (inicio) { filtros.push('date(a.data) >= date(?)'); params.push(inicio) }
    if (fim) { filtros.push('date(a.data) <= date(?)'); params.push(fim) }
    const rows = await listar(c.env.SHARE_DB, `SELECT a.id, a.numero_voo, a.data, a.trecho, a.local, a.litros, a.valor_total, a.status, a.numero_comanda, a.numero_nf, a.aeronave_id, ar.matricula_registro, ar.fabricante, ar.modelo, COALESCE(ad.designativo_icao, a.local) AS local_icao FROM abastecimentos a LEFT JOIN aeronave ar ON ar.id = a.aeronave_id LEFT JOIN aerodromo ad ON ad.id = a.local OR upper(trim(ad.designativo_icao)) = upper(trim(a.local)) WHERE ${filtros.join(' AND ')} ORDER BY date(a.data) DESC, a.id DESC`, ...params)
    return c.json({ voos_emprestimos: rows })
  } catch (error) { return errorResponse(c, error) }
})

dashboardCotistaRoutes.get('/balanco', async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/cotista/dashboard'
  return dashboardCotistaRoutes.fetch(new Request(url, c.req.raw), c.env, c.executionCtx)
})
