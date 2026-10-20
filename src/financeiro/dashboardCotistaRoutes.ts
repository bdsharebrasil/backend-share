import { carregarDadosBalancoMensal } from './balancoMensalRoutes'
import { carregarBalancoOperacional } from './balancoOperacional'
import { Hono } from 'hono'
import {
  holdingMovementColumn,
  loadSchema,
} from './FinanceiroKernel'
import { buildLancamentoSemRateioPredicate, calcularCompensacaoBalanco, consolidarRateiosLancamentos, resumirHoldings } from './cotistaDashboard'
import { calcularMediasCotista, calcularMediasCotistaPorMes, type VooMediasCotista } from './mediasCotista'
import { montarRelatorioGeral, type CustoBruto, type VooMes } from './relatorioGeralCotista'
import { errorResponse } from './errorResponse'
import { listar, listarTodos } from './repositories/d1'
import { selecionarColunaOpcional } from './schemaSql'
import { statusLancamentoFinanceiro } from './statuses'

// Compatibilidade para consumidores legados; a implementação vive no módulo compartilhado.
export { buildLancamentoSemRateioPredicate } from './cotistaDashboard'

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }

export const dashboardCotistaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function documentosVinculados(anexosJson: unknown, campos: Array<{ nome: string; url: unknown; numero?: unknown; tipo?: unknown }>) {
  let anexos: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(String(anexosJson || '[]'))
    if (Array.isArray(parsed)) anexos = parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  } catch {
    anexos = []
  }
  const documentos = [
    ...anexos.map((anexo) => ({
      id: String(anexo.id ?? ''),
      nome: String(anexo.nome ?? anexo.filename ?? anexo.nome_arquivo ?? anexo.tipo ?? 'Documento'),
      url: String(anexo.url ?? anexo.arquivo_url ?? '').trim(),
      numero: anexo.numero == null ? null : String(anexo.numero),
      tipo: anexo.tipo == null ? null : String(anexo.tipo),
    })),
    ...campos.map((campo) => ({
      id: '', nome: campo.nome, url: String(campo.url ?? '').trim(),
      numero: campo.numero == null ? null : String(campo.numero),
      tipo: campo.tipo == null ? null : String(campo.tipo),
    })),
  ].filter((documento) => documento.url)
  const vistos = new Set<string>()
  return documentos.filter((documento) => {
    const chave = `${documento.url}|${documento.numero ?? ''}`
    if (vistos.has(chave)) return false
    vistos.add(chave)
    return true
  })
}

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
    if (schema.get('lancamentos')?.has('escopo_financeiro')) filtrosLancamentos.push("COALESCE(l.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO'")
    if (schema.get('movimentos_holding')?.has('escopo_financeiro')) filtrosMovimento.push("COALESCE(mh.escopo_financeiro, 'FINANCEIRO') = 'FINANCEIRO'")
    if (fim) { filtrosCliente.push('date(r.data_emissao) <= date(?)'); paramsCliente.push(fim); filtrosHolding.push('date(r.data_emissao) <= date(?)'); paramsHolding.push(fim); filtrosLancamentos.push('date(l.data_emissao) <= date(?)'); paramsLancamentos.push(fim) }
    if (aeronaveId) { filtrosCliente.push('r.aeronave_id = ?'); paramsCliente.push(aeronaveId); filtrosHolding.push('r.aeronave_id = ?'); paramsHolding.push(aeronaveId); filtrosLancamentos.push('l.aeronave_id = ?'); paramsLancamentos.push(aeronaveId) }
    // rateio_despesas.cotista_id referencia cotista_aeronave.id, não cliente.id.
    // O cliente_id é usado apenas para resolver o nome do participante no JOIN.
    if (cotistaAeronaveId && !cotistaSocioId) { filtrosCliente.push('r.cotista_id = ?'); paramsCliente.push(cotistaAeronaveId) }
    if (cotistaAeronaveId) { filtrosLancamentos.push('l.cotista_aeronave_id = ?'); paramsLancamentos.push(cotistaAeronaveId) }
    if (cotistaId && cotistaSocioId) filtrosCliente.push('1 = 0')
    if (cotistaId && !cotistaSocioId) { filtrosHolding.push('1 = 0'); filtrosMovimento.push('1 = 0') }
    if (cotistaSocioId) { filtrosHolding.push('r.socio_id = ?'); paramsHolding.push(cotistaSocioId); filtrosMovimento.push('mh.socio_id = ?'); paramsMovimento.push(cotistaSocioId) }
    if (fim) { filtrosMovimento.push('date(mh.data_emissao) <= date(?)'); paramsMovimento.push(fim) }
    if (aeronaveId) { filtrosMovimento.push('mh.aeronave_id = ?'); paramsMovimento.push(aeronaveId) }
    // Um lançamento só aparece sozinho quando NENHUM rateio o representa. O reembolso pode criar
    // um par origem/espelho; os vínculos e colunas de origem são usados quando existem no schema.
    const lancamentoSemRateio = buildLancamentoSemRateioPredicate(schema)
    if (schema.get('abastecimentos')?.has('rateio_entre_cotistas')) {
      filtrosCliente.push(`NOT (r.percentual_uso = 100 AND r.valor_rateado_centavos = r.valor_total_centavos AND EXISTS (
        SELECT 1 FROM lancamentos la
        JOIN abastecimentos ab ON ab.id = la.abastecimentos_id
        JOIN cotista_aeronave titular ON titular.aeronave_id = ab.aeronave_id
          AND ((ab.cliente_id IS NOT NULL AND titular.cliente_id = ab.cliente_id)
            OR (ab.socio_id IS NOT NULL AND titular.socio_id = ab.socio_id))
        WHERE la.id = r.lancamento_id AND ab.rateio_entre_cotistas = 1 AND titular.id = r.cotista_id
      ))`)
      filtrosLancamentos.push(`NOT EXISTS (SELECT 1 FROM abastecimentos ab WHERE ab.id = l.abastecimentos_id AND ab.rateio_entre_cotistas = 1)`)
    }
    const movimentoHoldingSemRateio = `NOT EXISTS (SELECT 1 FROM rateio_hold rh WHERE rh.${holdingColumn} = mh.id AND UPPER(COALESCE(rh.status, '')) <> 'CANCELADO')`
    const rows = await listar(db, `
      SELECT r.id, r.aeronave_id, r.cotista_id AS participante_id, r.data_emissao AS data, r.descricao_despesa AS descricao,
             COALESCE(
               NULLIF(TRIM(r.numero_nf), ''),
               NULLIF(TRIM(r.numero_recibo), ''),
               NULLIF(TRIM(r.numero_demonstrativo), ''),
               NULLIF(TRIM(r.numero_doc), ''),
               NULLIF(TRIM(r.documento_numero), ''),
               NULLIF(TRIM(l.numero_doc), '')
             ) AS numero_doc,
             r.numero_nf, r.numero_recibo, r.numero_demonstrativo,
             COALESCE(NULLIF(r.url_doc, ''), NULLIF(r.documento_url, ''), NULLIF(l.url_doc, '')) AS url_doc,
             r.url_demonstrativo, r.url_nf, r.url_recibo, r.url_boleto,
             ${selecionarColunaOpcional(schema, 'rateio_despesas', 'r', ['anexos_json'], 'anexos_json')}, r.subcategoria_1, r.subcategoria_2, r.subcategoria_3, r.subcategoria_4,
             COALESCE(r.fornecedor_id, l.fornecedores_favoritos_id) AS fornecedor_id,
             NULLIF(TRIM(l.fornecedor_nome), '') AS fornecedor_nome,
             r.categoria_nome, r.tipo_rateio AS grupo_categoria, r.tipo_rateio, r.periodicidade,
             r.data_vencimento, r.data_pagamento, 'SAIDA' AS fluxo, r.valor_rateado_centavos AS valor_centavos,
             r.valor_rateado_centavos AS valor_rateado_centavos, r.valor_pago_real_centavos, r.percentual_sociedade, r.percentual_uso, r.pago_por,
             r.pago_diretamente, COALESCE(l.reembolsavel, 0) AS reembolsavel, COALESCE(l.reembolso_quitado, 0) AS reembolso_quitado, r.status, r.observacoes,
             COALESCE(r.email_enviado_em, l.email_enviado_em) AS email_enviado_em, 'rateio_despesas' AS origem_rateio, NULL AS local,
             COALESCE(cl.razao_social, hs.nome, ca.codigo_cliente, r.cotista_id) AS participante_nome,
             r.lancamento_id AS lancamento_id
        FROM rateio_despesas r
        LEFT JOIN lancamentos l ON l.id = r.lancamento_id
        LEFT JOIN cotista_aeronave ca ON ca.id = r.cotista_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
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
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['anexos_json'], 'anexos_json')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['subcategoria_1'], 'subcategoria_1')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['subcategoria_2'], 'subcategoria_2')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['subcategoria_3'], 'subcategoria_3')},
             ${selecionarColunaOpcional(schema, 'rateio_hold', 'r', ['subcategoria_4'], 'subcategoria_4')},
             r.fornecedor_id, r.fornecedor AS fornecedor_nome, r.categoria_nome, r.tipo_rateio AS grupo_categoria, r.tipo_rateio, r.periodicidade,
             r.data_vencimento, r.data_pagamento, 'SAIDA' AS fluxo, r.valor_rateado_centavos AS valor_centavos,
             r.valor_rateado_centavos AS valor_rateado_centavos, r.valor_pago_real_centavos, r.percentual_sociedade, r.percentual_uso, r.pago_por,
             r.pago_diretamente, 0 AS reembolsavel, 0 AS reembolso_quitado, r.status, r.observacoes,
             COALESCE(r.email_enviado_em, mh.email_enviado_em) AS email_enviado_em, 'rateio_hold' AS origem_rateio, NULL AS local,
             COALESCE(hs.nome, r.socio_id) AS participante_nome,
             r.${holdingColumn} AS lancamento_id
        FROM rateio_hold r
        LEFT JOIN movimentos_holding mh ON mh.id = r.${holdingColumn}
        LEFT JOIN hold_socios hs ON hs.id = r.socio_id
        WHERE ${[...filtrosHolding, "UPPER(COALESCE(r.status, '')) <> 'CANCELADO'"].join(' AND ')}
      UNION ALL
      SELECT l.id, l.aeronave_id, l.cotista_aeronave_id AS participante_id, l.data_emissao AS data, l.descricao AS descricao,
             COALESCE(l.numero_nf, l.numero_recibo, l.numero_demonstrativo, l.numero_doc) AS numero_doc,
             l.numero_nf, l.numero_recibo, l.numero_demonstrativo, l.url_doc, l.url_demonstrativo, l.url_nf, l.url_recibo, l.url_boleto,
             ${selecionarColunaOpcional(schema, 'lancamentos', 'l', ['anexos_json'], 'anexos_json')}, l.subcategoria_1, l.subcategoria_2, l.subcategoria_3, l.subcategoria_4,
             l.fornecedores_favoritos_id AS fornecedor_id, l.fornecedor_nome AS fornecedor_nome, l.categoria_nome, l.grupo_categoria, l.tipo_rateio, l.periodicidade,
             l.data_vencimento, l.data_pagamento, l.fluxo, l.valor_centavos, l.valor_centavos AS valor_rateado_centavos,
             0 AS valor_pago_real_centavos, NULL AS percentual_sociedade, NULL AS percentual_uso, l.pago_por,
             l.pago_diretamente, l.reembolsavel, l.reembolso_quitado,
             l.status, l.observacoes,
             l.email_enviado_em, 'lancamentos' AS origem_rateio, NULL AS local,
             COALESCE(cl.razao_social, ca.codigo_cliente, l.cotista_aeronave_id) AS participante_nome,
             NULL AS lancamento_id
        FROM lancamentos l
        LEFT JOIN cotista_aeronave ca ON ca.id = l.cotista_aeronave_id
        LEFT JOIN cliente cl ON cl.id = ca.cliente_id
       WHERE ${[...filtrosLancamentos, lancamentoSemRateio].join(' AND ')}
      UNION ALL
      SELECT mh.id, mh.aeronave_id, mh.socio_id AS participante_id, mh.data_emissao AS data, mh.descricao AS descricao,
             COALESCE(mh.numero_nf, mh.numero_recibo, mh.numero_demonstrativo, mh.numero_doc) AS numero_doc,
             mh.numero_nf, mh.numero_recibo, mh.numero_demonstrativo, mh.url_doc, mh.url_demonstrativo, mh.url_nf, mh.url_recibo, mh.url_boleto,
             ${selecionarColunaOpcional(schema, 'movimentos_holding', 'mh', ['anexos_json'], 'anexos_json')}, mh.subcategoria_1, mh.subcategoria_2, mh.subcategoria_3, mh.subcategoria_4,
             mh.fornecedor_id, mh.fornecedor_nome AS fornecedor_nome, mh.categoria_nome, mh.grupo_categoria, mh.tipo_rateio, mh.periodicidade, mh.data_vencimento, mh.data_pagamento,
             CASE WHEN UPPER(mh.fluxo) IN ('ENTRADA', 'APORTE', 'ESTORNO') THEN 'ENTRADA' ELSE 'SAIDA' END AS fluxo,
             mh.valor_centavos, mh.valor_centavos AS valor_rateado_centavos, 0 AS valor_pago_real_centavos,
             NULL AS percentual_sociedade, NULL AS percentual_uso, NULL AS pago_por,
             mh.pago_diretamente, 0 AS reembolsavel,
             0 AS reembolso_quitado, mh.status, mh.observacoes, mh.email_enviado_em, 'movimentos_holding' AS origem_rateio,
             NULL AS local, COALESCE(hs.nome, mh.socio_id) AS participante_nome,
             NULL AS lancamento_id
        FROM movimentos_holding mh
        LEFT JOIN hold_socios hs ON hs.id = mh.socio_id
       WHERE ${[...filtrosMovimento, movimentoHoldingSemRateio].join(' AND ')}
      ORDER BY 4 DESC, 1 DESC
    `, ...paramsCliente, ...paramsHolding, ...paramsLancamentos, ...paramsMovimento)
    const dentroDoPeriodo = (row: Record<string, unknown>) => {
      const data = String(row.data ?? '').slice(0, 10)
      if (inicio && (!data || data < inicio)) return false
      if (fim && (!data || data > fim)) return false
      return true
    }
    const comprovantesPorLancamento = new Map<string, string>()
    const idsLancamentosDocumentos = [...new Set(rows.map(row => String(row.lancamento_id ?? (row.origem_rateio === 'lancamentos' ? row.id : '')).trim()).filter(Boolean))]
    if (idsLancamentosDocumentos.length && schema.get('lancamentos')?.has('comprovante_url')) {
      const comprovantes = await listar(db, `SELECT id, comprovante_url FROM lancamentos WHERE id IN (${idsLancamentosDocumentos.map(() => '?').join(', ')})`, ...idsLancamentosDocumentos)
      for (const item of comprovantes) if (item.comprovante_url) comprovantesPorLancamento.set(String(item.id), String(item.comprovante_url))
    }
    const rowsComDocumentos = rows.map((row) => ({
      ...row,
      documentos_vinculados: documentosVinculados(row.anexos_json, [
        { nome: 'Documento', url: row.url_doc, numero: row.numero_doc, tipo: 'documento' },
        { nome: 'Nota fiscal', url: row.url_nf, numero: row.numero_nf, tipo: 'nota_fiscal' },
        { nome: 'Recibo', url: row.url_recibo, numero: row.numero_recibo, tipo: 'recibo' },
        { nome: 'Demonstrativo', url: row.url_demonstrativo, numero: row.numero_demonstrativo, tipo: 'demonstrativo' },
        { nome: 'Boleto', url: row.url_boleto, tipo: 'boleto' },
        { nome: 'Comprovante', url: comprovantesPorLancamento.get(String(row.lancamento_id ?? row.id)), tipo: 'comprovante' },
      ]),
    }))
    const rowsParaExibicao = consolidarRateiosLancamentos(rowsComDocumentos.filter(dentroDoPeriodo))
    const aeronaveIds = [...new Set(rowsParaExibicao.map(row => String(row.aeronave_id ?? '').trim()).filter(Boolean))]
    const aeronavesPorId = new Map<string, string>()
    if (aeronaveIds.length) {
      const aeronaves = await listar(db, `SELECT id, matricula_registro FROM aeronave WHERE id IN (${aeronaveIds.map(() => '?').join(', ')})`, ...aeronaveIds)
      aeronaves.forEach(row => { if (row.id && row.matricula_registro) aeronavesPorId.set(String(row.id), String(row.matricula_registro)) })
    }
    const fornecedorIds = [...new Set(rowsParaExibicao.map(row => String(row.fornecedor_id ?? '').trim()).filter(Boolean))]
    const fornecedoresPorId = new Map<string, string>()
    if (fornecedorIds.length) {
      const fornecedores = await listar(db, `SELECT id, nome_completo FROM fornecedores_favoritos WHERE id IN (${fornecedorIds.map(() => '?').join(', ')})`, ...fornecedorIds)
      fornecedores.forEach(row => { if (row.id && row.nome_completo) fornecedoresPorId.set(String(row.id), String(row.nome_completo)) })
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
    const idsPagadores = [...new Set(rows.flatMap(row => [row.pago_por]).map(value => String(value ?? '').trim()).filter(Boolean))]
    const nomesPagadores = new Map<string, string>()
    if (idsPagadores.length) {
      const placeholders = idsPagadores.map(() => '?').join(', ')
      const pagadores = await listar(db, `
        SELECT ca.id, COALESCE(NULLIF(cl.razao_social, ''), NULLIF(hs.nome, ''), ca.codigo_cliente) AS nome
        FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id
        LEFT JOIN hold_socios hs ON hs.id = ca.socio_id WHERE ca.id IN (${placeholders})
        UNION ALL SELECT id, razao_social AS nome FROM cliente WHERE id IN (${placeholders})
        UNION ALL SELECT id, nome FROM hold_socios WHERE id IN (${placeholders})
      `, ...idsPagadores, ...idsPagadores, ...idsPagadores)
      for (const pagador of pagadores) if (pagador.nome) nomesPagadores.set(String(pagador.id), String(pagador.nome))
    }
    const nomePagador = (value: unknown) => {
      const nome = String(value ?? '').trim()
      if (!nome) return null
      return nomesPagadores.get(nome) ?? (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nome) ? 'Pagador não identificado' : nome)
    }
    const subcategoriasExibicao = (item: Record<string, unknown>) =>
      [item.subcategoria_1, item.subcategoria_2, item.subcategoria_3, item.subcategoria_4]
        .map(value => String(value ?? '').trim()).filter(Boolean)
    const lancamentos = rowsParaExibicao.map(row => ({ id: row.id, aeronaveId: row.aeronave_id ?? null, aeronaveNome: aeronavesPorId.get(String(row.aeronave_id ?? '')) ?? null, participanteId: row.participante_id ?? null, participanteNome: row.participante_nome ?? null, data: row.data, descricao: row.descricao, documento: row.numero_doc ?? null, numeroNf: row.numero_nf ?? null, numeroRecibo: row.numero_recibo ?? null, numeroDemonstrativo: row.numero_demonstrativo ?? null, numeroDoc: row.numero_doc ?? null, fornecedor: row.fornecedor_nome ?? fornecedoresPorId.get(String(row.fornecedor_id ?? "")) ?? row.fornecedor_id ?? null, categoria: row.categoria_nome ?? 'SEM CATEGORIA', grupoCategoria: row.grupo_categoria ?? '', tipo: row.origem_rateio ?? null, tipoRateio: row.tipo_rateio ?? null, periodicidade: row.periodicidade ?? null, prazo: row.data_vencimento ?? null, dataPagamento: row.data_pagamento ?? null, fluxo: String(row.fluxo ?? 'SAIDA').toUpperCase(), valorCentavos: Number(row.valor_centavos ?? row.valor_rateado_centavos ?? 0), valorRateadoCentavos: Number(row.valor_rateado_centavos ?? row.valor_centavos ?? 0), valorPagoRealCentavos: Number(row.valor_pago_real_centavos ?? 0), percentualSociedade: row.percentual_sociedade == null ? null : Number(row.percentual_sociedade), percentualUso: row.percentual_uso == null ? null : Number(row.percentual_uso), pagoPor: nomePagador(row.pago_por) ?? '', subcategorias: subcategoriasExibicao(row), documentos: row.documentos_vinculados ?? [], caixa: row.tipo_caixa ?? 'SHARE', pagoDiretamente: Boolean(row.pago_diretamente), reembolsavel: Boolean(row.reembolsavel), reembolsoQuitado: Boolean(row.reembolso_quitado), status: row.origem_rateio === 'lancamentos' ? statusLancamentoFinanceiro(row.status, row.data_vencimento) : row.status ?? 'EM_ABERTO', observacoes: row.observacoes ?? null, urlDoc: row.url_doc ?? null, urlDemonstrativo: row.url_demonstrativo ?? null, urlNf: row.url_nf ?? null, urlRecibo: row.url_recibo ?? null, urlBoleto: row.url_boleto ?? null, emailEnviadoEm: row.email_enviado_em ?? null, local: row.local ?? null, rateios: Array.isArray(row.rateio_linhas) ? row.rateio_linhas.map((rateio: Record<string, unknown>) => ({ id: String(rateio.id ?? ''), cotistaId: rateio.cotista_id ? String(rateio.cotista_id) : null, cotista: String(rateio.cotista_nome ?? rateio.cotista_id ?? 'Cotista não informado'), percentual: Number(rateio.percentual_uso ?? rateio.percentual_sociedade ?? 0), percentualSociedade: rateio.percentual_sociedade == null ? null : Number(rateio.percentual_sociedade), valorCentavos: Number(rateio.valor_rateado_centavos ?? 0), valorPagoRealCentavos: Number(rateio.valor_pago_real_centavos ?? 0), pagoPor: nomePagador(rateio.pago_por), dataVencimento: rateio.data_vencimento ?? null, dataPagamento: rateio.data_pagamento ?? null, subcategorias: subcategoriasExibicao(rateio), periodicidade: rateio.periodicidade ?? null, tipoRateio: rateio.tipo_rateio ?? null, documentos: rateio.documentos_vinculados ?? [], pagoDiretamente: Boolean(rateio.pago_diretamente), status: String(rateio.status ?? 'EM_ABERTO') })) : [] }))
    const extratoHolding = movimentosHolding.filter(dentroDoPeriodo).map(row => ({ id: String(row.id), holdingId: row.holding_id ? String(row.holding_id) : null, holdingNome: row.holding_nome ? String(row.holding_nome) : null, socioId: row.socio_id ? String(row.socio_id) : null, socioNome: row.socio_nome ? String(row.socio_nome) : null, aeronaveId: row.aeronave_id ? String(row.aeronave_id) : null, data: row.data ? String(row.data) : '', dataPagamento: row.data_pagamento ? String(row.data_pagamento) : null, descricao: String(row.descricao ?? ''), categoria: row.categoria_nome ? String(row.categoria_nome) : null, fluxo: String(row.fluxo ?? '').toUpperCase(), valorCentavos: Number(row.valor_centavos || 0), status: String(row.status ?? 'EM_ABERTO').toUpperCase(), contaBancaria: row.conta_bancaria ? String(row.conta_bancaria) : null, diretamentePago: Boolean(row.pago_diretamente) }))
    const entradas = lancamentos.filter(row => row.fluxo === 'ENTRADA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const saidas = lancamentos.filter(row => row.fluxo === 'SAIDA').reduce((total, row) => total + row.valorCentavos / 100, 0)
    const porMes = new Map<string, { mes: string; entradas: number; saidas: number; custoRateado: number; lancamentos: number; saldo: number; mediaPorLancamento: number }>()
    const porCategoria = new Map<string, { valor: number; quantidade: number; grupo: string }>()
    rowsParaExibicao.forEach(row => {
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
    for (const row of rowsParaExibicao) {
      if (String(row.fluxo ?? 'SAIDA').toUpperCase() !== 'SAIDA') continue
      const mes = String(row.data ?? '').slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(mes)) continue
      custosPorMes.set(mes, (custosPorMes.get(mes) ?? 0) + Number(row.valor_centavos || row.valor_rateado_centavos || 0))
    }
    const mediasMensais = calcularMediasCotistaPorMes(voosMedias as VooMediasCotista[], custosPorMes)
    // O fechamento gerencial exige o conjunto da aeronave; não amplia consultas individuais.
    const balancoOperacional = aeronaveId && !cotistaId
      ? await carregarBalancoOperacional(db, schema, aeronaveId, inicio, fim)
      : null
    // A falha da extensão não derruba as abas existentes. Nunca amplia consulta individual.
    let balancoFontes = null
    let balancoDetalhadoErro: string | null = null
    if (aeronaveId && !cotistaId) {
      try {
        const dados = await carregarDadosBalancoMensal(db, aeronaveId, fim || new Date().toISOString().slice(0, 10))
        balancoFontes = { versao: 1, aeronaveId, participantes: dados.participantes, rateios: dados.rateios, pagamentos: dados.pagamentos, ajustes: dados.ajustes }
      } catch (e) {
        console.error('Falha ao carregar balanço detalhado', e)
        balancoDetalhadoErro = 'Não foi possível carregar rateios e pagamentos. Verifique a migração 20261006_balanco.sql e os vínculos dos dados.'
      }
    }
    return c.json({ balanco_fontes: balancoFontes, balanco_detalhado_erro: balancoDetalhadoErro, balanco_operacional: balancoOperacional, balanco_escopo: cotistaId ? 'cotista' : aeronaveId ? 'aeronave' : 'geral', lancamentos, ...compensacao, holdings, movimentos_holding: extratoHolding, medias, medias_mensais: mediasMensais, resumo: { entradas, saidas, saldo: entradas - saidas, custo_rateado: [...porMes.values()].reduce((total, item) => total + item.custoRateado, 0), pendentes: lancamentos.filter(row => ['EM_ABERTO', 'EM_ATRASO'].includes(String(row.status).toUpperCase())).length, media_mensal: porMes.size ? saidas / porMes.size : 0, media_lancamento: lancamentos.length ? saidas / lancamentos.length : 0 }, fechamento_mensal: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)), ranking_gastos: [...porCategoria.entries()].map(([categoria, value]) => ({ categoria, ...value })).sort((a, b) => b.valor - a.valor), ranking_cotistas: [] })
  } catch (error) { return errorResponse(c, error) }
})

dashboardCotistaRoutes.get('/cotista/relatorio-geral', async (c) => {
  try {
    const db = c.env.SHARE_DB
    const aeronaveId = String(c.req.query('aeronave_id') || '').trim()
    const ano = Number(c.req.query('ano') || new Date().getFullYear())
    if (!aeronaveId || !Number.isInteger(ano) || ano < 2000 || ano > 2100) return c.json({ error: 'aeronave_id_e_ano_validos_obrigatorios' }, 400)

    const schema = await loadSchema(db)
    const holdingColumn = holdingMovementColumn(schema)
    const inicio = `${ano}-01-01`
    const fim = `${ano}-12-31`
    const periodo = (col: string) => `date(${col}) >= date(?) AND date(${col}) <= date(?)`
    const naoCancelado = (col: string) => `UPPER(COALESCE(${col}, '')) <> 'CANCELADO'`
    const lancamentoSemRateio = buildLancamentoSemRateioPredicate(schema)

    const [rateios, lancamentos, rateiosHolding, movimentosHolding, voos, cotistas] = await Promise.all([
      listar(db, `SELECT MIN(r.data_emissao) AS data, MIN(r.categoria_nome) AS categoria, MIN(r.tipo_rateio) AS tipo_rateio, MIN(r.periodicidade) AS periodicidade,
          MIN(r.descricao_despesa) AS descricao, SUM(r.valor_rateado_centavos) AS rateado, MAX(r.valor_total_centavos) AS total
        FROM rateio_despesas r
       WHERE r.aeronave_id = ? AND ${naoCancelado('r.status')} AND ${periodo('r.data_emissao')}
       GROUP BY COALESCE(r.lancamento_id, r.id)`, aeronaveId, inicio, fim),
      listar(db, `SELECT l.data_emissao AS data, l.categoria_nome AS categoria, l.grupo_categoria AS grupo, l.periodicidade, l.descricao, l.valor_centavos
        FROM lancamentos l
       WHERE l.aeronave_id = ? AND UPPER(COALESCE(l.fluxo, '')) = 'SAIDA' AND ${naoCancelado('l.status')} AND ${periodo('l.data_emissao')}
         AND ${lancamentoSemRateio}`, aeronaveId, inicio, fim),
      listar(db, `SELECT MIN(r.data_emissao) AS data, MIN(r.categoria_nome) AS categoria, MIN(r.tipo_rateio) AS tipo_rateio, MIN(r.periodicidade) AS periodicidade,
          MIN(r.descricao_despesa) AS descricao, SUM(r.valor_rateado_centavos) AS rateado
        FROM rateio_hold r
       WHERE r.aeronave_id = ? AND ${naoCancelado('r.status')} AND ${periodo('r.data_emissao')}
       GROUP BY COALESCE(r.${holdingColumn}, r.id)`, aeronaveId, inicio, fim),
      listar(db, `SELECT mh.data_emissao AS data, mh.categoria_nome AS categoria, mh.grupo_categoria AS grupo, mh.periodicidade, mh.descricao, mh.valor_centavos
        FROM movimentos_holding mh
       WHERE mh.aeronave_id = ? AND mh.tipo_caixa = 'HOLD' AND UPPER(COALESCE(mh.fluxo, '')) = 'SAIDA' AND ${naoCancelado('mh.status')} AND ${periodo('mh.data_emissao')}
         AND NOT EXISTS (SELECT 1 FROM rateio_hold rh WHERE rh.${holdingColumn} = mh.id AND ${naoCancelado('rh.status')})`, aeronaveId, inicio, fim),
      listar(db, `SELECT substr(l.data_registro, 1, 7) AS mes, COALESCE(SUM(l.tempo_voo), 0) AS h_voo, COALESCE(SUM(l.tempo_total), 0) AS h_ttl,
          COALESCE(SUM(l.pousos_total), 0) AS pousos, COALESCE(SUM(l.distancia_nm), 0) AS distancia_nm,
          COALESCE(SUM(l.litros_combustivel_abastecido), 0) AS litros, COUNT(DISTINCT date(l.data_registro)) AS dias_voo
        FROM lancamentos_diario_bordo l
       WHERE l.aeronave_id = ? AND ${periodo('l.data_registro')}
       GROUP BY substr(l.data_registro, 1, 7)`, aeronaveId, inicio, fim),
      db.prepare('SELECT COUNT(*) AS n FROM cotista_aeronave WHERE aeronave_id = ?').bind(aeronaveId).first<{ n: number }>(),
    ])

    const custos: CustoBruto[] = [
      ...rateios.map((r) => ({ ...r, valor_centavos: Number(r.rateado) }) as CustoBruto),
      ...lancamentos as unknown as CustoBruto[],
      ...rateiosHolding.map((r) => ({ ...r, valor_centavos: Number(r.rateado) }) as CustoBruto),
      ...movimentosHolding as unknown as CustoBruto[],
    ]
    return c.json(montarRelatorioGeral(custos, voos as unknown as VooMes[], ano, Number(cotistas?.n ?? 0)))
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
