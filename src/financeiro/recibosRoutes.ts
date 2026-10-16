import { Hono } from "hono"
import { allocateCentsByPercentages, emitirReciboColaborador, emitirReciboPagamento, emitirReciboReembolso, emitirReciboSaida, enviarReciboPagamentoParaRateio, programarReciboReembolso, validateFinanceSchema } from "./FinanceiroKernel"
import { errorResponse } from "./errorResponse"
import { listar } from "./repositories/d1"

type Bindings = { SHARE_DB: D1Database; FILES?: R2Bucket; SHARE_FILES?: R2Bucket; R2_PUBLIC_URL?: string }
type Variables = { userId: string | null }

export const recibosRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function storage(c: any): R2Bucket | undefined { return c.env.SHARE_FILES || c.env.FILES }
function publicStorageUrl(c: any, key: string): string { const publicBase = String(c.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, ''); if (!publicBase) throw new Error('R2_PUBLIC_URL_nao_configurada'); return `${publicBase}/${key.split('/').map((segment: string) => encodeURIComponent(segment)).join('/')}` }

recibosRoutes.post('/recibos', async (c) => {
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

recibosRoutes.post('/recibos/gerar-demonstrativo', async (c) => {
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

recibosRoutes.get('/recibos', async (c) => {
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
    ? await listar(db, `
        SELECT DISTINCT l.origem_id AS recibo_id
          FROM rateio_despesas rd
          INNER JOIN lancamentos l ON l.id = rd.lancamento_id
         WHERE l.origem_tipo = 'RECIBO' AND l.origem_id IN (${reciboIds.map(() => '?').join(', ')})
        UNION
        SELECT DISTINCT recibo_id AS recibo_id
          FROM recibo_rateio
         WHERE recibo_id IN (${reciboIds.map(() => '?').join(', ')})
        UNION
        SELECT DISTINCT origem_id AS recibo_id
          FROM rateio_hold
         WHERE origem_tipo = 'RECIBO' AND origem_id IN (${reciboIds.map(() => '?').join(', ')})
      `, ...reciboIds, ...reciboIds, ...reciboIds).catch(() => [])
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

recibosRoutes.get('/recibos/opcoes', async (c) => {
  const db = c.env.SHARE_DB
  const read = async (sql: string) => (await db.prepare(sql).all().catch((error) => { console.warn('[financeiro/lancamentos] consulta opcional indisponível', error); return { results: [] } })).results ?? []
  const [clientes, colaboradores, freelancers, aeronaves, cotistas, categorias, categoriasCliente, abastecimentos, fornecedoresFavoritos, fornecedoresCombustivel] = await Promise.all([
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
    read("SELECT id, COALESCE(apelido, nome_completo) AS nome, nome_completo, 'favorito' AS origem FROM fornecedores_favoritos ORDER BY COALESCE(apelido, nome_completo)"),
    read("SELECT id, nome_fornecedor AS nome, nome_fornecedor, 'combustivel' AS origem FROM fornecedores_combustivel ORDER BY nome_fornecedor"),
    read(`SELECT a.id, a.aeronave_id, a.data, a.tipo_combustivel, a.trecho, a.local,
                 a.numero_comanda, a.numero_nf, a.litros, a.valor_total,
                 ar.matricula_registro,
                 COALESCE(cl.razao_social, hs.nome, 'Cotista não informado') AS cotista_nome
            FROM abastecimentos a
            LEFT JOIN aeronave ar ON ar.id = a.aeronave_id
            LEFT JOIN cliente cl ON cl.id = a.cliente_id
            LEFT JOIN hold_socios hs ON hs.id = a.socio_id
           WHERE UPPER(COALESCE(a.status, '')) NOT IN ('CANCELADO', 'CANCELADA')
             AND NOT EXISTS (
               SELECT 1 FROM financeiro_vinculos fv
                WHERE fv.origem_tipo = 'RECIBO'
                  AND fv.destino_tipo = 'ABASTECIMENTO'
                  AND fv.tipo_vinculo = 'RECIBO_ABASTECIMENTO'
                  AND fv.destino_id = a.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM lancamentos l
                WHERE l.abastecimentos_id = a.id
                  AND l.tipo_caixa = 'CLIENTE'
                  AND UPPER(COALESCE(l.status, '')) <> 'CANCELADO'
             )
             AND COALESCE(a.valor_total, 0) > 0
           ORDER BY date(a.data) DESC, a.id DESC LIMIT 300`),
  ])
  const recebedores = [
    ...colaboradores.map((item: any) => ({ ...item, id: `perfil:${item.id}`, nome: item.nome_completo || item.nome_exibicao || item.email || '', tipo_user: item.tipo_user || 'colaborador' })),
    ...freelancers.map((item: any) => ({ ...item, id: `freelancer:${item.id}`, nome: item.nome_completo || '', tipo_user: 'freelancer' })),
  ].sort((a: any, b: any) => String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR'))
  return c.json({ clientes, colaboradores, freelancers, aeronaves, cotistas, categorias, categorias_cliente: categoriasCliente, abastecimentos, fornecedores: [...fornecedoresFavoritos, ...fornecedoresCombustivel], recebedores })
})

recibosRoutes.patch('/recibos/:id/status', async (c) => {
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

recibosRoutes.post('/recibos/:id/enviar-despesa-rateio', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const result = await enviarReciboPagamentoParaRateio(c.env.SHARE_DB, c.req.param('id'), c.get('userId') || null, body)
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) { return errorResponse(c, error) }
})

recibosRoutes.post('/recibos/:id/programar-contas-apagar', async (c) => {
  try {
    const reciboId = c.req.param('id')
    const body = await c.req.json<Record<string, unknown>>()
    const receiptInicial = await c.env.SHARE_DB.prepare('SELECT id, tipo_recibo, status, categoria_movimentacao_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4 FROM recibos WHERE id = ?').bind(reciboId).first<Record<string, unknown>>()
    if (!receiptInicial) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    if (String(receiptInicial.status).toUpperCase() !== 'EMAIL_ENVIADO') return c.json({ error: 'recibo_precisa_ser_enviado_por_email' }, 409)
    const camposSubcategoria = ['subcategoria_1', 'subcategoria_2', 'subcategoria_3', 'subcategoria_4'] as const
    const categoriaId = String(body.categoria_id ?? receiptInicial.categoria_movimentacao_id ?? '').trim()
    const categoriaCliente = categoriaId
      ? await c.env.SHARE_DB.prepare(`
          SELECT id, nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4
            FROM categoria_movimentacao_cliente
           WHERE id = ?
           LIMIT 1
        `).bind(categoriaId).first<Record<string, unknown>>()
      : null
    if (!categoriaCliente) return c.json({ error: 'categoria_cliente_nao_encontrada' }, 400)

    const subcategoriasInformadas = [...new Set(
      camposSubcategoria
        .map((campo) => String(body[campo] ?? receiptInicial[campo] ?? '').trim())
        .filter(Boolean),
    )]
    if (subcategoriasInformadas.length > 1) return c.json({ error: 'subcategorias_inconsistentes' }, 400)

    const subcategoriasPayload: Record<(typeof camposSubcategoria)[number], string | null> = {
      subcategoria_1: null,
      subcategoria_2: null,
      subcategoria_3: null,
      subcategoria_4: null,
    }
    const subcategoriaSelecionada = subcategoriasInformadas[0]
    if (subcategoriaSelecionada) {
      const correspondencias = camposSubcategoria.filter(
        (campo) => String(categoriaCliente[campo] ?? '').trim() === subcategoriaSelecionada,
      )
      if (correspondencias.length !== 1) return c.json({ error: 'subcategoria_cliente_invalida' }, 400)
      const campo = correspondencias[0]
      subcategoriasPayload[campo] = String(categoriaCliente[campo]).trim()
    }

    const bodyNormalizado = {
      ...body,
      categoria_id: categoriaId,
      categoria_nome: String(categoriaCliente.nome ?? receiptInicial.categoria_nome ?? '').trim() || null,
      ...subcategoriasPayload,
      data_vencimento: body.data_vencimento,
    }
    const reembolso = await programarReciboReembolso(c.env.SHARE_DB, reciboId, bodyNormalizado, c.get('userId') || null)
    const lancamentoShareId = String(reembolso.lancamento_share_id ?? reembolso.lancamento_origem_id ?? '').trim()
    const lancamentoClienteId = String(reembolso.lancamento_cliente_id ?? '').trim()
    const receipt = await c.env.SHARE_DB.prepare(`SELECT id, lancamento_id, numero_recibo, aeronave_id, tipo_caixa, status, valor, descricao, data_emissao, data_vencimento, categoria_movimentacao_id, grupo_categoria, url_recibo FROM recibos WHERE id = ?`).bind(reciboId).first<Record<string, unknown>>()
    if (!receipt) return c.json({ error: 'recibo_nao_encontrado' }, 404)
    const lancamentoVinculadoId = lancamentoShareId || String(receipt.lancamento_id ?? '').trim()
    const lancamento = lancamentoVinculadoId
      ? await c.env.SHARE_DB.prepare(`SELECT id, status, tipo_caixa, valor_centavos, descricao, aeronave_id, categoria_share_id, categoria_nome, data_emissao, data_vencimento, fornecedores_favoritos_id FROM lancamentos WHERE id = ?`).bind(lancamentoVinculadoId).first<Record<string, unknown>>()
      : await c.env.SHARE_DB.prepare(`SELECT id, status, tipo_caixa, valor_centavos, descricao, aeronave_id, categoria_share_id, categoria_nome, data_emissao, data_vencimento, fornecedores_favoritos_id FROM lancamentos WHERE origem_id = ? AND origem_tipo = 'RECIBO_REEMBOLSO' ORDER BY criado_em DESC LIMIT 1`).bind(reciboId).first<Record<string, unknown>>()
    const lancamentoId = String(lancamento?.id ?? '').trim()
    if (!lancamentoId) return c.json({ error: 'lancamento_do_recibo_nao_encontrado' }, 409)
    if (!lancamento || String(lancamento.tipo_caixa).toUpperCase() !== 'SHARE' || String(lancamento.status).toUpperCase() !== 'EM_ABERTO') return c.json({ error: 'lancamento_share_em_aberto_nao_encontrado' }, 409)
    if (!lancamentoClienteId) return c.json({ error: 'lancamento_cliente_do_reembolso_nao_encontrado' }, 409)
    const lancamentoClienteRateioId = lancamentoClienteId
    const fornecedorId = String(lancamento.fornecedores_favoritos_id ?? body.fornecedor_id ?? body.fornecedores_favoritos_id ?? '').trim() || null
    const existing = await c.env.SHARE_DB.prepare(`SELECT id FROM contas_apagar WHERE lancamentos_id = ? AND status <> 'CANCELADO' LIMIT 1`).bind(lancamentoId).first<{ id: string }>()
    const rateiosExistentes = await c.env.SHARE_DB.prepare(`SELECT id, lancamento_id FROM rateio_despesas WHERE lancamento_id IN (?, ?)`).bind(lancamentoId, lancamentoClienteRateioId).all<{ id: string; lancamento_id: string | null }>().catch(() => ({ results: [] }))
    const rateiosDoCliente = rateiosExistentes.results ?? []
    if (rateiosDoCliente.length) {
      await c.env.SHARE_DB.batch(rateiosDoCliente.map((rateio) => c.env.SHARE_DB.prepare(`UPDATE rateio_despesas
        SET lancamento_id = ?, fornecedor_id = ?, numero_recibo = ?, url_recibo = ? WHERE id = ?`)
        .bind(lancamentoClienteRateioId, fornecedorId, receipt.numero_recibo ?? null, receipt.url_recibo ?? null, rateio.id)))
    }
    const existingRateio = rateiosDoCliente[0] ?? null
    const existingRateioHold = existingRateio
      ? null
      : await c.env.SHARE_DB.prepare(`SELECT id FROM rateio_hold WHERE origem_id = ? AND origem_tipo = 'RECIBO' LIMIT 1`).bind(reciboId).first<{ id: string }>().catch(() => null)
    if (existingRateio || existingRateioHold) {
      if (existing?.id) await c.env.SHARE_DB.prepare(`UPDATE contas_apagar SET boleto_url = COALESCE(?, boleto_url), fornecedor_id = ?, escopo_financeiro = 'CAIXA_SHARE' WHERE id = ?`).bind(body.boleto_url ? String(body.boleto_url) : null, fornecedorId, existing.id).run()
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
    const categoriaIdConta = lancamento.categoria_share_id ?? receipt.categoria_movimentacao_id ?? null
    const categoriaNomeConta = lancamento.categoria_nome ?? receipt.categoria_nome ?? receipt.grupo_categoria ?? null
    const categoriaIdRateio = bodyNormalizado.categoria_id
    const categoriaNomeRateio = bodyNormalizado.categoria_nome
    const descricao = lancamento.descricao ?? receipt.descricao ?? 'Recibo'
    const dataEmissao = lancamento.data_emissao ?? receipt.data_emissao ?? null
    const documentoUrl = receipt.url_recibo ?? null
    const movimentoHoldingId = holdingIds.length ? crypto.randomUUID() : null
    const statements = existing
      ? [c.env.SHARE_DB.prepare(`UPDATE contas_apagar SET boleto_url = COALESCE(?, boleto_url), fornecedor_id = ?, escopo_financeiro = 'CAIXA_SHARE' WHERE id = ?`).bind(body.boleto_url ? String(body.boleto_url) : null, fornecedorId, contaId)]
      : [c.env.SHARE_DB.prepare(`INSERT INTO contas_apagar (id, data_vencimento, valor_centavos, categoria_id, categoria_nome, descricao, aeronave_id, lancamentos_id, boleto_url, nf_url, criado_por, origem_tipo, idempotency_key, status, fornecedor_id, escopo_financeiro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECIBO', ?, 'EM_ABERTO', ?, 'CAIXA_SHARE')`).bind(contaId, dataVencimento, valorCentavos, categoriaIdConta, categoriaNomeConta, descricao, aeronaveId, lancamentoId, body.boleto_url ?? null, null, c.get('userId') || null, `recibo:${reciboId}`, fornecedorId)]
    if (movimentoHoldingId) {
      const cotistaHolding = cotistas.find((cotista) => String(cotista.holding_id) === holdingIds[0])
      statements.push(c.env.SHARE_DB.prepare(`INSERT INTO movimentos_holding (id, holding_id, socio_id, aeronave_id, periodicidade, tipo_caixa, data_emissao, data_vencimento, descricao, categoria_id, categoria_nome, fluxo, valor_centavos, status, pago_diretamente, numero_recibo, url_recibo, observacoes, criado_por) VALUES (?, ?, ?, ?, ?, 'HOLD', ?, ?, ?, ?, ?, 'SAIDA', ?, 'EM_ABERTO', 0, ?, ?, ?, ?)`).bind(movimentoHoldingId, holdingIds[0], cotistaHolding?.socio_id ?? null, aeronaveId, periodicidade, dataEmissao, dataVencimento, descricao, categoriaIdRateio, categoriaNomeRateio, valorCentavos, receipt.numero_recibo ?? null, documentoUrl, body.observacoes ?? null, c.get('userId') || null))
    }
    const valoresRateados = allocateCentsByPercentages(valorCentavos, linhasNormalizadas.map((linha) => linha.percentual_uso))
    linhasNormalizadas.forEach((linha, index) => {
      const cotista = cotistas.find((item) => String(item.id) === String(linha.cotista_id))!
      const percentual = linha.percentual_uso
      const rateado = valoresRateados[index]
      const campos = String(cotista.socio_id ?? '').trim() ? `INSERT INTO rateio_hold (id, movimento_id, aeronave_id, socio_id, data_emissao, data_vencimento, categoria_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4, tipo_rateio, periodicidade, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, status, descricao_despesa, observacoes, origem_id, origem_tipo, documento_url, fornecedor_id, numero_recibo, url_recibo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'EM_ABERTO', ?, ?, ?, 'RECIBO', ?, ?, ?, ?)` : `INSERT INTO rateio_despesas (id, lancamento_id, aeronave_id, cotista_id, data_emissao, data_vencimento, categoria_id, categoria_nome, subcategoria_1, subcategoria_2, subcategoria_3, subcategoria_4, tipo_rateio, periodicidade, percentual_sociedade, percentual_uso, valor_total_centavos, valor_rateado_centavos, valor_pago_real_centavos, status, descricao_despesa, observacoes, documento_url, fornecedor_id, numero_recibo, url_recibo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'EM_ABERTO', ?, ?, ?, ?, ?, ?)`
      const parametros = String(cotista.socio_id ?? '').trim()
        ? [rateioIds[index], movimentoHoldingId, aeronaveId, cotista.socio_id, dataEmissao, dataVencimento, categoriaIdRateio, categoriaNomeRateio, bodyNormalizado.subcategoria_1, bodyNormalizado.subcategoria_2, bodyNormalizado.subcategoria_3, bodyNormalizado.subcategoria_4, tipoRateio, periodicidade, Number(cotista.percentual_sociedade ?? 0), percentual, valorCentavos, rateado, descricao, body.observacoes ?? null, reciboId, documentoUrl, fornecedorId, receipt.numero_recibo ?? null, documentoUrl]
        : [rateioIds[index], lancamentoClienteRateioId, aeronaveId, cotista.id, dataEmissao, dataVencimento, categoriaIdRateio, categoriaNomeRateio, bodyNormalizado.subcategoria_1, bodyNormalizado.subcategoria_2, bodyNormalizado.subcategoria_3, bodyNormalizado.subcategoria_4, tipoRateio, periodicidade, Number(cotista.percentual_sociedade ?? 0), percentual, valorCentavos, rateado, descricao, body.observacoes ?? null, documentoUrl, fornecedorId, receipt.numero_recibo ?? null, documentoUrl]
      statements.push(c.env.SHARE_DB.prepare(campos).bind(...parametros))
    })
    await c.env.SHARE_DB.batch(statements)
    return c.json({ ok: true, conta_pagar_id: contaId, rateio_ids: rateioIds }, 201)
  } catch (error) { return errorResponse(c, error) }
})

recibosRoutes.post('/recibos/:id/cancelar', async (c) => {
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
recibosRoutes.post('/recibos/:id/reativar', async (c) => {
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
recibosRoutes.post('/recibos/:id/reembolso', async (c) => {
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


recibosRoutes.post('/recibos/anexos', async (c) => {
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

recibosRoutes.post('/recibos/demonstrativo', async (c) => {
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

recibosRoutes.post('/recibos/:id/pdf', async (c) => {
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

recibosRoutes.get('/recibos/:id/pdf/arquivo', async (c) => {
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

recibosRoutes.get('/recibos/anexos/:id/arquivo', async (c) => {
  const bucket = storage(c)
  if (!bucket) return c.json({ error: 'storage_nao_configurado' }, 503)
  const row = await c.env.SHARE_DB.prepare('SELECT caminho_arquivo, tipo_arquivo FROM recibo_anexos WHERE id = ?').bind(c.req.param('id')).first<{ caminho_arquivo: string; tipo_arquivo: string }>()
  if (!row) return c.notFound()
  const object = await bucket.get(row.caminho_arquivo)
  if (!object) return c.notFound()
  return c.body(await object.arrayBuffer(), 200, { 'Content-Type': row.tipo_arquivo, 'Cache-Control': 'private, max-age=3600' })
})
recibosRoutes.get('/recibos/:id/anexo-original', async (c) => {
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
