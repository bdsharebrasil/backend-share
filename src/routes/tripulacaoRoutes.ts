import { Context, Hono } from 'hono'
import { requireShareInternal } from '../lib/auth'
import { uuid } from '../lib/strings'
import { buscarResumoOperacaoBanco, resumirJornada } from '../lib/resumoJornadaOperacao'

type Bindings = {
  SHARE_DB: D1Database
  JORNADA_LIMITE_DIARIO_MINUTOS?: string
  SHARE_FILES?: R2Bucket
  FILES?: R2Bucket
  CACHE_KV?: KVNamespace
  RATE_LIMITER?: DurableObjectNamespace
  INTERNAL_TOKEN?: string
}

export async function buscarTripulante(c: Context<{ Bindings: Bindings; Variables: Variables }>, id: string) {
  const tripulante = await c.env.SHARE_DB.prepare(`SELECT t.id, t.nome_completo, t.canac, t.status, t.tipo_licenca FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id WHERE t.id = ?1 AND lower(COALESCE(t.status, 'ativo')) = 'ativo' AND lower(COALESCE(up.status, 'ativo')) NOT IN ('inativo', 'inactive')`).bind(id).first<{ id: string; nome_completo: string; canac: string | null; status: string | null; tipo_licenca: string | null }>()
  if (tripulante) return { ...tripulante, origem: 'tripulacao' as const }
  const freelancer = await c.env.SHARE_DB.prepare('SELECT id, nome_completo, canac, status, NULL AS tipo_licenca FROM tripulacao_freelancer WHERE id = ?1').bind(id).first<{ id: string; nome_completo: string; canac: string | null; status: string | null; tipo_licenca: string | null }>()
  return freelancer ? { ...freelancer, origem: 'freelancer' as const } : null
}

type Variables = Record<string, never>

export const tripulacaoRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function bucketColaborador(c: Context<{ Bindings: Bindings; Variables: Variables }>): R2Bucket {
  return c.env.SHARE_FILES || c.env.FILES || ({} as R2Bucket)
}

function bucketParaChaveColaborador(c: Context<{ Bindings: Bindings; Variables: Variables }>, key: string): R2Bucket {
  return key.startsWith('avatar_profiles/') || key.startsWith('documentos_colaboradores/') ? bucketColaborador(c) : c.env.FILES || ({} as R2Bucket)
}

function ehCma(tipo: string | null | undefined) {
  return String(tipo || '').trim().toUpperCase() === 'CMA'
}

// Relatório histórico, sem alteração das rotas de gravação ou bloqueios legais.
tripulacaoRoutes.get('/api/interno/agendamento/:id/resumo-jornada', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const resumo = await buscarResumoOperacaoBanco(c.env.SHARE_DB, c.req.param('id'), c.env.JORNADA_LIMITE_DIARIO_MINUTOS)
  return resumo ? c.json(resumo) : c.notFound()
})

tripulacaoRoutes.get('/api/interno/tripulacao/:id/jornadas', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = c.env.SHARE_DB
  const tripulanteId = c.req.param('id')
  const inicio = c.req.query('inicio') || '2000-01-01'
  const fim = c.req.query('fim') || '2099-12-31'
  const tripulante = await db.prepare(`SELECT COALESCE(t.nome_completo, f.nome_completo) AS nome_completo,
      COALESCE(t.canac, f.canac) AS canac
    FROM (SELECT ?1 AS id) x
    LEFT JOIN tripulacao t ON t.id = x.id
    LEFT JOIN tripulacao_freelancer f ON f.id = x.id`).bind(tripulanteId).first<{ nome_completo: string | null; canac: string | null }>()
  if (!tripulante?.nome_completo) return c.notFound()
  const jornadas = await db.prepare(`SELECT j.id, j.solicitacao_id, j.aeronave_id, j.tripulante_id, j.funcao_tripulante,
      j.jornada_principal_id, j.numero_jornada, j.data, j.horario_acionamento, j.horario_apresentacao,
      j.horario_pouso, j.horario_corte, j.minutos_pos_corte, j.minutos_jornada, j.nivel_alerta, j.status,
      j.observacoes, s.numero_voo, s.origem, s.destino, a.matricula_registro, a.modelo
    FROM jornadas_voo j
    LEFT JOIN solicitacoes_reserva_voo s ON s.id = j.solicitacao_id
    LEFT JOIN aeronave a ON a.id = j.aeronave_id
    WHERE j.tripulante_id = ?1 AND date(j.data) BETWEEN date(?2) AND date(?3)
    ORDER BY date(j.data) DESC, j.numero_jornada DESC`).bind(tripulanteId, inicio, fim).all<any>()
  const resultado = await Promise.all((jornadas.results || []).map(async (jornada: any) => {
    const pernas = await db.prepare(`SELECT id, jornada_id, numero, origem, destino, 0 AS numero_passageiros,
        horario_ac, horario_dep, horario_pouso, horario_corte, status, lancamento_diario_id
      FROM pernas_jornada_voo
      WHERE jornada_id = ?1 OR (jornada_id = ?2 AND NOT EXISTS (SELECT 1 FROM pernas_jornada_voo WHERE jornada_id = ?1))
      ORDER BY numero`).bind(jornada.id, jornada.jornada_principal_id || jornada.id).all<any>()
    const resumo = resumirJornada(jornada, pernas.results || [])
    return { ...jornada, horario_encerramento: resumo.encerramento, minutos_reais: resumo.minutos_reais,
      tripulante_nome: tripulante.nome_completo, pernas: pernas.results || [], historico: [] }
  }))
  return c.json({ tripulante_id: tripulanteId, tripulante_nome: tripulante.nome_completo, canac: tripulante.canac, inicio, fim, jornadas: resultado })
})

tripulacaoRoutes.get('/api/interno/tripulacao/gestao', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const db = c.env.SHARE_DB
  const [tripulantes, habilitacoes, freelancers, aeronave] = await Promise.all([
    db.prepare(`SELECT t.id, t.user_id, t.canac, t.nome_completo, t.status, t.tipo_licenca, up.email, up.telefone, up.url_avatar, up.departamento, CASE WHEN up.url_avatar IS NOT NULL THEN '/api/interno/tripulacao/' || t.id || '/foto' ELSE NULL END AS foto_url FROM tripulacao t LEFT JOIN user_profiles up ON up.id = t.user_id ORDER BY t.nome_completo`).all(),
    db.prepare('SELECT * FROM habilitacoes_tripulante ORDER BY data_validade, validade_cma').all(),
    db.prepare('SELECT f.*, a.matricula_registro, a.fabricante, a.modelo FROM tripulacao_freelancer f LEFT JOIN aeronave a ON a.id = f.aeronave_id ORDER BY f.nome_completo').all(),
    db.prepare('SELECT id, matricula_registro, fabricante, modelo, tipo_aeronave, numero_motores, status FROM aeronave ORDER BY matricula_registro').all(),
  ])
  return c.json({ tripulantes: tripulantes.results, habilitacoes: habilitacoes.results, freelancers: freelancers.results, aeronaves: aeronave.results })
})

tripulacaoRoutes.patch('/api/interno/tripulacao/:id/fs-rh', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'fs_rh')) return c.json({ error: 'fs_rh_obrigatorio' }, 400)
  const rawFsRh = (body as { fs_rh?: unknown }).fs_rh
  if (rawFsRh !== null && typeof rawFsRh !== 'string') return c.json({ error: 'fs_rh_invalido' }, 400)
  const fsRh = typeof rawFsRh === 'string' ? rawFsRh.trim().toUpperCase() || null : null
  if (fsRh && !/^(AB|A|B|O)[+-]$/.test(fsRh)) return c.json({ error: 'fs_rh_invalido' }, 400)

  const tripulanteId = c.req.param('id')
  const tripulante = await c.env.SHARE_DB.prepare('SELECT id FROM tripulacao WHERE id = ?1').bind(tripulanteId).first()
  if (!tripulante) return c.notFound()

  const registros = await c.env.SHARE_DB.prepare('SELECT id, tipo_habilitacao FROM habilitacoes_tripulante WHERE tripulacao_id = ?1').bind(tripulanteId).all<{ id: string; tipo_habilitacao: string }>()
  const registrosReais = (registros.results || []).filter((item) => item.tipo_habilitacao.trim().toUpperCase() !== 'FS/RH')
  if (registrosReais.length) {
    await c.env.SHARE_DB.prepare('UPDATE habilitacoes_tripulante SET fs_rh = CASE WHEN id = ?1 THEN ?2 ELSE NULL END WHERE tripulacao_id = ?3').bind(registrosReais[0].id, fsRh, tripulanteId).run()
    await c.env.SHARE_DB.prepare("DELETE FROM habilitacoes_tripulante WHERE tripulacao_id = ?1 AND upper(trim(tipo_habilitacao)) = 'FS/RH'").bind(tripulanteId).run()
  } else if (fsRh) {
    const marker = registros.results?.[0]
    if (marker) {
      await c.env.SHARE_DB.prepare('UPDATE habilitacoes_tripulante SET fs_rh = ?1 WHERE id = ?2').bind(fsRh, marker.id).run()
    } else {
      await c.env.SHARE_DB.prepare('INSERT INTO habilitacoes_tripulante (id, tripulacao_id, tipo_habilitacao, data_validade, classe_cma, validade_cma, fs_rh) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uuid(), tripulanteId, 'FS/RH', null, null, null, fsRh).run()
    }
  } else {
    await c.env.SHARE_DB.prepare("DELETE FROM habilitacoes_tripulante WHERE tripulacao_id = ?1 AND upper(trim(tipo_habilitacao)) = 'FS/RH'").bind(tripulanteId).run()
  }

  return c.json({ success: true, fs_rh: fsRh })
})

tripulacaoRoutes.get('/api/interno/tripulacao-freelancer/:id/foto', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const row = await c.env.SHARE_DB.prepare('SELECT url_avatar FROM tripulacao_freelancer WHERE id = ?1').bind(c.req.param('id')).first<{ url_avatar: string | null }>()
  if (!row?.url_avatar) return c.notFound()
  if (/^https?:\/\//i.test(row.url_avatar)) return c.redirect(row.url_avatar, 302)
  const object = await bucketParaChaveColaborador(c, row.url_avatar).get(row.url_avatar)
  if (!object) return c.notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=300')
  return new Response(object.body, { headers })
})

tripulacaoRoutes.get('/api/interno/tripulacao/:id/foto', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const row = await c.env.SHARE_DB.prepare(`SELECT up.url_avatar
    FROM tripulacao t
    LEFT JOIN user_profiles up ON up.id = COALESCE(t.user_id, (
      SELECT p.id FROM user_profiles p
      WHERE (NULLIF(trim(t.canac), '') IS NOT NULL AND lower(trim(p.canac)) = lower(trim(t.canac)))
         OR lower(trim(p.nome_completo)) = lower(trim(t.nome_completo))
      ORDER BY CASE WHEN NULLIF(trim(t.canac), '') IS NOT NULL AND lower(trim(p.canac)) = lower(trim(t.canac)) THEN 0 ELSE 1 END, p.id
      LIMIT 1
    ))
    WHERE t.id = ?1`).bind(c.req.param('id')).first<{ url_avatar: string | null }>()
  const avatar = row?.url_avatar?.trim() || ''
  if (!avatar) return c.notFound()
  if (/^https?:\/\//i.test(avatar)) return c.redirect(avatar, 302)
  const object = await bucketParaChaveColaborador(c, avatar).get(avatar)
  if (!object) return c.notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=300')
  return new Response(object.body, { headers })
})

tripulacaoRoutes.patch('/api/interno/tripulacao/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ canac?: string; nome_completo?: string; status?: string; tipo_licenca?: string }>().catch(() => ({} as any))
  const result = await c.env.SHARE_DB.prepare('UPDATE tripulacao SET canac = COALESCE(?1, canac), nome_completo = COALESCE(?2, nome_completo), status = COALESCE(?3, status), tipo_licenca = COALESCE(?4, tipo_licenca) WHERE id = ?5').bind(body.canac?.trim() || null, body.nome_completo?.trim() || null, body.status?.trim() || null, body.tipo_licenca?.trim() || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

tripulacaoRoutes.post('/api/interno/tripulacao/:id/habilitacoes', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ tipo_habilitacao?: string; data_validade?: string; classe_cma?: string; validade_cma?: string; fs_rh?: string }>().catch(() => ({} as any))
  if (!body.tipo_habilitacao?.trim()) return c.json({ error: 'tipo_habilitacao_obrigatorio' }, 400)
  const tripulante = await c.env.SHARE_DB.prepare('SELECT id FROM tripulacao WHERE id = ?1').bind(c.req.param('id')).first()
  if (!tripulante) return c.notFound()
  const id = uuid()
  const tipo = body.tipo_habilitacao.trim()
  const cma = ehCma(tipo)
  await c.env.SHARE_DB.prepare('INSERT INTO habilitacoes_tripulante (id, tripulacao_id, tipo_habilitacao, data_validade, classe_cma, validade_cma, fs_rh) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, c.req.param('id'), cma ? 'CMA' : tipo, cma ? null : body.data_validade || null, cma ? body.classe_cma?.trim() || null : null, cma ? body.validade_cma || body.data_validade || null : null, body.fs_rh?.trim() || null).run()
  return c.json({ id, ...body }, 201)
})

tripulacaoRoutes.patch('/api/interno/tripulacao/habilitacoes/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<{ tipo_habilitacao?: string; data_validade?: string | null; classe_cma?: string | null; validade_cma?: string | null; fs_rh?: string | null }>().catch(() => ({} as any))
  const current = await c.env.SHARE_DB.prepare('SELECT tipo_habilitacao, data_validade, classe_cma, validade_cma, fs_rh FROM habilitacoes_tripulante WHERE id = ?1').bind(c.req.param('id')).first<{ tipo_habilitacao: string; data_validade: string | null; classe_cma: string | null; validade_cma: string | null; fs_rh: string | null }>()
  if (!current) return c.notFound()
  const tipo = body.tipo_habilitacao?.trim() || current.tipo_habilitacao
  const cma = ehCma(tipo)
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key)
  const dataValidade = cma ? null : has('data_validade') ? body.data_validade || null : current.data_validade
  const classeCma = cma ? (has('classe_cma') ? body.classe_cma?.trim() || null : current.classe_cma) : null
  const validadeCma = cma ? (has('validade_cma') ? body.validade_cma || null : current.validade_cma) : null
  const fsRh = has('fs_rh') ? body.fs_rh?.trim() || null : current.fs_rh
  const result = await c.env.SHARE_DB.prepare('UPDATE habilitacoes_tripulante SET tipo_habilitacao = ?1, data_validade = ?2, classe_cma = ?3, validade_cma = ?4, fs_rh = ?5 WHERE id = ?6').bind(tipo, dataValidade, classeCma, validadeCma, fsRh, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

tripulacaoRoutes.post('/api/interno/tripulacao-freelancer', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  if (!body.nome_completo?.trim() || !body.canac?.trim()) return c.json({ error: 'nome_e_canac_obrigatorios' }, 400)
  const id = uuid()
  await c.env.SHARE_DB.prepare('INSERT INTO tripulacao_freelancer (id, canac, nome_completo, data_nascimento, url_avatar, status, rg, cpf, endereco, cidade, uf, telefone, aeronave_id, observacao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.canac.trim(), body.nome_completo.trim(), body.data_nascimento || null, body.url_avatar || null, body.status || 'ativo', body.rg || null, body.cpf || null, body.endereco || null, body.cidade || null, body.uf || null, body.telefone || null, body.aeronave_id || null, body.observacao || null).run()
  return c.json({ id, ...body, origem: 'freelancer' }, 201)
})

tripulacaoRoutes.patch('/api/interno/tripulacao-freelancer/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const body = await c.req.json<Record<string, any>>().catch(() => ({} as any))
  const result = await c.env.SHARE_DB.prepare('UPDATE tripulacao_freelancer SET canac = COALESCE(?1, canac), nome_completo = COALESCE(?2, nome_completo), telefone = ?3, aeronave_id = ?4, observacao = ?5, status = COALESCE(?6, status) WHERE id = ?7').bind(body.canac?.trim() || null, body.nome_completo?.trim() || null, body.telefone || null, body.aeronave_id || null, body.observacao || null, body.status || null, c.req.param('id')).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

tripulacaoRoutes.delete('/api/interno/tripulacao-freelancer/:id', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const id = c.req.param('id').trim()
  if (!id) return c.json({ error: 'tripulante_id_obrigatorio' }, 400)
  const result = await c.env.SHARE_DB.prepare('DELETE FROM tripulacao_freelancer WHERE id = ?1').bind(id).run()
  if (!result.meta.changes) return c.notFound()
  return c.json({ success: true })
})

tripulacaoRoutes.get('/api/interno/tripulacao/horas', async c => {
  if (!(await requireShareInternal(c))) return c.json({ error: 'internal_auth_required' }, 401)
  const mes = (c.req.query('mes') || '').trim()
  const inicio = c.req.query('inicio') || (/^\d{4}-\d{2}$/.test(mes) ? `${mes}-01` : '1900-01-01')
  const fim = c.req.query('fim') || (/^\d{4}-\d{2}$/.test(mes) ? `${mes}-31` : '2999-12-31')
  const aircraft = (c.req.query('aeronave_id') || '').trim()
  const canac = (c.req.query('canac') || '').trim()
  try {
    const filters = ['date(l.data_registro) BETWEEN ? AND ?']
    const binds: string[] = [inicio, fim]
    if (aircraft) {
      filters.push('l.aeronave_id = ?')
      binds.push(aircraft)
    }
    if (canac) {
      const identities = await c.env.SHARE_DB.prepare(`
        SELECT id, canac, nome_completo FROM tripulacao
        WHERE lower(id) = lower(?1) OR upper(canac) = upper(?1) OR upper(nome_completo) = upper(?1)
        UNION ALL
        SELECT id, canac, nome_completo FROM tripulacao_freelancer
        WHERE lower(id) = lower(?1) OR upper(canac) = upper(?1) OR upper(nome_completo) = upper(?1)
      `).bind(canac).all<{ id: string; canac: string; nome_completo: string }>()
      const values = [...new Set([canac, ...identities.results.flatMap((item) => [item.id, item.canac, item.nome_completo]).filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase())])]
      const placeholders = values.map(() => '?').join(', ')
      filters.push(`(lower(COALESCE(l.pic_canac, '')) IN (${placeholders}) OR lower(COALESCE(l.sic_canac, '')) IN (${placeholders}))`)
      binds.push(...values, ...values)
    }
    const query = `SELECT l.id, l.data_registro, l.aeronave_id, l.numero_voo,
      l.aerodromo_partida, l.aerodromo_chegada, l.trecho, l.pic_canac, l.pic_nome,
      l.sic_canac, l.sic_nome, l.tempo_total, l.tempo_voo, l.tempo_ifr,
      l.horas_noturnas, a.matricula_registro,
      COALESCE((SELECT t.canac FROM tripulacao t WHERE lower(t.id) = lower(l.pic_canac) OR upper(t.canac) = upper(l.pic_canac) OR upper(t.nome_completo) = upper(l.pic_canac) LIMIT 1), (SELECT f.canac FROM tripulacao_freelancer f WHERE lower(f.id) = lower(l.pic_canac) OR upper(f.canac) = upper(l.pic_canac) OR upper(f.nome_completo) = upper(l.pic_canac) LIMIT 1), l.pic_canac) AS pic_canac_exibicao,
      COALESCE((SELECT t.nome_completo FROM tripulacao t WHERE lower(t.id) = lower(l.pic_canac) OR upper(t.canac) = upper(l.pic_canac) OR upper(t.nome_completo) = upper(l.pic_canac) LIMIT 1), (SELECT f.nome_completo FROM tripulacao_freelancer f WHERE lower(f.id) = lower(l.pic_canac) OR upper(f.canac) = upper(l.pic_canac) OR upper(f.nome_completo) = upper(l.pic_canac) LIMIT 1), l.pic_nome) AS pic_nome_exibicao,
      COALESCE((SELECT t.canac FROM tripulacao t WHERE lower(t.id) = lower(l.sic_canac) OR upper(t.canac) = upper(l.sic_canac) OR upper(t.nome_completo) = upper(l.sic_canac) LIMIT 1), (SELECT f.canac FROM tripulacao_freelancer f WHERE lower(f.id) = lower(l.sic_canac) OR upper(f.canac) = upper(l.sic_canac) OR upper(f.nome_completo) = upper(l.sic_canac) LIMIT 1), l.sic_canac) AS sic_canac_exibicao,
      COALESCE((SELECT t.nome_completo FROM tripulacao t WHERE lower(t.id) = lower(l.sic_canac) OR upper(t.canac) = upper(l.sic_canac) OR upper(t.nome_completo) = upper(l.sic_canac) LIMIT 1), (SELECT f.nome_completo FROM tripulacao_freelancer f WHERE lower(f.id) = lower(l.sic_canac) OR upper(f.canac) = upper(l.sic_canac) OR upper(f.nome_completo) = upper(l.sic_canac) LIMIT 1), l.sic_nome) AS sic_nome_exibicao
      FROM lancamentos_diario_bordo l LEFT JOIN aeronave a ON a.id = l.aeronave_id
      WHERE ${filters.join(' AND ')} ORDER BY date(l.data_registro) DESC`
    const result = await c.env.SHARE_DB.prepare(query).bind(...binds).all<any>()
    const voos = result.results.map((row: any) => ({ id: row.id, data_registro: row.data_registro, matricula_registro: row.matricula_registro, aeronave_id: row.aeronave_id, numero_voo: row.numero_voo || null, aerodromo_partida: row.aerodromo_partida || null, aerodromo_chegada: row.aerodromo_chegada || null, trecho: row.trecho || null, pic_canac: row.pic_canac_exibicao || row.pic_canac, pic_nome: row.pic_nome_exibicao || row.pic_nome, sic_canac: row.sic_canac_exibicao || row.sic_canac, sic_nome: row.sic_nome_exibicao || row.sic_nome, tempo_total: Number(row.tempo_total || row.tempo_voo || 0), tempo_ifr: Number(row.tempo_ifr || 0), horas_noturnas: Number(row.horas_noturnas || 0), horas_diurnas: Math.max(0, Number(row.tempo_total || row.tempo_voo || 0) - Number(row.tempo_ifr || 0) - Number(row.horas_noturnas || 0)) }))
    const totals = new Map<string, any>(); const porAeronave = new Map<string, any>()
    const add = (canacTripulante: string | null, nome: string | null, role: 'PIC' | 'SIC', row: any) => {
      if (!canacTripulante && !nome) return
      const tempoTotal = row.tempo_total; const tempoIfr = row.tempo_ifr; const horasNoturnas = row.horas_noturnas; const horasDiurnas = Math.max(0, tempoTotal - tempoIfr - horasNoturnas)
      const key = `${role}:${canacTripulante || nome}`; const current = totals.get(key) || { canac: canacTripulante || null, nome: nome || canacTripulante || 'Tripulante', funcao: role, horas_totais: 0, horas_pic: 0, horas_sic: 0, horas_diurnas: 0, horas_computaveis: 0, horas_noturnas: 0, horas_ifr: 0, voos: 0 }
      current.horas_totais += tempoTotal; current[`horas_${role.toLowerCase()}`] += tempoTotal; current.horas_diurnas += horasDiurnas; current.horas_computaveis += horasDiurnas; current.horas_noturnas += horasNoturnas; current.horas_ifr += tempoIfr; current.voos += 1; totals.set(key, current)
      const aircraftKey = row.aeronave_id || row.matricula_registro || 'sem-aeronave'; const aircraft = porAeronave.get(aircraftKey) || { aeronave_id: row.aeronave_id || null, matricula_registro: row.matricula_registro || 'Sem matrícula', voos: 0, pic: { voos: 0, horas_totais: 0, horas_diurnas: 0, horas_computaveis: 0, horas_noturnas: 0, horas_ifr: 0 }, sic: { voos: 0, horas_totais: 0, horas_diurnas: 0, horas_computaveis: 0, horas_noturnas: 0, horas_ifr: 0 } }
      const bucket = aircraft[role.toLowerCase()]; bucket.voos += 1; bucket.horas_totais += tempoTotal; bucket.horas_diurnas += horasDiurnas; bucket.horas_computaveis += horasDiurnas; bucket.horas_noturnas += horasNoturnas; bucket.horas_ifr += tempoIfr
      if (role === 'PIC' || !row.pic_canac || (canac && String(canacTripulante || '').toUpperCase() === canac.toUpperCase())) aircraft.voos += 1
      porAeronave.set(aircraftKey, aircraft)
    }
    for (const row of voos) { if (!canac || String(row.pic_canac || '').toUpperCase() === canac.toUpperCase() || String(row.pic_nome || '').toUpperCase() === canac.toUpperCase()) add(row.pic_canac, row.pic_nome, 'PIC', row); if (!canac || String(row.sic_canac || '').toUpperCase() === canac.toUpperCase() || String(row.sic_nome || '').toUpperCase() === canac.toUpperCase()) add(row.sic_canac, row.sic_nome, 'SIC', row) }
    const round = (value: number) => Math.round(value * 100) / 100
    const arredondar = (item: any): any => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? round(value as number) : typeof value === 'object' && value ? arredondar(value) : value]))
    return c.json({ inicio, fim, voos, totais: [...totals.values()].map(arredondar), por_aeronave: [...porAeronave.values()].map(arredondar) })
  } catch (error) {
    console.error('tripulacao_horas_query_failed', { mes, inicio, fim, aircraft, canac, error })
    return c.json({ error: 'tripulacao_horas_indisponiveis', detail: 'Não foi possível consultar as horas de voo neste momento.' }, 503)
  }
})
