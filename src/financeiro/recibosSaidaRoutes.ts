import { Hono } from "hono"
import { issueRevenue, settleReceivable } from "./FinanceiroKernel"
import { errorResponse } from "./errorResponse"
import { requireCaixaShareAccess } from "./access"
import { listar } from "./repositories/d1"

type Bindings = { SHARE_DB: D1Database; SHARE_FILES?: R2Bucket; FILES?: R2Bucket }
type Variables = { userId: string | null }

export const recibosSaidaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function storage(c: any): R2Bucket | undefined { return c.env.SHARE_FILES || c.env.FILES }
async function alocarNumeroReciboSaida(db: D1Database, cotistaId: string, dataEmissao: string, codigoInformado?: unknown): Promise<string> {
  const cotista = await db.prepare(`
    SELECT COALESCE(ca.codigo_cliente, cl.codigo_cliente, 'CLI') AS codigo_cliente
    FROM cotista_aeronave ca
    LEFT JOIN cliente cl ON cl.id = ca.cliente_id
    WHERE ca.id = ?
    LIMIT 1
  `).bind(cotistaId).first<{ codigo_cliente: string | null }>()
  const codigo = String(codigoInformado ?? cotista?.codigo_cliente ?? 'CLI').trim().toUpperCase() || 'CLI'
  const anoCompleto = dataEmissao.slice(0, 4)
  const anoCurto = anoCompleto.slice(-2)
  const anoCadastrado = await db.prepare('SELECT ano, proximo_numero FROM sequencia_numeros_recibo_saida WHERE codigo_cliente = ? AND ano IN (?, ?) ORDER BY CASE WHEN ano = ? THEN 0 ELSE 1 END LIMIT 1').bind(codigo, anoCompleto, anoCurto, anoCompleto).first<{ ano: string; proximo_numero: number | null }>()
  const ano = anoCadastrado?.ano ?? anoCompleto
  // Recibos de saída têm uma sequência própria, independente de
  // sequencia_numeros_recibos. A sequência começa em 1 e deve respeitar o
  // próximo número já gravado para o código/ano, sem aplicar o piso 101 ou
  // recalcular com base em números antigos da tabela de recibos.
  const proximoConfigurado = Math.max(Number(anoCadastrado?.proximo_numero || 1), 1)
  const proximoNumero = proximoConfigurado
  const sequencia = await db.prepare(`
    INSERT INTO sequencia_numeros_recibo_saida (id, cotista_aeronave_id, codigo_cliente, ano, proximo_numero)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(codigo_cliente, ano) DO UPDATE SET cotista_aeronave_id = excluded.cotista_aeronave_id, proximo_numero = excluded.proximo_numero
    RETURNING proximo_numero - 1 AS numero
  `).bind(crypto.randomUUID(), cotistaId, codigo, ano, proximoNumero + 1).first<{ numero: number }>()
  if (!sequencia) throw new Error('falha_ao_gerar_sequencia_recibo_saida')
  return `REC-${codigo}${String(sequencia.numero).padStart(3, '0')}/${anoCurto}`
}


recibosSaidaRoutes.get('/recibos-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const rows = await listar(c.env.SHARE_DB, 'SELECT * FROM recibos_saida ORDER BY date(data_emissao) DESC, criado_em DESC LIMIT 500')
    return c.json({ recibos: rows })
  } catch (error) { return errorResponse(c, error) }
})

recibosSaidaRoutes.post('/recibos-saida', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const body = await c.req.json<Record<string, unknown>>()
    const cotistaId = String(body.cotista_aeronave_id ?? body.cotista_id ?? '').trim()
    const aeronaveId = String(body.aeronave_id ?? '').trim()
    const valor = Number(body.valor_total ?? body.valor ?? 0)
    const dataEmissao = String(body.data_emissao ?? '').trim()
    const dataVencimento = String(body.data_vencimento ?? dataEmissao).trim()
    const descricao = String(body.descricao_servico ?? body.descricao ?? '').trim()
    if (!cotistaId || !aeronaveId || !(valor > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dataEmissao) || !descricao) {
      return c.json({ error: 'cotista_aeronave_id, aeronave_id, valor_total, data_emissao e descricao_servico são obrigatórios' }, 400)
    }
    const cotista = await c.env.SHARE_DB.prepare("SELECT id, aeronave_id FROM cotista_aeronave WHERE id = ? AND COALESCE(status, 'ativo') <> 'inativo'").bind(cotistaId).first<{ id: string; aeronave_id: string | null }>()
    if (!cotista) return c.json({ error: 'cotista_aeronave_invalido' }, 400)
    const aeronaveIdD1 = String(cotista.aeronave_id ?? '').trim()
    const aeronave = aeronaveIdD1
      ? await c.env.SHARE_DB.prepare('SELECT id FROM aeronave WHERE id = ?').bind(aeronaveIdD1).first<{ id: string }>()
      : null
    if (!aeronave) return c.json({ error: 'aeronave_do_cotista_invalida' }, 400)
    if (aeronaveId !== aeronaveIdD1) return c.json({ error: 'aeronave_nao_corresponde_ao_cotista' }, 400)

    const categoriaInformada = String(body.categoria_receita_id ?? body.categoria_id ?? '').trim()
    const categoriaExiste = categoriaInformada
      ? Boolean(await c.env.SHARE_DB.prepare('SELECT id FROM categoria_movimentacao_share WHERE id = ?').bind(categoriaInformada).first())
      : false
    if (categoriaInformada && !categoriaExiste) return c.json({ error: 'categoria_receita_invalida' }, 400)
    const categoriaClienteInformada = String(body.categoria_cliente_id ?? body.categoria_despesa_id ?? '').trim()
    const categoriaClienteExiste = categoriaClienteInformada
      ? Boolean(await c.env.SHARE_DB.prepare('SELECT id FROM categoria_movimentacao_cliente WHERE id = ?').bind(categoriaClienteInformada).first())
      : false
    if (categoriaClienteInformada && !categoriaClienteExiste) return c.json({ error: 'categoria_despesa_invalida' }, 400)

    const id = crypto.randomUUID()
    const numero = await alocarNumeroReciboSaida(c.env.SHARE_DB, cotistaId, dataEmissao, body.codigo_cliente)
    await issueRevenue(c.env.SHARE_DB, {
      idempotency_key: `recibo_saida:${id}`,
      valor_centavos: Math.round(valor * 100), descricao,
      data_emissao: dataEmissao, data_vencimento: dataVencimento,
      aeronave_id: aeronaveIdD1, cotista_aeronave_id: cotistaId,
      categoria_id: categoriaExiste ? categoriaInformada : null,
      categoria_cliente_id: categoriaClienteInformada || null,
      categoria_cliente_nome: body.categoria_cliente_nome ?? body.categoria_despesa_subcategoria ?? null,
      categoria_nome: body.categoria_receita_nome ?? body.nome_categoria,
      numero_recibo: numero,
      origem_tipo: 'RECIBO_SAIDA', origem_id: id,
      periodicidade: 'MENSAL',
    }, c.get('userId') || null, {}, ({ lancamentoId, contaReceberId, lancamentoClienteId }) => {
      const statements: D1PreparedStatement[] = []
      if (lancamentoClienteId) statements.push(c.env.SHARE_DB.prepare(`
        UPDATE rateio_despesas
        SET percentual_sociedade = COALESCE((SELECT percentual_sociedade FROM cotista_aeronave WHERE id = ?), 100),
            percentual_uso = 100,
            periodicidade = 'MENSAL',
            valor_pago_real_centavos = 0,
            status = 'AGUARDANDO_REEMBOLSO',
            atualizado_em = CURRENT_TIMESTAMP
        WHERE lancamento_id = ?
      `).bind(cotistaId, lancamentoClienteId))
      statements.push(c.env.SHARE_DB.prepare(`INSERT INTO recibos_saida
      (id, numero_recibo, cotista_id, aeronave_id, valor_total, percentual, descricao_servico,
       nome_categoria, categoria_id, subcategoria_1, data_emissao, data_vencimento,
       status, contas_areceber_id, lancamentos_id, criado_por)
      VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, ?, 'EM_ABERTO', ?, ?, ?)`)
      .bind(id, numero, cotistaId, aeronaveIdD1, valor, descricao,
        body.categoria_receita_nome ?? body.nome_categoria ?? null,
        categoriaExiste ? categoriaInformada : null,
        body.categoria_despesa_subcategoria ?? null, dataEmissao, dataVencimento,
        contaReceberId, lancamentoId, c.get('userId') || null))
      statements.push(c.env.SHARE_DB.prepare('UPDATE contas_areceber SET recibos_saida_id = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(id, contaReceberId))
      return statements
    })
    const recibo = await c.env.SHARE_DB.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(id).first()
    return c.json({ recibo }, 201)
  } catch (error) { return errorResponse(c, error) }
})

recibosSaidaRoutes.patch('/recibos-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const body = await c.req.json<Record<string, unknown>>()
    const pdfUrl = String(body.pdf_url ?? '').trim()
    if (!pdfUrl) return c.json({ error: 'pdf_url_obrigatorio' }, 400)
    const result = await c.env.SHARE_DB.prepare('UPDATE recibos_saida SET pdf_url = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(pdfUrl, c.req.param('id')).run()
    if (!result.meta.changes) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)
    const recibo = await c.env.SHARE_DB.prepare('SELECT numero_recibo, lancamentos_id FROM recibos_saida WHERE id = ?').bind(c.req.param('id')).first<{ numero_recibo: string | null; lancamentos_id: string | null }>()
    const principalId = String(recibo?.lancamentos_id ?? '').trim()
    const principal = principalId ? await c.env.SHARE_DB.prepare('SELECT id FROM lancamentos WHERE id = ?').bind(principalId).first<{ id: string }>() : null
    const cliente = principal ? await c.env.SHARE_DB.prepare('SELECT id FROM lancamentos WHERE origem_id = ? AND tipo_caixa = ? LIMIT 1').bind(principal.id, 'CLIENTE').first<{ id: string }>() : null
    const ids = [principal?.id, cliente?.id].filter((id): id is string => Boolean(id))
    for (const lancamentoId of ids) {
      await c.env.SHARE_DB.prepare(`UPDATE lancamentos SET numero_recibo = ?, url_recibo = ?, origem_tipo = CASE WHEN tipo_caixa = 'CLIENTE' THEN 'RECIBO_SAIDA' ELSE origem_tipo END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).bind(recibo?.numero_recibo ?? null, pdfUrl, lancamentoId).run()
      await c.env.SHARE_DB.prepare('UPDATE rateio_despesas SET numero_recibo = ?, url_recibo = ? WHERE lancamento_id = ?').bind(recibo?.numero_recibo ?? null, pdfUrl, lancamentoId).run()
    }
    const reciboAtualizado = await c.env.SHARE_DB.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(c.req.param('id')).first()
    return c.json({ recibo: reciboAtualizado })
  } catch (error) { return errorResponse(c, error) }
})

recibosSaidaRoutes.delete('/recibos-saida/:id', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const db = c.env.SHARE_DB
    const reciboId = c.req.param('id')
    const recibo = await db.prepare('SELECT * FROM recibos_saida WHERE id = ?').bind(reciboId).first<Record<string, unknown>>()
    if (!recibo) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)

    const contaId = String(recibo.contas_areceber_id ?? '').trim()
    const reciboLancamentoId = String(recibo.lancamentos_id ?? '').trim()
    const conta = contaId
      ? await db.prepare('SELECT lancamentos_id, movimentos_id FROM contas_areceber WHERE id = ?').bind(contaId).first<{ lancamentos_id: string | null; movimentos_id: string | null }>()
      : null
    const lancamentoIds = [...new Set([reciboLancamentoId, conta?.lancamentos_id ?? ''].filter(Boolean))]
    const movimentoIds = [...new Set([conta?.movimentos_id ?? '', reciboLancamentoId].filter(Boolean))]
    if (reciboLancamentoId) {
      const espelho = await listar(db, 'SELECT id FROM lancamentos WHERE origem_id = ?', reciboLancamentoId)
      lancamentoIds.push(...espelho.map((row) => String(row.id)).filter(Boolean))
    }
    const ids = [...new Set(lancamentoIds)]
    const movimentos = [...new Set(movimentoIds)]
    const placeholders = ids.map(() => '?').join(', ')
    const movimentoPlaceholders = movimentos.map(() => '?').join(', ')
    const rateioIds = ids.length
      ? (await listar(db, `SELECT id FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`, ...ids)).map((row) => String(row.id)).filter(Boolean)
      : []

    const statements: D1PreparedStatement[] = []
    if (ids.length) statements.push(db.prepare(`DELETE FROM financeiro_vinculos WHERE (origem_id IN (${placeholders}) OR destino_id IN (${placeholders}) OR origem_id = ? OR destino_id = ?)`).bind(...ids, ...ids, reciboId, reciboId))
    else statements.push(db.prepare('DELETE FROM financeiro_vinculos WHERE origem_id = ? OR destino_id = ?').bind(reciboId, reciboId))
    if (rateioIds.length) {
      const rateioPlaceholders = rateioIds.map(() => '?').join(', ')
      statements.push(db.prepare(`DELETE FROM rateio_pagamentos WHERE rateio_id IN (${rateioPlaceholders})`).bind(...rateioIds))
    }
    if (ids.length) statements.push(db.prepare(`DELETE FROM rateio_despesas WHERE lancamento_id IN (${placeholders})`).bind(...ids))
    if (movimentos.length) statements.push(db.prepare(`DELETE FROM rateio_hold WHERE movimento_id IN (${movimentoPlaceholders})`).bind(...movimentos))
    if (contaId) statements.push(db.prepare('UPDATE contas_areceber SET recibos_saida_id = NULL WHERE id = ?').bind(contaId))
    if (contaId) statements.push(db.prepare('DELETE FROM contas_areceber WHERE id = ?').bind(contaId))
    statements.push(db.prepare('DELETE FROM recibos_saida WHERE id = ?').bind(reciboId))
    if (ids.length) statements.push(db.prepare(`DELETE FROM lancamentos WHERE id IN (${placeholders})`).bind(...ids))
    if (movimentos.length) statements.push(db.prepare(`DELETE FROM movimentos_holding WHERE id IN (${movimentoPlaceholders})`).bind(...movimentos))
    await db.batch(statements)

    const pdfUrl = String(recibo.pdf_url ?? '')
    if (pdfUrl) {
      try {
        const parsed = new URL(pdfUrl)
        const key = parsed.searchParams.get('key') || decodeURIComponent(parsed.pathname.replace(/^\//, ''))
        if (key) await storage(c)?.delete(key)
      } catch (error) {
        console.warn('[financeiro] não foi possível excluir o PDF do recibo:', error)
      }
    }
    return c.json({ ok: true, id: reciboId })
  } catch (error) { return errorResponse(c, error) }
})

recibosSaidaRoutes.post('/recibos-saida/:id/dar-baixa', async (c) => {
  try {
    const denied = await requireCaixaShareAccess(c); if (denied) return denied
    const reciboId = c.req.param('id')
    const recibo = await c.env.SHARE_DB.prepare('SELECT contas_areceber_id FROM recibos_saida WHERE id = ?').bind(reciboId).first<{ contas_areceber_id: string | null }>()
    if (!recibo) return c.json({ error: 'recibo_saida_nao_encontrado' }, 404)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const contaId = String(recibo.contas_areceber_id ?? '').trim()
    if (!contaId) return c.json({ error: 'conta_a_receber_nao_vinculada' }, 409)
    const result = await settleReceivable(c.env.SHARE_DB, contaId, {
      data_recebimento: body.data_recebimento ?? body.data_pagamento ?? body.dataRecebimento,
      conta_bancaria_id: body.conta_bancaria_id ?? body.conta_bancaria ?? body.bancoRecebimento,
      forma_pagamento: body.forma_pagamento ?? body.formaPagamento,
      comprovante_url: body.comprovante_url ?? body.comprovanteRecebimentoUrl,
      pagamentos: body.pagamentos,
    }, c.get('userId') || null)
    return c.json({ ok: true, conta: result })
  } catch (error) { return errorResponse(c, error) }
})
