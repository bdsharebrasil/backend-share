import { Hono } from 'hono'
import { listarTodos } from './repositories/d1'
import { errorResponse } from './errorResponse'
import { calcularBalancoMensal, type RateioBalanco, type PagamentoBalanco, type AjusteBalanco } from './balancoMensal'

type Bindings = { SHARE_DB: D1Database }
type Variables = { userId: string | null }
export const balancoMensalRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const competencia = (v: unknown) => { const s = String(v || '').slice(0, 10); return s.length === 7 ? `${s}-01` : s }
export function limitesMes(mes: string) {
  if (!/^(20\d{2})-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('Competência inválida (2000 a 2099)')
  const [ano, m] = mes.split('-').map(Number)
  return { inicio: `${mes}-01`, fim: new Date(Date.UTC(ano, m, 0)).toISOString().slice(0, 10) }
}
export async function carregarDadosBalancoMensal(db: D1Database, aeronaveId: string, fim: string) {
  const [participantesDB, rows, eventos, ajustesDB, movimentos] = await Promise.all([
    listarTodos(db, `SELECT ca.id, ca.socio_id, ca.cliente_id, COALESCE(hs.nome,cl.razao_social,ca.codigo_cliente,ca.id) AS nome,
      CASE WHEN ca.socio_id IS NULL THEN 'CLIENTES' ELSE 'HOLD:' || hs.holding_id END AS dominio
      FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id=ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id=ca.socio_id WHERE ca.aeronave_id=? ORDER BY ca.id`, aeronaveId),
    // Data de emissão é a competência do fechamento, inclusive antes de
    // migrar a view legada que ainda pode conter data do demonstrativo.
    listarTodos(db, `SELECT v.*, COALESCE(
      (SELECT r.data_emissao FROM rateio_despesas r WHERE v.id = 'CLIENTE:' || r.id),
      (SELECT h.data_emissao FROM rateio_hold h WHERE v.id = 'HOLD:' || h.id)
    ) AS emissao FROM vw_balanco_rateios v WHERE v.aeronave_id=? ORDER BY v.id`, aeronaveId),
    listarTodos(db, `SELECT p.* FROM rateio_pagamentos p JOIN rateio_despesas r ON r.id=p.rateio_id
      WHERE r.aeronave_id=? ORDER BY p.id`, aeronaveId),
    listarTodos(db, 'SELECT * FROM balanco_ajustes WHERE aeronave_id=? ORDER BY rowid', aeronaveId),
    listarTodos(db, `SELECT * FROM movimentos_holding WHERE aeronave_id=? AND tipo_caixa='HOLD'
      AND COALESCE(escopo_financeiro,'FINANCEIRO')='FINANCEIRO' ORDER BY id`, aeronaveId),
  ])
  const participantes = participantesDB.map(p => ({ id: String(p.id), nome: String(p.nome), dominio: String(p.dominio) }))
  const aliases = new Map<string, string | null>(participantes.map(p => [p.id, p.id]))
  // Nunca resolver por nome: IDs antigos de sócio são convertidos para cotista_aeronave.id.
  for (const p of participantesDB) for (const valor of [p.socio_id, p.cliente_id]) {
    if (!valor) continue
    const chave = String(valor), id = String(p.id)
    aliases.set(chave, !aliases.has(chave) || aliases.get(chave) === id ? id : null)
  }
  const rateios: RateioBalanco[] = rows.map(r => ({
    id: String(r.id), participanteId: String(r.participante_id), dominio: String(r.dominio), origemChave: String(r.origem_chave),
    competencia: competencia(r.emissao), categoria: String(r.categoria_nome || 'Sem categoria'), descricao: String(r.descricao_despesa || ''),
    tipo: String(r.tipo_rateio), devido: Number(r.valor_rateado_centavos), pagoReal: Number(r.valor_pago_real_centavos),
    pagadorId: aliases.get(String(r.pago_por || '')) || null, direto: Number(r.pago_diretamente) === 1,
    dataPagamento: r.data_pagamento ? String(r.data_pagamento).slice(0,10) : null, status: String(r.status || ''),
  }))
  const pagamentos: PagamentoBalanco[] = eventos.map(p => ({ id: String(p.id), rateioId: `CLIENTE:${p.rateio_id}`,
    pagadorId: p.tipo_pagador === 'COTISTA' ? aliases.get(String(p.pagador_cotista_id)) || null : null,
    valor: Number(p.valor_centavos), data: String(p.data_pagamento).slice(0,10), status: String(p.status), tipoPagador: String(p.tipo_pagador || '') }))
  const ajustes: AjusteBalanco[] = ajustesDB.map(a => ({ id: String(a.id), origemRateioId: String(a.origem_rateio_id),
    destinoRateioId: String(a.destino_rateio_id), valor: Number(a.valor_centavos), motivo: String(a.motivo) }))
  const acumulado = calcularBalancoMensal(participantes, rateios, pagamentos, ajustes, '2000-01-01', fim)
  const holdings = [...new Set(participantes.filter(p => p.dominio.startsWith('HOLD:')).map(p => p.dominio))].map(dominio => {
    let saldoMovimentosAeronaveCentavos = 0, aportesSemSocioCentavos = 0
    const aportes = new Map<string, number>()
    for (const m of movimentos) {
      if (`HOLD:${m.holding_id}` !== dominio || Number(m.pago_diretamente) === 1) continue
      if (!['PAGO','RECEBIDO','REEMBOLSADO','ENTRADA','APORTE_MENSAL','RENDIMENTO_BANCARIO'].includes(String(m.status).toUpperCase())) continue
      const data = String(m.data_pagamento || '').slice(0,10)
      if (!data || data > fim) continue
      const valor = Number(m.valor_centavos), fluxo = String(m.fluxo).toUpperCase()
      const entrada = ['ENTRADA','APORTE','ESTORNO'].includes(fluxo)
      saldoMovimentosAeronaveCentavos += entrada ? valor : -valor
      // Só aporte é contribuição pessoal; rendimento não é novo pagamento do sócio.
      if (fluxo === 'APORTE') {
        const socio = aliases.get(String(m.socio_id))
        if (socio) aportes.set(socio, (aportes.get(socio) || 0) + valor)
        else aportesSemSocioCentavos += valor
      }
    }
    return { dominio, saldoMovimentosAeronaveCentavos, aportesSemSocioCentavos,
      socios: acumulado.saldos.filter(s => s.dominio === dominio).map(s => ({ ...s,
        aporteCentavos: aportes.get(s.id) || 0,
        posicaoCentavos: (aportes.get(s.id) || 0) + s.pagoCentavos - s.devidoCentavos,
      })) }
  })
  return { participantes, rateios, pagamentos, ajustes, holdings }
}

balancoMensalRoutes.get('/cotista/balanco-mensal', async c => {
  const aeronaveId = String(c.req.query('aeronave_id') || '')
  let periodo: { inicio: string; fim: string }
  try { periodo = limitesMes(String(c.req.query('competencia') || '')) }
  catch { return c.json({ error: 'competencia_invalida' }, 400) }
  if (!aeronaveId) return c.json({ error: 'aeronave_id_obrigatorio' }, 400)
  try {
    const dados = await carregarDadosBalancoMensal(c.env.SHARE_DB, aeronaveId, periodo.fim)
    const balanco = calcularBalancoMensal(dados.participantes, dados.rateios, dados.pagamentos, dados.ajustes, periodo.inicio, periodo.fim)
    return c.json({ ...balanco, aeronaveId, holdings: dados.holdings })
  } catch (e) { return errorResponse(c, e) }
})

balancoMensalRoutes.post('/cotista/balanco-ajustes', async c => {
  // Montar somente sob /api/financeiro, após o middleware financeiro existente.
  const usuario = c.get('userId')
  if (!usuario) return c.json({ error: 'nao_autorizado' }, 401)
  let b: Record<string, unknown>
  try { b = await c.req.json() } catch { return c.json({ error: 'json_invalido' }, 400) }
  if (!b.aeronave_id || !b.origem_rateio_id || !b.destino_rateio_id || !b.idempotency_key
      || typeof b.valor_centavos !== 'number' || !Number.isSafeInteger(b.valor_centavos) || b.valor_centavos <= 0
      || String(b.motivo || '').trim().length < 5) return c.json({ error: 'ajuste_invalido' }, 400)
  const db = c.env.SHARE_DB
  try {
    const anterior = await db.prepare('SELECT * FROM balanco_ajustes WHERE idempotency_key=?').bind(b.idempotency_key).first<Record<string,unknown>>()
    if (anterior) {
      const igual = anterior.aeronave_id === b.aeronave_id && anterior.origem_rateio_id === b.origem_rateio_id
        && anterior.destino_rateio_id === b.destino_rateio_id && anterior.valor_centavos === b.valor_centavos
        && anterior.motivo === String(b.motivo).trim()
      return igual ? c.json({ success: true, id: anterior.id, idempotente: true }) : c.json({ error: 'chave_reutilizada_com_outro_ajuste' }, 409)
    }
    const origem = await db.prepare('SELECT * FROM vw_balanco_rateios WHERE id=? AND aeronave_id=?')
      .bind(b.origem_rateio_id, b.aeronave_id).first<Record<string,unknown>>()
    if (!origem) return c.json({ error: 'rateio_nao_encontrado' }, 404)
    const id = crypto.randomUUID()
    // O trigger valida saldo ATOMICAMENTE com a escrita, incluindo concorrência.
    await db.prepare(`INSERT INTO balanco_ajustes
      (id,aeronave_id,competencia,dominio,origem_rateio_id,destino_rateio_id,valor_centavos,motivo,criado_por,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id,b.aeronave_id,origem.competencia,origem.dominio,
      b.origem_rateio_id,b.destino_rateio_id,b.valor_centavos,String(b.motivo).trim(),usuario,b.idempotency_key).run()
    return c.json({ success: true, id }, 201)
  } catch(e) {
    if (String(e).includes('ajuste_incompativel_ou_saldo_insuficiente')) return c.json({ error: 'ajuste_incompativel_ou_saldo_insuficiente' },409)
    return errorResponse(c,e)
  }
})
