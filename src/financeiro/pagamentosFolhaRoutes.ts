import { Hono } from 'hono'
import {
  idDeterministicoPagamentoFolha,
  parcelaDecimoTerceiro,
  validarRegistroPagamentoFolha,
  type RegistrarPagamentoFolha,
  type RotuloPagamentoFolha,
} from './pagamentosFolha'

type Bindings = {
  SHARE_DB: D1Database
  SHARE_FILES?: R2Bucket
  FILES?: R2Bucket
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
}
type Variables = { userId: string | null }
type PagamentoAtual = {
  id: string
  rotulo: RotuloPagamentoFolha | null
  status: string
  lancamento_status: string | null
}
type EmpresaContexto = { empresaId: string; colaborador: { id: string; nome_completo: string; nome_exibicao: string | null; status: string | null } }

export const pagamentosFolhaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const ROTULOS = new Set<RotuloPagamentoFolha>(['SALARIO', 'FERIAS', '13_P1', '13_P2', 'BENEFICIO', 'HORAS_VOO', 'EXTRA'])
const EXTENSOES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const TAMANHO_MAXIMO_ANEXO = 10 * 1024 * 1024

function erro(c: any, error: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503) {
  return c.json({ error }, status)
}

async function autorizar(c: any): Promise<{ userId: string } | { resposta: Response }> {
  const userId = c.get('userId') as string | null
  const authorization = c.req.header('authorization')
  if (!userId || !authorization?.startsWith('Bearer ')) return { resposta: erro(c, 'nao_autorizado', 401) }

  const base = String(c.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const apiKey = c.env.SUPABASE_ANON_KEY || c.env.VITE_SUPABASE_PUBLISHABLE_KEY || c.env.SUPABASE_SERVICE_ROLE_KEY || c.req.header('apikey')
  if (!base || !apiKey) return { resposta: erro(c, 'autenticacao_indisponivel', 503) }
  let sessao: { id?: string }
  try {
    const response = await fetch(`${base}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: authorization } })
    if (!response.ok) return { resposta: erro(c, 'nao_autorizado', 401) }
    sessao = await response.json() as { id?: string }
  } catch {
    return { resposta: erro(c, 'autenticacao_indisponivel', 503) }
  }
  if (sessao.id !== userId) return { resposta: erro(c, 'nao_autorizado', 401) }

  const role = await c.env.SHARE_DB.prepare(`
    SELECT 1 FROM user_profiles p
     WHERE p.id = ? AND lower(replace(replace(trim(COALESCE(p.tipo_user, '')), ' ', '_'), '-', '_')) IN
       ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster', 'rh')
    UNION ALL
    SELECT 1 FROM usuarios_funcoes f
     WHERE f.user_id = ? AND lower(replace(replace(trim(COALESCE(f.funcao, '')), ' ', '_'), '-', '_')) IN
       ('admin', 'administrador', 'gestor_master', 'gestormaster', 'financeiro_master', 'financeiromaster', 'rh')
    LIMIT 1`).bind(userId, userId).first()
  if (!role) return { resposta: erro(c, 'pagamentos_folha_nao_autorizado', 403) }
  return { userId }
}

async function empresasDoUsuario(db: D1Database, userId: string): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT empresa_id FROM contratos_trabalho WHERE user_id = ? AND upper(COALESCE(status, '')) IN ('ATIVO', 'SUSPENSO')
    UNION
    SELECT empresa_id FROM usuarios_empresas WHERE usuario_id = ? AND upper(COALESCE(status, '')) = 'ATIVO'
  `).bind(userId, userId).all<{ empresa_id: string }>()
  return [...new Set((rows.results ?? []).map((row) => String(row.empresa_id)).filter(Boolean))]
}

async function resolverContextoColaborador(db: D1Database, userId: string, actorId: string): Promise<EmpresaContexto | null> {
  const colaborador = await db.prepare(`
    SELECT id, nome_completo, nome_exibicao, status FROM user_profiles WHERE id = ? LIMIT 1
  `).bind(userId).first<{ id: string; nome_completo: string; nome_exibicao: string | null; status: string | null }>()
  if (!colaborador) return null

  const [empresasColaborador, empresasAtor] = await Promise.all([
    empresasDoUsuario(db, userId),
    empresasDoUsuario(db, actorId),
  ])
  let empresaId: string | undefined
  if (empresasColaborador.length === 1) empresaId = empresasColaborador[0]
  else if (empresasColaborador.length > 1) {
    const coincidentes = empresasColaborador.filter((id) => empresasAtor.includes(id))
    if (coincidentes.length === 1) empresaId = coincidentes[0]
    else return null
  } else if (empresasAtor.length === 1) {
    empresaId = empresasAtor[0]
  } else {
    const empresas = await db.prepare('SELECT id FROM empresa ORDER BY id LIMIT 2').all<{ id: string }>()
    if ((empresas.results ?? []).length === 1) empresaId = empresas.results![0].id
  }
  if (!empresaId) return null
  if (empresasAtor.length && !empresasAtor.includes(empresaId)) return null
  return { empresaId, colaborador }
}

async function validarColaboradorAtivo(db: D1Database, userId: string, actorId: string): Promise<EmpresaContexto | null> {
  const contexto = await resolverContextoColaborador(db, userId, actorId)
  if (!contexto || ['inativo', 'inactive', 'desligado'].includes(String(contexto.colaborador.status ?? '').trim().toLowerCase())) return null
  return contexto
}

function queryPagamentos(empresaId: string, ano: number, mes: number) {
  return `SELECT p.*, l.id AS lancamento_rh_id
    FROM pagamentos_folha p
    LEFT JOIN lancamentos_financeiros_rh l ON l.origem_tipo = 'PAGAMENTO_FOLHA' AND l.origem_id = p.id
    WHERE p.empresa_id = ? AND p.competencia_ano = ? AND p.competencia_mes = ? AND p.status <> 'CANCELADO'
    ORDER BY COALESCE((SELECT nome_exibicao FROM user_profiles WHERE id = p.user_id),
                      (SELECT nome_completo FROM user_profiles WHERE id = p.user_id), p.user_id), p.user_id, p.rotulo`
}

function itemKey(requestKey: string, empresaId: string, rotulo: RotuloPagamentoFolha) {
  return `${requestKey}:${empresaId}:${rotulo}`
}

function primeiroDiaCompetencia(ano: number, mes: number) {
  return `${ano}-${String(mes).padStart(2, '0')}-01`
}

async function verificarContaPagamento(db: D1Database, contaId: string | null): Promise<boolean> {
  if (!contaId) return true
  const row = await db.prepare(`SELECT id FROM contas_bancarias WHERE id = ? AND COALESCE(ativo, 1) = 1 AND upper(COALESCE(tipo_caixa, 'SHARE')) = 'SHARE' LIMIT 1`).bind(contaId).first()
  return Boolean(row)
}

function assinaturaDeArquivoValida(tipo: string, bytes: ArrayBuffer): boolean {
  const conteudo = new Uint8Array(bytes)
  if (tipo === 'application/pdf') return new TextDecoder().decode(conteudo.subarray(0, 5)) === '%PDF-'
  if (tipo === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => conteudo[index] === byte)
  if (tipo === 'image/jpeg') return conteudo[0] === 255 && conteudo[1] === 216 && conteudo[2] === 255
  if (tipo === 'image/webp') return new TextDecoder().decode(conteudo.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(conteudo.subarray(8, 12)) === 'WEBP'
  return false
}

async function carregarAtuais(db: D1Database, empresaId: string, payload: Pick<RegistrarPagamentoFolha, 'user_id' | 'ano' | 'mes'>): Promise<PagamentoAtual[]> {
  const result = await db.prepare(`
    SELECT p.id, p.rotulo, p.status, l.status AS lancamento_status
      FROM pagamentos_folha p
      LEFT JOIN lancamentos_financeiros_rh l ON l.origem_tipo = 'PAGAMENTO_FOLHA' AND l.origem_id = p.id
     WHERE p.empresa_id = ? AND p.user_id = ? AND p.competencia_ano = ? AND p.competencia_mes = ?
  `).bind(empresaId, payload.user_id, payload.ano, payload.mes).all<PagamentoAtual>()
  return result.results ?? []
}

async function idempotencyConflitante(db: D1Database, keys: string[], empresaId: string, payload: Pick<RegistrarPagamentoFolha, 'user_id' | 'ano' | 'mes'>): Promise<boolean> {
  if (!keys.length) return false
  const placeholders = keys.map(() => '?').join(', ')
  const [pagamentos, lancamentos] = await Promise.all([
    db.prepare(`SELECT idempotency_key, empresa_id, user_id, competencia_ano AS ano, competencia_mes AS mes, rotulo FROM pagamentos_folha WHERE idempotency_key IN (${placeholders})`).bind(...keys).all<{ idempotency_key: string; empresa_id: string; user_id: string; ano: number; mes: number; rotulo: string }>(),
    db.prepare(`SELECT l.idempotency_key, l.empresa_id, p.user_id, p.competencia_ano AS ano, p.competencia_mes AS mes, p.rotulo
      FROM lancamentos_financeiros_rh l JOIN pagamentos_folha p ON p.id = l.origem_id
      WHERE l.idempotency_key IN (${placeholders}) AND l.empresa_id = ? AND l.origem_tipo = 'PAGAMENTO_FOLHA'`).bind(...keys, empresaId).all<{ idempotency_key: string; empresa_id: string; user_id: string; ano: number; mes: number; rotulo: string }>(),
  ])
  return [...(pagamentos.results ?? []), ...(lancamentos.results ?? [])].some((row) => {
    const rotuloEsperado = row.idempotency_key.slice(row.idempotency_key.lastIndexOf(':') + 1)
    return row.empresa_id !== empresaId || row.user_id !== payload.user_id || Number(row.ano) !== payload.ano || Number(row.mes) !== payload.mes || row.rotulo !== rotuloEsperado
  })
}

function validarUrlAnexo(url: string | null, tipo: 'holerite' | 'comprovante', contexto: EmpresaContexto, payload: RegistrarPagamentoFolha): boolean {
  if (!url) return true
  if (!url.startsWith('/api/financeiro/pagamentos-folha/anexos?')) return false
  const key = new URL(url, 'https://share-brasil.invalid').searchParams.get('key')
  if (!key) return false
  const esperado = new RegExp(`^financeiro/pagamentos-folha/${contexto.empresaId}/${payload.ano}/${String(payload.mes).padStart(2, '0')}/${payload.user_id}/${tipo}/[A-Za-z0-9-]+\\.(pdf|jpg|png|webp)$`)
  return esperado.test(key)
}

pagamentosFolhaRoutes.get('/pagamentos-folha', async (c) => {
  const acesso = await autorizar(c)
  if ('resposta' in acesso) return acesso.resposta
  const ano = Number(c.req.query('ano'))
  const mes = Number(c.req.query('mes'))
  if (!Number.isInteger(ano) || ano < 2000 || ano > 9999) return erro(c, 'ano_invalido', 400)
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return erro(c, 'mes_invalido', 400)
  try {
    const db = c.env.SHARE_DB
    const empresas = await empresasDoUsuario(db, acesso.userId)
    const escopo = empresas.length ? ` AND p.empresa_id IN (${empresas.map(() => '?').join(', ')})` : ''
    const result = await db.prepare(`
      SELECT p.*, l.id AS lancamento_rh_id
        FROM pagamentos_folha p
        LEFT JOIN lancamentos_financeiros_rh l ON l.origem_tipo = 'PAGAMENTO_FOLHA' AND l.origem_id = p.id
       WHERE p.competencia_ano = ? AND p.competencia_mes = ? AND p.status <> 'CANCELADO'${escopo}
       ORDER BY p.user_id, p.rotulo
    `).bind(ano, mes, ...empresas).all<Record<string, unknown>>()
    return c.json({ pagamentos: result.results ?? [] })
  } catch (error) {
    console.error('[pagamentos-folha] falha ao listar', error)
    return erro(c, 'falha_ao_listar_pagamentos_folha', 503)
  }
})

pagamentosFolhaRoutes.post('/pagamentos-folha', async (c) => {
  const acesso = await autorizar(c)
  if ('resposta' in acesso) return acesso.resposta
  const validacao = validarRegistroPagamentoFolha(await c.req.json().catch(() => null))
  if ('erro' in validacao) return erro(c, validacao.erro, 400)
  const payload = validacao.valor
  const db = c.env.SHARE_DB

  try {
    const contexto = await validarColaboradorAtivo(db, payload.user_id, acesso.userId)
    if (!contexto) return erro(c, 'colaborador_ou_empresa_nao_encontrado', 404)
    if (!(await verificarContaPagamento(db, payload.conta_pagamento_id))) return erro(c, 'conta_pagamento_invalida', 400)
    if (!validarUrlAnexo(payload.holerite_url, 'holerite', contexto, payload) || !validarUrlAnexo(payload.comprovante_url, 'comprovante', contexto, payload)) return erro(c, 'url_de_anexo_invalida', 400)

    const atuais = await carregarAtuais(db, contexto.empresaId, payload)
    if (atuais.some((row) => String(row.status).toUpperCase() === 'PAGO' || String(row.lancamento_status).toUpperCase() === 'PAGO')) {
      return erro(c, 'pagamento_ja_pago_nao_pode_ser_alterado', 409)
    }

    const novosRotulos = new Set(payload.itens.map((item) => item.rotulo))
    const novasParcelas = payload.itens.map((item) => parcelaDecimoTerceiro(item.rotulo)).filter((parcela): parcela is 'PRIMEIRA' | 'SEGUNDA' => Boolean(parcela))
    if (novasParcelas.length) {
      const marks = novasParcelas.map(() => '?').join(', ')
      const decimos = await db.prepare(`SELECT parcela, status FROM decimo_terceiro WHERE empresa_id = ? AND user_id = ? AND ano = ? AND parcela IN (${marks})`)
        .bind(contexto.empresaId, payload.user_id, payload.ano, ...novasParcelas).all<{ parcela: string; status: string }>()
      if ((decimos.results ?? []).some((row) => String(row.status).toUpperCase() === 'PAGO')) return erro(c, 'decimo_terceiro_ja_pago_nao_pode_ser_alterado', 409)
    }

    const keys = payload.itens.map((item) => itemKey(payload.idempotency_key, contexto.empresaId, item.rotulo))
    if (await idempotencyConflitante(db, keys, contexto.empresaId, payload)) return erro(c, 'idempotency_key_reutilizada', 409)

    const statements: D1PreparedStatement[] = []
    const removidos = atuais.filter((row) => row.rotulo && ROTULOS.has(row.rotulo) && !novosRotulos.has(row.rotulo))
    const rotulos13Removidos = removidos.map((row) => row.rotulo && parcelaDecimoTerceiro(row.rotulo)).filter((parcela): parcela is 'PRIMEIRA' | 'SEGUNDA' => Boolean(parcela))
    if (rotulos13Removidos.length) {
      const marks = rotulos13Removidos.map(() => '?').join(', ')
      const decimos = await db.prepare(`SELECT parcela, status FROM decimo_terceiro WHERE empresa_id = ? AND user_id = ? AND ano = ? AND parcela IN (${marks})`)
        .bind(contexto.empresaId, payload.user_id, payload.ano, ...rotulos13Removidos).all<{ parcela: string; status: string }>()
      if ((decimos.results ?? []).some((row) => String(row.status).toUpperCase() === 'PAGO')) return erro(c, 'decimo_terceiro_ja_pago_nao_pode_ser_excluido', 409)
    }

    for (const row of removidos) {
      statements.push(db.prepare(`UPDATE lancamentos_financeiros_rh SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP
        WHERE origem_tipo = 'PAGAMENTO_FOLHA' AND origem_id = ? AND status <> 'PAGO'`).bind(row.id))
      statements.push(db.prepare('DELETE FROM pagamentos_folha WHERE id = ? AND empresa_id = ?').bind(row.id, contexto.empresaId))
      const parcela = row.rotulo ? parcelaDecimoTerceiro(row.rotulo) : null
      if (parcela) statements.push(db.prepare(`UPDATE decimo_terceiro SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = ? AND user_id = ? AND ano = ? AND parcela = ? AND status <> 'PAGO'`).bind(contexto.empresaId, payload.user_id, payload.ano, parcela))
    }

    const dataPrevista = payload.data_pagamento || primeiroDiaCompetencia(payload.ano, payload.mes)
    for (const item of payload.itens) {
      const pagamentoId = await idDeterministicoPagamentoFolha(`${contexto.empresaId}|${payload.user_id}|${payload.ano}|${payload.mes}|${item.rotulo}`)
      const chave = itemKey(payload.idempotency_key, contexto.empresaId, item.rotulo)
      const descricao = `Pagamento de folha - ${item.rotulo.replace('_', ' ')} - ${contexto.colaborador.nome_exibicao || contexto.colaborador.nome_completo} (${String(payload.mes).padStart(2, '0')}/${payload.ano})`
      statements.push(db.prepare(`
        INSERT INTO pagamentos_folha (
          id, empresa_id, folha_id, user_id, tipo_pagamento, rotulo, competencia_ano, competencia_mes,
          valor_centavos, data_prevista, data_pagamento, status, comprovante_url, holerite_url,
          conta_pagamento_id, observacoes, idempotency_key, criado_por
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'PENDENTE', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(empresa_id, user_id, competencia_ano, competencia_mes, rotulo) DO UPDATE SET
          tipo_pagamento = excluded.tipo_pagamento,
          valor_centavos = excluded.valor_centavos,
          data_prevista = excluded.data_prevista,
          data_pagamento = NULL,
          status = 'PENDENTE',
          comprovante_url = excluded.comprovante_url,
          holerite_url = excluded.holerite_url,
          conta_pagamento_id = excluded.conta_pagamento_id,
          observacoes = excluded.observacoes,
          idempotency_key = excluded.idempotency_key,
          atualizado_em = CURRENT_TIMESTAMP
      `).bind(
        pagamentoId, contexto.empresaId, payload.user_id, item.tipo_pagamento, item.rotulo,
        payload.ano, payload.mes, item.valor_centavos, dataPrevista, payload.comprovante_url,
        payload.holerite_url, payload.conta_pagamento_id, payload.observacoes, chave, acesso.userId,
      ))

      const lancamentoId = await idDeterministicoPagamentoFolha(`rh|pagamento-folha|${pagamentoId}`)
      statements.push(db.prepare(`
        INSERT INTO lancamentos_financeiros_rh (
          id, empresa_id, origem_tipo, origem_id, tipo, descricao, valor_centavos,
          data_vencimento, data_pagamento, status, conta_pagamento_id, criado_por, idempotency_key
        ) VALUES (?, ?, 'PAGAMENTO_FOLHA', ?, ?, ?, ?, ?, NULL, 'AGUARDANDO_APROVACAO', ?, ?, ?)
        ON CONFLICT(origem_tipo, origem_id) DO UPDATE SET
          tipo = excluded.tipo,
          descricao = excluded.descricao,
          valor_centavos = excluded.valor_centavos,
          data_vencimento = excluded.data_vencimento,
          data_pagamento = NULL,
          status = 'AGUARDANDO_APROVACAO',
          conta_pagamento_id = excluded.conta_pagamento_id,
          criado_por = excluded.criado_por,
          aprovado_por = NULL,
          aprovado_em = NULL,
          idempotency_key = excluded.idempotency_key,
          atualizado_em = CURRENT_TIMESTAMP
      `).bind(lancamentoId, contexto.empresaId, pagamentoId, item.tipo_pagamento, descricao, item.valor_centavos, dataPrevista, payload.conta_pagamento_id, acesso.userId, chave))

      const parcela = parcelaDecimoTerceiro(item.rotulo)
      if (parcela) statements.push(db.prepare(`
        INSERT INTO decimo_terceiro (
          id, empresa_id, user_id, ano, parcela, meses_trabalhados, salario_base_centavos,
          media_variaveis_centavos, valor_bruto_centavos, inss_centavos, irrf_centavos,
          valor_liquido_centavos, data_pagamento, status
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, ?, NULL, 'CALCULADO')
        ON CONFLICT(empresa_id, user_id, ano, parcela) DO UPDATE SET
          valor_bruto_centavos = excluded.valor_bruto_centavos,
          valor_liquido_centavos = excluded.valor_liquido_centavos,
          data_pagamento = NULL,
          status = 'CALCULADO',
          aprovado_por = NULL,
          aprovado_em = NULL,
          atualizado_em = CURRENT_TIMESTAMP
      `).bind(
        await idDeterministicoPagamentoFolha(`decimo-terceiro|${contexto.empresaId}|${payload.user_id}|${payload.ano}|${parcela}`),
        contexto.empresaId, payload.user_id, payload.ano, parcela, item.valor_centavos, item.valor_centavos,
      ))
    }

    if (statements.length) await db.batch(statements)
    const saved = await db.prepare(queryPagamentos(contexto.empresaId, payload.ano, payload.mes))
      .bind(contexto.empresaId, payload.ano, payload.mes).all<Record<string, unknown>>()
    return c.json({ ok: true, pagamentos: saved.results ?? [] })
  } catch (error) {
    console.error('[pagamentos-folha] falha ao registrar', error)
    return erro(c, 'falha_ao_registrar_pagamentos_folha', 503)
  }
})

pagamentosFolhaRoutes.delete('/pagamentos-folha', async (c) => {
  const acesso = await autorizar(c)
  if ('resposta' in acesso) return acesso.resposta
  const userId = String(c.req.query('user_id') ?? '').trim()
  const ano = Number(c.req.query('ano'))
  const mes = Number(c.req.query('mes'))
  if (!userId || !Number.isInteger(ano) || ano < 2000 || ano > 9999) return erro(c, 'competencia_ou_usuario_invalido', 400)
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return erro(c, 'mes_invalido', 400)
  const db = c.env.SHARE_DB
  try {
    const contexto = await validarColaboradorAtivo(db, userId, acesso.userId)
    if (!contexto) return erro(c, 'colaborador_ou_empresa_nao_encontrado', 404)
    const atuais = await carregarAtuais(db, contexto.empresaId, { user_id: userId, ano, mes })
    if (!atuais.length) return erro(c, 'pagamentos_nao_encontrados', 404)
    if (atuais.some((row) => String(row.status).toUpperCase() === 'PAGO' || String(row.lancamento_status).toUpperCase() === 'PAGO')) return erro(c, 'pagamento_ja_pago_nao_pode_ser_excluido', 409)

    const parcelas = atuais.map((row) => row.rotulo && parcelaDecimoTerceiro(row.rotulo)).filter((parcela): parcela is 'PRIMEIRA' | 'SEGUNDA' => Boolean(parcela))
    if (parcelas.length) {
      const marks = parcelas.map(() => '?').join(', ')
      const decimos = await db.prepare(`SELECT status FROM decimo_terceiro WHERE empresa_id = ? AND user_id = ? AND ano = ? AND parcela IN (${marks})`)
        .bind(contexto.empresaId, userId, ano, ...parcelas).all<{ status: string }>()
      if ((decimos.results ?? []).some((row) => String(row.status).toUpperCase() === 'PAGO')) return erro(c, 'decimo_terceiro_ja_pago_nao_pode_ser_excluido', 409)
    }

    const statements: D1PreparedStatement[] = []
    for (const row of atuais) {
      statements.push(db.prepare(`UPDATE lancamentos_financeiros_rh SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP
        WHERE origem_tipo = 'PAGAMENTO_FOLHA' AND origem_id = ? AND status <> 'PAGO'`).bind(row.id))
      statements.push(db.prepare('DELETE FROM pagamentos_folha WHERE id = ? AND empresa_id = ?').bind(row.id, contexto.empresaId))
      const parcela = row.rotulo && parcelaDecimoTerceiro(row.rotulo)
      if (parcela) statements.push(db.prepare(`UPDATE decimo_terceiro SET status = 'CANCELADO', atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = ? AND user_id = ? AND ano = ? AND parcela = ? AND status <> 'PAGO'`).bind(contexto.empresaId, userId, ano, parcela))
    }
    await db.batch(statements)
    return c.json({ ok: true })
  } catch (error) {
    console.error('[pagamentos-folha] falha ao excluir', error)
    return erro(c, 'falha_ao_excluir_pagamentos_folha', 503)
  }
})

pagamentosFolhaRoutes.post('/pagamentos-folha/anexos', async (c) => {
  const acesso = await autorizar(c)
  if ('resposta' in acesso) return acesso.resposta
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return erro(c, 'armazenamento_de_anexos_indisponivel', 503)
  try {
    const form = await c.req.formData()
    const rawFile = form.get('arquivo') as unknown
    const tipo = String(form.get('tipo') ?? '')
    const userId = String(form.get('user_id') ?? '').trim()
    const ano = Number(form.get('ano'))
    const mes = Number(form.get('mes'))
    if (!rawFile || typeof rawFile !== 'object' || !('arrayBuffer' in rawFile) || !('type' in rawFile) || !('size' in rawFile)) return erro(c, 'arquivo_obrigatorio', 400)
    const file = rawFile as File
    if (tipo !== 'holerite' && tipo !== 'comprovante') return erro(c, 'tipo_anexo_invalido', 400)
    if (!userId || !Number.isInteger(ano) || ano < 2000 || ano > 9999 || !Number.isInteger(mes) || mes < 1 || mes > 12) return erro(c, 'competencia_ou_usuario_invalido', 400)
    const extensao = EXTENSOES[file.type]
    if (!extensao) return erro(c, 'formato_de_anexo_nao_permitido', 415)
    if (file.size < 1 || file.size > TAMANHO_MAXIMO_ANEXO) return erro(c, 'tamanho_de_anexo_invalido', 413)
    const contexto = await validarColaboradorAtivo(c.env.SHARE_DB, userId, acesso.userId)
    if (!contexto) return erro(c, 'colaborador_ou_empresa_nao_encontrado', 404)
    const atuais = await carregarAtuais(c.env.SHARE_DB, contexto.empresaId, { user_id: userId, ano, mes })
    if (atuais.some((row) => String(row.status).toUpperCase() === 'PAGO' || String(row.lancamento_status).toUpperCase() === 'PAGO')) return erro(c, 'pagamento_ja_pago_nao_pode_ser_alterado', 409)
    const bytes = await file.arrayBuffer()
    if (!assinaturaDeArquivoValida(file.type, bytes)) return erro(c, 'conteudo_de_anexo_invalido', 415)
    const key = `financeiro/pagamentos-folha/${contexto.empresaId}/${ano}/${String(mes).padStart(2, '0')}/${userId}/${tipo}/${crypto.randomUUID()}.${extensao}`
    await bucket.put(key, bytes, { httpMetadata: { contentType: file.type, contentDisposition: 'inline' } })
    const query = new URLSearchParams({ key }).toString()
    return c.json({ url: `/api/financeiro/pagamentos-folha/anexos?${query}` }, 201)
  } catch (error) {
    console.error('[pagamentos-folha] falha no upload', error)
    return erro(c, 'falha_ao_enviar_anexo_pagamento_folha', 503)
  }
})

pagamentosFolhaRoutes.get('/pagamentos-folha/anexos', async (c) => {
  const acesso = await autorizar(c)
  if ('resposta' in acesso) return acesso.resposta
  const key = String(c.req.query('key') ?? '')
  const match = /^financeiro\/pagamentos-folha\/([A-Za-z0-9_-]+)\/(\d{4})\/(\d{2})\/([A-Za-z0-9_-]+)\/(holerite|comprovante)\/([A-Za-z0-9-]+)\.(pdf|jpg|png|webp)$/.exec(key)
  if (!match) return erro(c, 'anexo_nao_encontrado', 404)
  const [, empresaId, ano, mes, ownerId] = match
  const bucket = c.env.SHARE_FILES || c.env.FILES
  if (!bucket) return erro(c, 'armazenamento_de_anexos_indisponivel', 503)
  try {
    const contexto = await resolverContextoColaborador(c.env.SHARE_DB, ownerId, acesso.userId)
    if (!contexto || contexto.empresaId !== empresaId || Number(ano) < 2000 || Number(mes) < 1 || Number(mes) > 12) return erro(c, 'anexo_nao_encontrado', 404)
    const object = await bucket.get(key)
    if (!object) return erro(c, 'anexo_nao_encontrado', 404)
    const headers = new Headers({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' })
    const contentType = object.httpMetadata?.contentType
    if (contentType) headers.set('Content-Type', contentType)
    return new Response(object.body, { headers })
  } catch (error) {
    console.error('[pagamentos-folha] falha ao baixar anexo', error)
    return erro(c, 'falha_ao_carregar_anexo_pagamento_folha', 503)
  }
})
