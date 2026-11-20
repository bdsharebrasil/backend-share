import { Hono, Context } from 'hono'
import { portalCreatePasswordHash, portalFeatureForPath, portalHasFeature, portalSession, portalTelegram, type PortalFeature } from './portalRoutes'
import { carregarDadosBalancoMensal, limitesMes } from '../financeiro/balancoMensalRoutes'
import { calcularBalancoMensal } from '../financeiro/balancoMensal'

// Rotas complementares do Portal Cliente (Fase 1):
// diário de bordo do cliente, balanço multi-mês, abastecimentos,
// envio de comprovante de pagamento e download de anexos de abastecimento.

type Bindings = {
  SHARE_DB: D1Database
  SHARE_FILES: R2Bucket
  CACHE_KV: KVNamespace
  RATE_LIMITER: DurableObjectNamespace
  CLIENT_SESSION_SECRET?: string
  CLIENT_SESSION_TTL_SECONDS?: string
  INTERNAL_TOKEN?: string
  TELEGRAM_BOT_TOKEN?: string
}
type Ctx = Context<{ Bindings: Bindings; Variables: Record<string, never> }>

export const portalClienteExtrasRoutes = new Hono<{ Bindings: Bindings; Variables: Record<string, never> }>()

const MARCADOR_COMPROVANTE = '[PORTAL_COMPROVANTE]'
const MAX_ARQUIVO_BYTES = 10 * 1024 * 1024
const TIPOS_PERMITIDOS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function mesesDaQuery(raw: string | undefined): string[] {
  const meses = String(raw || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v))
  const unicos = Array.from(new Set(meses)).slice(0, 36)
  return unicos.length ? unicos : [new Date().toISOString().slice(0, 7)]
}

function placeholders(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ')
}

async function usuario(c: Ctx) {
  const user = await portalSession(c as any)
  if (!user) return null
  if (!user.cliente_id && !user.socio_id) return null
  return user
}

portalClienteExtrasRoutes.use('/api/portal/*', async (c, next) => {
  if (c.req.path === '/api/portal/login') return next()
  const user = await portalSession(c as any)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const feature = portalFeatureForPath(c.req.path)
  if (feature && !portalHasFeature(user, feature)) return c.json({ error: 'portal_feature_forbidden' }, 403)
  return next()
})

function normalizeEmails(value: unknown): string[] | null {
  let values: unknown[]
  if (Array.isArray(value)) values = value
  else if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) values = []
    else {
      try {
        const parsed = JSON.parse(raw)
        values = Array.isArray(parsed) ? parsed : raw.split(/[\n,;]+/)
      } catch {
        values = raw.split(/[\n,;]+/)
      }
    }
  } else return null
  const emails = [...new Set(values.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))]
  if (emails.length > 20 || emails.some(email => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null
  return emails
}

const PORTAL_FEATURES: PortalFeature[] = ['agendamento', 'financeiro', 'aeronave', 'manutencao']

function permissionsFromBody(value: unknown): PortalFeature[] | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Array.isArray(value) || value.some(item => !PORTAL_FEATURES.includes(item as PortalFeature))) return undefined
  return [...new Set(value as PortalFeature[])]
}

async function exigirPrincipal(c: Ctx) {
  const user = await usuario(c)
  if (!user) return { response: c.json({ error: 'client_auth_required' }, 401) }
  const schema = await c.env.SHARE_DB.prepare('SELECT name FROM pragma_table_info(?1)').bind('user_cliente').all<{ name: string }>()
  const columns = new Set((schema.results || []).map(column => String(column.name)))
  if (!columns.has('principal_id') || !columns.has('permissoes')) {
    return { response: c.json({ error: 'portal_migracao_acessos_pendente' }, 503) }
  }
  if (user.principal_id) return { response: c.json({ error: 'portal_configuracoes_restritas' }, 403) }
  const principal = await c.env.SHARE_DB.prepare('SELECT id, cotista_id FROM user_cliente WHERE id = ?1 AND principal_id IS NULL LIMIT 1').bind(user.id).first<{ id: string; cotista_id: string | null }>()
  if (!principal?.cotista_id) return { response: c.json({ error: 'portal_usuario_sem_cotista' }, 409) }
  return { user, principal }
}

portalClienteExtrasRoutes.get('/api/portal/configuracoes', async c => {
  const auth = await exigirPrincipal(c)
  if ('response' in auth) return auth.response
  const { user, principal } = auth
  const [perfil, acessos] = await Promise.all([
    user.cliente_id
      ? c.env.SHARE_DB.prepare('SELECT razao_social AS nome, endereco, cidade, uf, telefone_financeiro, contato_financeiro, emails FROM cliente WHERE id = ?1').bind(user.cliente_id).first<Record<string, unknown>>()
      : c.env.SHARE_DB.prepare('SELECT nome, endereco, cidade, uf, telefone_financeiro, contato_financeiro, emails FROM hold_socios WHERE id = ?1').bind(user.socio_id).first<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare('SELECT id, login, nome_exibicao, permissoes, criado_em FROM user_cliente WHERE principal_id = ?1 ORDER BY criado_em, id').bind(principal.id).all<Record<string, unknown>>(),
  ])
  return c.json({
    tipo: user.cliente_id ? 'cliente' : 'socio',
    login_principal: user.login,
    perfil: { ...(perfil || {}), emails: normalizeEmails(perfil?.emails) || [] },
    acessos: (acessos.results || []).map(row => ({
      id: row.id, login: row.login, nome: row.nome_exibicao,
      permissoes: row.permissoes == null ? null : (normalizeFeatureList(row.permissoes) ?? []),
      criado_em: row.criado_em,
    })),
  })
})

function normalizeFeatureList(value: unknown): PortalFeature[] | null {
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is PortalFeature => PORTAL_FEATURES.includes(item as PortalFeature)))] : null
  } catch {
    return null
  }
}

portalClienteExtrasRoutes.put('/api/portal/configuracoes/perfil', async c => {
  const auth = await exigirPrincipal(c)
  if ('response' in auth) return auth.response
  const { user } = auth
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'dados_perfil_invalidos' }, 400)
  const campos = ['endereco', 'cidade', 'uf', 'telefone_financeiro', 'contato_financeiro'] as const
  const valores = campos.map(campo => String(body[campo] ?? '').trim())
  if (valores.some(valor => valor.length > 240) || valores[2].length > 2) return c.json({ error: 'dados_perfil_invalidos' }, 400)
  const emails = normalizeEmails(body.emails)
  if (!emails) return c.json({ error: 'emails_invalidos' }, 400)
  const db = c.env.SHARE_DB
  const table = user.cliente_id ? 'cliente' : 'hold_socios'
  const id = user.cliente_id || user.socio_id
  await db.prepare(`UPDATE ${table} SET endereco = ?1, cidade = ?2, uf = ?3, telefone_financeiro = ?4, contato_financeiro = ?5, emails = ?6${user.cliente_id ? ', atualizado_em = CURRENT_TIMESTAMP' : ''} WHERE id = ?7`)
    .bind(valores[0], valores[1], valores[2].toUpperCase(), valores[3], valores[4], JSON.stringify(emails), id).run()
  return c.json({ success: true })
})

portalClienteExtrasRoutes.post('/api/portal/configuracoes/acessos', async c => {
  const auth = await exigirPrincipal(c)
  if ('response' in auth) return auth.response
  const { user, principal } = auth
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'dados_acesso_invalidos' }, 400)
  const nome = String(body.nome || '').trim()
  const login = String(body.login || '').trim().toLowerCase()
  const senha = String(body.senha || '')
  const permissoes = permissionsFromBody(body.permissoes)
  if (!nome || nome.length > 100 || !/^[a-z0-9._-]{3,80}$/.test(login)) return c.json({ error: 'dados_acesso_invalidos' }, 400)
  if (senha.length < 12 || senha.length > 128) return c.json({ error: 'senha_deve_ter_entre_12_e_128_caracteres' }, 400)
  if (permissoes === undefined) return c.json({ error: 'permissoes_invalidas' }, 400)
  const db = c.env.SHARE_DB
  const existing = await db.prepare('SELECT id FROM user_cliente WHERE lower(login) = lower(?1) LIMIT 1').bind(login).first()
  if (existing) return c.json({ error: 'login_ja_em_uso' }, 409)
  const id = crypto.randomUUID()
  const hash = await portalCreatePasswordHash(senha)
  await db.prepare(`INSERT INTO user_cliente (id, login, senha, nome_exibicao, url_avatar, cotista_id, criado_em, atualizado_em, principal_id, permissoes)
    VALUES (?1, ?2, ?3, ?4, NULL, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?6, ?7)`)
    .bind(id, login, hash, nome, principal.cotista_id, user.id, permissoes === null ? null : JSON.stringify(permissoes)).run()
  return c.json({ success: true, acesso: { id, login, nome, permissoes: permissoes ?? null } }, 201)
})

portalClienteExtrasRoutes.put('/api/portal/configuracoes/acessos/:id', async c => {
  const auth = await exigirPrincipal(c)
  if ('response' in auth) return auth.response
  const { user } = auth
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'dados_acesso_invalidos' }, 400)
  const id = c.req.param('id')
  const current = await c.env.SHARE_DB.prepare('SELECT id, login, nome_exibicao FROM user_cliente WHERE id = ?1 AND principal_id = ?2').bind(id, user.id).first<{ id: string; login: string; nome_exibicao: string | null }>()
  if (!current) return c.json({ error: 'acesso_nao_encontrado' }, 404)
  const updates: string[] = []
  const values: unknown[] = []
  const add = (column: string, value: unknown) => { values.push(value); updates.push(`${column} = ?${values.length}`) }
  if (body.nome !== undefined) {
    const nome = String(body.nome || '').trim()
    if (!nome || nome.length > 100) return c.json({ error: 'dados_acesso_invalidos' }, 400)
    add('nome_exibicao', nome)
  }
  if (body.login !== undefined) {
    const login = String(body.login || '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,80}$/.test(login)) return c.json({ error: 'dados_acesso_invalidos' }, 400)
    const existing = await c.env.SHARE_DB.prepare('SELECT id FROM user_cliente WHERE lower(login) = lower(?1) AND id <> ?2 LIMIT 1').bind(login, id).first()
    if (existing) return c.json({ error: 'login_ja_em_uso' }, 409)
    add('login', login)
  }
  if (body.senha !== undefined && String(body.senha)) {
    const senha = String(body.senha)
    if (senha.length < 12 || senha.length > 128) return c.json({ error: 'senha_deve_ter_entre_12_e_128_caracteres' }, 400)
    add('senha', await portalCreatePasswordHash(senha))
  }
  if (body.permissoes !== undefined) {
    const permissoes = permissionsFromBody(body.permissoes)
    if (permissoes === undefined) return c.json({ error: 'permissoes_invalidas' }, 400)
    add('permissoes', permissoes === null ? null : JSON.stringify(permissoes))
  }
  if (!updates.length) return c.json({ error: 'nenhuma_alteracao_informada' }, 400)
  values.push(id, user.id)
  const result = await c.env.SHARE_DB.prepare(`UPDATE user_cliente SET ${updates.join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?${values.length - 1} AND principal_id = ?${values.length}`)
    .bind(...values).run()
  if (!result.meta?.changes) return c.json({ error: 'acesso_nao_encontrado' }, 404)
  return c.json({ success: true })
})

portalClienteExtrasRoutes.delete('/api/portal/configuracoes/acessos/:id', async c => {
  const auth = await exigirPrincipal(c)
  if ('response' in auth) return auth.response
  const { user } = auth
  const result = await c.env.SHARE_DB.prepare('DELETE FROM user_cliente WHERE id = ?1 AND principal_id = ?2').bind(c.req.param('id'), user.id).run()
  if (!result.meta?.changes) return c.json({ error: 'acesso_nao_encontrado' }, 404)
  return c.json({ success: true })
})

// ── Diário de bordo resumido (apenas voos do cliente) ──────────────────────
portalClienteExtrasRoutes.get('/api/portal/diario-bordo', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const hoje = new Date().toISOString().slice(0, 10)
  const de = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('de') || '') ? c.req.query('de')! : new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('ate') || '') ? c.req.query('ate')! : hoje
  const [result, emprestimos] = await Promise.all([
    c.env.SHARE_DB.prepare(`
      SELECT l.id, l.numero_voo, l.data_registro, l.aerodromo_partida, l.aerodromo_chegada, l.trecho,
             l.pic_nome, l.sic_nome, l.tempo_dep, l.tempo_pou, l.tempo_voo, l.tempo_total, l.pousos_total,
             l.distancia_nm, l.litros_combustivel_abastecido, l.voo_emprestado, a.matricula_registro, a.modelo
        FROM lancamentos_diario_bordo l
        LEFT JOIN aeronave a ON a.id = l.aeronave_id
       WHERE (
           l.cliente_id = ?1 OR l.socio_id = ?2
           OR l.cliente_tomador_emprestimo_id = ?1 OR l.socio_tomador_emprestimo_id = ?2
           OR EXISTS (
             SELECT 1 FROM cotista_aeronave ca
              WHERE ca.aeronave_id = l.aeronave_id
                AND lower(trim(COALESCE(ca.status, ''))) = 'ativo'
                AND (ca.cliente_id = ?1 OR ca.socio_id = ?2)
           )
         )
         AND date(l.data_registro) BETWEEN date(?3) AND date(?4)
       ORDER BY date(l.data_registro) DESC, l.tempo_dep DESC
       LIMIT 500`).bind(user.cliente_id, user.socio_id, de, ate).all<Record<string, unknown>>(),
    c.env.SHARE_DB.prepare(`
      SELECT l.id, l.numero_voo, l.data_registro, l.aerodromo_partida, l.aerodromo_chegada,
             l.pic_nome, l.tempo_voo, l.tempo_total, l.voo_emprestado, a.matricula_registro,
             COALESCE(NULLIF(TRIM(c.razao_social), ''), NULLIF(TRIM(s.nome), ''), NULLIF(TRIM(l.pic_nome), ''), 'Não identificado') AS utilizado_por
        FROM lancamentos_diario_bordo l
        LEFT JOIN aeronave a ON a.id = l.aeronave_id
        LEFT JOIN cliente c ON c.id = l.cliente_id
        LEFT JOIN hold_socios s ON s.id = l.socio_id
       WHERE COALESCE(l.voo_emprestado, 0) = 1
         AND ((?1 IS NOT NULL AND l.cliente_tomador_emprestimo_id = ?1)
           OR (?2 IS NOT NULL AND l.socio_tomador_emprestimo_id = ?2))
       ORDER BY date(l.data_registro) DESC, l.tempo_dep DESC
       LIMIT 1000`).bind(user.cliente_id, user.socio_id).all<Record<string, unknown>>(),
  ])
  return c.json({ de, ate, voos: result.results || [], voos_emprestimo: emprestimos.results || [] })
})

// ── Manutenção: horímetro, próxima revisão e histórico RAS ────────────────
portalClienteExtrasRoutes.get('/api/portal/manutencao', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const db = c.env.SHARE_DB
  const [aeronaves, manutencoes] = await Promise.all([
    db.prepare(`
      SELECT a.id AS aeronave_id, a.matricula_registro, a.fabricante, a.modelo, a.ano,
             CASE WHEN dm.modo_celula = 'tvoo'
                  THEN dm.celula_atual_tvoo ELSE dm.celula_atual_ttotal END AS horas_atual,
             CASE WHEN dm.modo_celula = 'tvoo' AND COALESCE(dm.celula_prox_revisao_tvoo, 0) > 0
                  THEN dm.celula_prox_revisao_tvoo
                  WHEN COALESCE(dm.celula_prox_revisao_ttotal, 0) > 0 THEN dm.celula_prox_revisao_ttotal
                  ELSE dm.celula_prox_revisao_tvoo END AS proxima_revisao_horas,
             CASE WHEN dm.modo_celula = 'tvoo' AND COALESCE(dm.celula_prox_revisao_tvoo, 0) > 0
                  THEN dm.celula_disponivel_tvoo
                  WHEN COALESCE(dm.celula_prox_revisao_ttotal, 0) > 0 THEN dm.celula_disponivel_ttotal
                  ELSE dm.celula_disponivel_tvoo END AS horas_restantes,
             dm.modo_celula, dm.ano AS diario_ano, dm.mes AS diario_mes
        FROM aeronave a
        LEFT JOIN diario_mes dm ON dm.id = (
          SELECT dm2.id FROM diario_mes dm2
           WHERE dm2.aeronave_id = a.id
           ORDER BY dm2.ano DESC, dm2.mes DESC LIMIT 1
        )
       WHERE EXISTS (
         SELECT 1 FROM cotista_aeronave ca
          WHERE ca.aeronave_id = a.id
            AND lower(trim(COALESCE(ca.status, ''))) = 'ativo'
            AND (ca.cliente_id = ?1 OR ca.socio_id = ?2)
       )
       ORDER BY a.matricula_registro`).bind(user.cliente_id, user.socio_id).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT r.id, r.aeronave_id, a.matricula_registro, r.numero, r.tipo_manutencao,
             r.objetivo, r.descricao, r.data_entrada, r.data_saida,
             r.horas_celula_entrada, r.horas_celula_saida, r.status,
             CAST(strftime('%m', COALESCE(NULLIF(r.data_saida, ''), r.data_entrada)) AS INTEGER) AS mes,
             CAST(strftime('%Y', COALESCE(NULLIF(r.data_saida, ''), r.data_entrada)) AS INTEGER) AS ano
        FROM ctm_ras r
        JOIN aeronave a ON a.id = r.aeronave_id
       WHERE lower(COALESCE(r.status, '')) IN ('in_progress', 'completed')
         AND EXISTS (
           SELECT 1 FROM cotista_aeronave ca
            WHERE ca.aeronave_id = r.aeronave_id
              AND lower(trim(COALESCE(ca.status, ''))) = 'ativo'
              AND (ca.cliente_id = ?1 OR ca.socio_id = ?2)
         )
       ORDER BY CASE WHEN lower(COALESCE(r.status, '')) = 'in_progress' THEN 0 ELSE 1 END,
                date(COALESCE(NULLIF(r.data_saida, ''), r.data_entrada)) DESC, r.id DESC`).bind(user.cliente_id, user.socio_id).all<Record<string, unknown>>(),
  ])
  return c.json({ aeronaves: aeronaves.results || [], manutencoes: manutencoes.results || [] })
})

// ── Meu Balanço (rateio_despesas p/ cliente, rateio_hold p/ holding) ───────
portalClienteExtrasRoutes.get('/api/portal/balanco', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const meses = mesesDaQuery(c.req.query('meses'))
  const db = c.env.SHARE_DB
  const aeronaveSolicitada = String(c.req.query('aeronave_id') ?? '').trim()
  // Consulta vinculada ao user_cliente.cotista_id: não inferir autorização
  // apenas por cliente_id/socio_id, que podem possuir várias aeronaves.
  const vinculo = await db.prepare(`SELECT ca.id, ca.aeronave_id
      FROM user_cliente u JOIN cotista_aeronave ca ON ca.id = u.cotista_id
     WHERE u.id = ?1 AND (?2 = '' OR ca.aeronave_id = ?2)
       AND (ca.cliente_id = ?3 OR ca.socio_id = ?4) LIMIT 1`)
    .bind(user.id, aeronaveSolicitada, user.cliente_id, user.socio_id)
    .first<{ id: string; aeronave_id: string }>()
  if (!vinculo?.id || !vinculo.aeronave_id) return c.json({ error: 'aeronave_nao_vinculada' }, 404)
  const aeronaveId = String(vinculo.aeronave_id)
  const cotistaId = String(vinculo.id)
  c.header('Cache-Control', 'private, no-store')
  // Compensações e saldos pessoais vêm do mesmo motor do Financeiro Share.
  const conciliacao = async () => {
    try {
      const ordenados = [...meses].sort()
      const inicio = limitesMes(ordenados[0]).inicio
      const fim = limitesMes(ordenados[ordenados.length - 1]).fim
      const dados = await carregarDadosBalancoMensal(db, aeronaveId, fim)
      const resultado = calcularBalancoMensal(dados.participantes, dados.rateios,
        dados.pagamentos, dados.ajustes, inicio, fim, meses)
      const minhaConta = resultado.saldos.find(row => row.id === cotistaId)
      const holding = dados.holdings.flatMap(h => h.socios).find(row => row.id === cotistaId)
      return { status: resultado.status, avisos: resultado.avisos,
        custoTotalCentavos: resultado.custoTotalCentavos,
        devidoCentavos: minhaConta?.devidoCentavos ?? 0,
        pagoPessoalCentavos: minhaConta?.pagoCentavos ?? 0,
        saldoPessoalCentavos: minhaConta?.saldoCentavos ?? 0,
        aporteCentavos: holding?.aporteCentavos ?? 0,
        posicaoHoldingCentavos: holding?.posicaoCentavos ?? null }
    } catch (error) {
      console.warn('[portal/balanco] conciliação indisponível', error)
      return null
    }
  }
  // A emissão é a competência única do fechamento interno e do portal.
  const mesExpr = "substr(r.data_emissao, 1, 7)"
  // Eventos confirmados são a fonte de pagamento. Qualquer evento existente
  // desabilita o fallback do campo agregado legado, inclusive após estorno.
  const eventosConfirmados = `LEFT JOIN (
    SELECT rateio_id,
           SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'CONFIRMADO' THEN valor_centavos ELSE 0 END) AS pago_centavos
      FROM rateio_pagamentos GROUP BY rateio_id
  ) pagamentos ON pagamentos.rateio_id = r.id`
  const pagoEfetivo = "COALESCE(pagamentos.pago_centavos, r.valor_pago_real_centavos, 0)"
  const ph = placeholders(3, meses.length)

  if (user.cliente_id) {
    const [lancamentos, cotistas] = await Promise.all([
      db.prepare(`
        SELECT r.id, ${mesExpr} AS mes, r.data_emissao, r.data_vencimento, r.data_pagamento, r.descricao_despesa,
               r.categoria_nome, r.tipo_rateio, r.percentual_sociedade, r.percentual_uso,
               r.valor_total_centavos, r.valor_rateado_centavos, ${pagoEfetivo} AS valor_pago_real_centavos,
               COALESCE(NULLIF(TRIM(pagador_cliente.razao_social), ''), NULLIF(TRIM(pagador_socio.nome), ''),
                 NULLIF(TRIM(pagador_cliente_direto.razao_social), ''), NULLIF(TRIM(pagador_socio_direto.nome), ''),
                 CASE WHEN NULLIF(TRIM(r.pago_por), '') IS NULL THEN NULL WHEN r.pago_diretamente = 1 THEN 'Pagamento direto' ELSE 'Cotista' END) AS pago_por,
               r.pago_diretamente,
               CASE WHEN pagamentos.rateio_id IS NULL THEN r.status
                    WHEN ${pagoEfetivo} >= r.valor_rateado_centavos THEN 'PAGO'
                    WHEN ${pagoEfetivo} > 0 THEN 'PAGO_PARCIAL'
                    ELSE 'EM_ABERTO' END AS status,
               a.matricula_registro, r.aeronave_id,
               (SELECT e.fornecedor FROM envio_despesas e WHERE e.id = r.lancamento_id LIMIT 1) AS fornecedor
          FROM rateio_despesas r
          JOIN cotista_aeronave ca ON ca.id = r.cotista_id
          LEFT JOIN cotista_aeronave ca_pagador ON ca_pagador.id = r.pago_por
          LEFT JOIN cliente pagador_cliente ON pagador_cliente.id = ca_pagador.cliente_id
          LEFT JOIN hold_socios pagador_socio ON pagador_socio.id = ca_pagador.socio_id
          LEFT JOIN cliente pagador_cliente_direto ON pagador_cliente_direto.id = r.pago_por
          LEFT JOIN hold_socios pagador_socio_direto ON pagador_socio_direto.id = r.pago_por
          LEFT JOIN aeronave a ON a.id = r.aeronave_id
          ${eventosConfirmados}
         WHERE r.cotista_id = ?1 AND r.aeronave_id = ?2 AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
           AND ${mesExpr} IN (${ph})
         ORDER BY date(r.data_emissao) DESC`).bind(cotistaId, aeronaveId, ...meses).all<Record<string, unknown>>(),
      db.prepare(`
        SELECT ca.id AS cotista_id, COALESCE(cl.razao_social, hs.nome, 'Cotista') AS nome,
               ca.percentual_sociedade, a.matricula_registro,
               CASE WHEN ca.id = ?1 THEN 1 ELSE 0 END AS eu,
               COALESCE(SUM(r.valor_rateado_centavos), 0) AS total_centavos,
               COALESCE(SUM(MIN(MAX(${pagoEfetivo}, 0), r.valor_rateado_centavos)), 0) AS pago_centavos,
               COUNT(r.id) AS lancamentos
          FROM rateio_despesas r
          JOIN cotista_aeronave ca ON ca.id = r.cotista_id
          LEFT JOIN cliente cl ON cl.id = ca.cliente_id
          LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
          LEFT JOIN aeronave a ON a.id = r.aeronave_id
          ${eventosConfirmados}
         WHERE r.aeronave_id = ?2
           AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
           AND ${mesExpr} IN (${ph})
         GROUP BY ca.id
         ORDER BY eu DESC, total_centavos DESC`).bind(cotistaId, aeronaveId, ...meses).all<Record<string, unknown>>(),
    ])
    return c.json({ tipo: 'CLIENTE', meses, lancamentos: lancamentos.results || [], cotistas: cotistas.results || [], conciliacao: await conciliacao() })
  }

  const [lancamentos, cotistas] = await Promise.all([
    db.prepare(`
      SELECT r.id, ${mesExpr} AS mes, r.data_emissao, r.data_vencimento, r.data_pagamento, r.descricao_despesa,
             r.categoria_nome, r.tipo_rateio, r.percentual_sociedade, r.percentual_uso,
             r.valor_total_centavos, r.valor_rateado_centavos, r.valor_pago_real_centavos,
             COALESCE(NULLIF(TRIM(pagador_cliente.razao_social), ''), NULLIF(TRIM(pagador_socio.nome), ''),
               NULLIF(TRIM(pagador_cliente_direto.razao_social), ''), NULLIF(TRIM(pagador_socio_direto.nome), ''),
               CASE WHEN NULLIF(TRIM(r.pago_por), '') IS NULL THEN NULL WHEN r.pago_diretamente = 1 THEN 'Pagamento direto' ELSE 'Cotista' END) AS pago_por,
             r.pago_diretamente, r.status, a.matricula_registro, r.aeronave_id, r.fornecedor
        FROM rateio_hold r
        LEFT JOIN cotista_aeronave ca_pagador ON ca_pagador.id = r.pago_por
        LEFT JOIN cliente pagador_cliente ON pagador_cliente.id = ca_pagador.cliente_id
        LEFT JOIN hold_socios pagador_socio ON pagador_socio.id = ca_pagador.socio_id
        LEFT JOIN cliente pagador_cliente_direto ON pagador_cliente_direto.id = r.pago_por
        LEFT JOIN hold_socios pagador_socio_direto ON pagador_socio_direto.id = r.pago_por
        LEFT JOIN aeronave a ON a.id = r.aeronave_id
       WHERE r.socio_id = ?1 AND r.aeronave_id = ?2 AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
         AND ${mesExpr} IN (${ph})
       ORDER BY date(r.data_emissao) DESC`).bind(user.socio_id, aeronaveId, ...meses).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT hs.id AS cotista_id, hs.nome AS nome,
             (SELECT ca.percentual_sociedade FROM cotista_aeronave ca WHERE ca.socio_id = hs.id AND ca.aeronave_id = r.aeronave_id LIMIT 1) AS percentual_sociedade,
             a.matricula_registro,
             CASE WHEN hs.id = ?1 THEN 1 ELSE 0 END AS eu,
             COALESCE(SUM(r.valor_rateado_centavos), 0) AS total_centavos,
             COALESCE(SUM(MIN(r.valor_pago_real_centavos, r.valor_rateado_centavos)), 0) AS pago_centavos,
             COUNT(r.id) AS lancamentos
        FROM rateio_hold r
        JOIN hold_socios hs ON hs.id = r.socio_id
        LEFT JOIN aeronave a ON a.id = r.aeronave_id
       WHERE r.aeronave_id = ?2
         AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
         AND ${mesExpr} IN (${ph})
       GROUP BY hs.id
       ORDER BY eu DESC, total_centavos DESC`).bind(user.socio_id, aeronaveId, ...meses).all<Record<string, unknown>>(),
  ])
  return c.json({ tipo: 'HOLDING', meses, lancamentos: lancamentos.results || [], cotistas: cotistas.results || [], conciliacao: await conciliacao() })
})

// ── Abastecimentos do cliente ──────────────────────────────────────────────
portalClienteExtrasRoutes.get('/api/portal/abastecimentos', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const meses = mesesDaQuery(c.req.query('meses'))
  const result = await c.env.SHARE_DB.prepare(`
    SELECT ab.id, ab.data, ab.tipo_combustivel, ab.trecho, ab.local, ab.numero_comanda, ab.numero_nf,
           ab.litros, ab.valor_unitario, ab.valor_total, ab.desconto,
           CASE WHEN UPPER(TRIM(COALESCE(ab.status, ''))) IN ('PAGO', 'PAGO_DIRETAMENTE', 'REEMBOLSADO') THEN 'PAGO' ELSE 'PENDENTE' END AS status,
           ab.forma_pagamento,
           ab.data_vencimento_boleto, ab.numero_voo,
           CASE WHEN ab.comanda_url IS NOT NULL AND ab.comanda_url <> '' THEN 1 ELSE 0 END AS tem_comanda,
           CASE WHEN ab.nota_url IS NOT NULL AND ab.nota_url <> '' THEN 1 ELSE 0 END AS tem_nota,
           CASE WHEN ab.boleto_url IS NOT NULL AND ab.boleto_url <> '' THEN 1 ELSE 0 END AS tem_boleto,
           CASE WHEN COALESCE(ab.observacao, '') LIKE '%${MARCADOR_COMPROVANTE}%' THEN 1 ELSE 0 END AS baixa_solicitada,
           f.nome_fornecedor AS fornecedor, a.matricula_registro,
           l.data_registro AS voo_data, l.aerodromo_partida AS voo_origem, l.aerodromo_chegada AS voo_destino,
           COALESCE(NULLIF(l.numero_voo, ''), ab.numero_voo) AS voo_numero
      FROM abastecimentos ab
      LEFT JOIN fornecedores_combustivel f ON f.id = ab.fornecedor_id
      LEFT JOIN aeronave a ON a.id = ab.aeronave_id
      LEFT JOIN lancamentos_diario_bordo l ON l.id = ab.lancamento_diario_id
     WHERE (ab.cliente_id = ?1 OR ab.socio_id = ?2)
       AND substr(ab.data, 1, 7) IN (${placeholders(3, meses.length)})
     ORDER BY date(ab.data) DESC`).bind(user.cliente_id, user.socio_id, ...meses).all<Record<string, unknown>>()
  return c.json({ meses, abastecimentos: result.results || [] })
})

// ── Anexos de abastecimento (comanda, nota, boleto) ────────────────────────
const colunasArquivo: Record<string, string> = { comanda: 'comanda_url', nota: 'nota_url', boleto: 'boleto_url' }
portalClienteExtrasRoutes.get('/api/portal/abastecimentos/:id/arquivo/:tipo', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const coluna = colunasArquivo[c.req.param('tipo')]
  if (!coluna) return c.json({ error: 'tipo_arquivo_invalido' }, 400)
  const row = await c.env.SHARE_DB.prepare(`SELECT ${coluna} AS caminho FROM abastecimentos WHERE id = ?1 AND (cliente_id = ?2 OR socio_id = ?3)`)
    .bind(c.req.param('id'), user.cliente_id, user.socio_id).first<{ caminho: string | null }>()
  if (!row?.caminho) return c.json({ error: 'arquivo_nao_encontrado' }, 404)
  if (/^https?:\/\//i.test(row.caminho)) return c.redirect(row.caminho, 302)
  const object = await c.env.SHARE_FILES.get(row.caminho)
  if (!object) return c.json({ error: 'arquivo_nao_encontrado' }, 404)
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=600' } })
})

// ── Baixas solicitadas (para marcar na interface) ──────────────────────────
portalClienteExtrasRoutes.get('/api/portal/baixas', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const result = user.cliente_id
    ? await c.env.SHARE_DB.prepare(`SELECT DISTINCT p.rateio_id AS id FROM rateio_pagamentos p
        JOIN cotista_aeronave ca ON ca.id = p.pagador_cotista_id
       WHERE ca.cliente_id = ?1 AND p.status = 'PENDENTE'`).bind(user.cliente_id).all<{ id: string }>()
    : await c.env.SHARE_DB.prepare(`SELECT id FROM rateio_hold WHERE socio_id = ?1 AND COALESCE(observacoes, '') LIKE '%${MARCADOR_COMPROVANTE}%'`).bind(user.socio_id).all<{ id: string }>()
  return c.json({ ids: (result.results || []).map(r => r.id) })
})

// ── Envio de comprovante e solicitação de baixa ────────────────────────────
portalClienteExtrasRoutes.post('/api/portal/comprovantes', async c => {
  const user = await usuario(c)
  if (!user) return c.json({ error: 'client_auth_required' }, 401)
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'formulario_invalido' }, 400)
  const tipo = String(form.get('tipo') || '')
  const referenciaId = String(form.get('referencia_id') || '').trim()
  const observacao = String(form.get('observacao') || '').trim().slice(0, 500)
  const arquivo = form.get('arquivo') as unknown
  if (!['rateio', 'abastecimento'].includes(tipo) || !referenciaId) return c.json({ error: 'parametros_invalidos' }, 400)
  if (!(arquivo instanceof File)) return c.json({ error: 'arquivo_obrigatorio' }, 400)
  const ext = TIPOS_PERMITIDOS[arquivo.type]
  if (!ext) return c.json({ error: 'tipo_arquivo_nao_permitido' }, 400)
  if (arquivo.size > MAX_ARQUIVO_BYTES) return c.json({ error: 'arquivo_muito_grande' }, 400)

  const db = c.env.SHARE_DB
  const chave = `portal-cliente/comprovantes/${tipo}/${referenciaId}/${crypto.randomUUID()}.${ext}`
  const marcador = `${MARCADOR_COMPROVANTE} ${new Date().toISOString()} ${chave}${observacao ? ` — ${observacao}` : ''}`
  let descricao = ''

  if (tipo === 'abastecimento') {
    const row = await db.prepare('SELECT id, valor_total, data, local FROM abastecimentos WHERE id = ?1 AND (cliente_id = ?2 OR socio_id = ?3)')
      .bind(referenciaId, user.cliente_id, user.socio_id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'referencia_nao_encontrada' }, 404)
    await c.env.SHARE_FILES.put(chave, arquivo.stream(), { httpMetadata: { contentType: arquivo.type } })
    await db.prepare("UPDATE abastecimentos SET observacao = trim(COALESCE(observacao, '') || char(10) || ?1), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2")
      .bind(marcador, referenciaId).run()
    descricao = `Abastecimento ${row.local || ''} em ${row.data || ''}`
  } else if (user.cliente_id) {
    const row = await db.prepare(`SELECT r.id, r.cotista_id, r.valor_rateado_centavos, r.valor_pago_real_centavos, r.descricao_despesa
        FROM rateio_despesas r JOIN cotista_aeronave ca ON ca.id = r.cotista_id
       WHERE r.id = ?1 AND ca.cliente_id = ?2`).bind(referenciaId, user.cliente_id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'referencia_nao_encontrada' }, 404)
    const pendente = await db.prepare("SELECT id FROM rateio_pagamentos WHERE rateio_id = ?1 AND status = 'PENDENTE' LIMIT 1").bind(referenciaId).first()
    if (pendente) return c.json({ error: 'baixa_ja_solicitada' }, 409)
    const valor = Math.max(1, Number(row.valor_rateado_centavos || 0) - Number(row.valor_pago_real_centavos || 0))
    await c.env.SHARE_FILES.put(chave, arquivo.stream(), { httpMetadata: { contentType: arquivo.type } })
    await db.prepare(`INSERT INTO rateio_pagamentos (id, rateio_id, tipo_pagador, pagador_cotista_id, valor_centavos, data_pagamento, comprovante_url, forma_pagamento, status, observacoes, criado_por, criado_em)
      VALUES (?1, ?2, 'COTISTA', ?3, ?4, ?5, ?6, 'COMPROVANTE_PORTAL', 'PENDENTE', ?7, ?8, CURRENT_TIMESTAMP)`)
      .bind(crypto.randomUUID(), referenciaId, row.cotista_id, valor, new Date().toISOString().slice(0, 10), chave, observacao || 'Solicitação de baixa enviada pelo Portal Cliente', `portal:${user.id}`).run()
    descricao = String(row.descricao_despesa || 'Despesa')
  } else {
    const row = await db.prepare('SELECT id, descricao_despesa FROM rateio_hold WHERE id = ?1 AND socio_id = ?2').bind(referenciaId, user.socio_id).first<Record<string, unknown>>()
    if (!row) return c.json({ error: 'referencia_nao_encontrada' }, 404)
    await c.env.SHARE_FILES.put(chave, arquivo.stream(), { httpMetadata: { contentType: arquivo.type } })
    await db.prepare("UPDATE rateio_hold SET observacoes = trim(COALESCE(observacoes, '') || char(10) || ?1), atualizado_em = CURRENT_TIMESTAMP WHERE id = ?2")
      .bind(marcador, referenciaId).run()
    descricao = String(row.descricao_despesa || 'Despesa')
  }

  let notificado = true
  try {
    await portalTelegram(c as any, `<b>Comprovante enviado pelo Portal Cliente</b>\nCliente: ${user.nome_exibicao || user.login}\nTipo: ${tipo}\nReferência: ${descricao}\nID: <code>${referenciaId}</code>\nSolicitação de baixa aguardando conferência.`)
  } catch {
    notificado = false
  }
  return c.json({ success: true, arquivo: chave, notificado }, 201)
})
