/**
 * Espelha cada perna da jornada no Diário de Bordo, sem assinar nem confirmar.
 * Fonte única dos horários: pernas_jornada_voo. Um ID determinístico por perna
 * torna a operação idempotente mesmo quando a mesma requisição é repetida.
 */
export type ResultadoDiarioAutomatico = {
  status: 'rascunho' | 'assinado' | 'aguardando_ac' | 'mes_fechado' | 'dados_incompletos'
  lancamento_id?: string
  diario_mes_id?: string
  detalhe?: string
}

type VooPerna = {
  id: string; lancamento_diario_id: string | null; jornada_id: string; origem: string; destino: string
  horario_ac: string | null; horario_dep: string | null; horario_pouso: string | null; horario_corte: string | null
  passageiros: number | null; data_jornada: string; horario_apresentacao: string | null
  aeronave_id: string; cliente_referencia: string | null; socio_referencia: string | null
  numero_voo: string | null; pic_canac: string | null; pic_nome: string | null
  sic_canac: string | null; sic_nome: string | null; consumo_combustivel: number | null
}
const numero = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0
const arredondar = (value: number) => Number(value.toFixed(2))
const hhmm = (value: string | null) => value ? value.slice(11, 16) : null
const horas = (inicio: string | null, fim: string | null) => {
  if (!inicio || !fim) return 0
  const a = Date.parse(inicio), b = Date.parse(fim)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? arredondar((b - a) / 3_600_000) : 0
}
const erroDeDados = (detail: string): ResultadoDiarioAutomatico => ({ status: 'dados_incompletos', detalhe: detail })

/** Somente fonte operacional. Não aceita payload do cliente e nunca modifica registro assinado. */
export async function sincronizarDiarioDaPerna(db: D1Database, pernaId: string, usuarioId: string | null): Promise<ResultadoDiarioAutomatico> {
  const p = await db.prepare(`
    SELECT p.id, p.lancamento_diario_id, p.jornada_id, p.origem, p.destino, p.horario_ac,
      p.horario_dep, p.horario_pouso, p.horario_corte, p.passageiros,
      j.data AS data_jornada, j.horario_apresentacao,
      s.aeronave_id, s.cliente_id AS cliente_referencia, s.socio_id AS socio_referencia, s.numero_voo,
      COALESCE(pic.canac, pf.canac) AS pic_canac, COALESCE(pic.nome_completo, pf.nome_completo) AS pic_nome,
      COALESCE(sic.canac, sf.canac) AS sic_canac, COALESCE(sic.nome_completo, sf.nome_completo) AS sic_nome,
      a.consumo_combustivel
    FROM pernas_jornada_voo p
    JOIN jornadas_voo j ON j.id = p.jornada_id
    JOIN solicitacoes_reserva_voo s ON s.id = j.solicitacao_id
    JOIN aeronave a ON a.id = s.aeronave_id
    LEFT JOIN tripulacao pic ON pic.id = s.piloto_id
    LEFT JOIN tripulacao_freelancer pf ON pf.id = s.piloto_id
    LEFT JOIN tripulacao sic ON sic.id = s.copiloto_id
    LEFT JOIN tripulacao_freelancer sf ON sf.id = s.copiloto_id
    WHERE p.id = ?1 LIMIT 1
  `).bind(pernaId).first<VooPerna>()
  if (!p) return erroDeDados('Perna, jornada ou aeronave não encontrada.')
  if (!p.horario_ac) return { status: 'aguardando_ac', detalhe: 'O rascunho será criado após registrar o acionamento (AC).' }
  const dia = String(p.horario_ac).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !p.aeronave_id || !p.origem || !p.destino) {
    return erroDeDados('Data UTC, aeronave ou rota não informadas na perna.')
  }
  const ano = Number(dia.slice(0, 4)), mes = Number(dia.slice(5, 7))
  const dbMes = await db.prepare('SELECT id, fechado FROM diario_mes WHERE aeronave_id = ?1 AND ano = ?2 AND mes = ?3 ORDER BY id LIMIT 1').bind(p.aeronave_id, ano, mes).first<{ id: string; fechado: number }>()
  if (dbMes && numero(dbMes.fechado) !== 0) return { status: 'mes_fechado', diario_mes_id: dbMes.id, detalhe: 'O Diário de Bordo da aeronave está fechado neste mês.' }

  let diarioMesId = dbMes?.id
  if (!diarioMesId) {
    const anterior = await db.prepare(`
      SELECT celula_atual_ttotal, celula_atual_tvoo, celula_prox_revisao_ttotal, celula_prox_revisao_tvoo,
        horimetro_final, aerodromo_base, consumo_combustivel, tem_tarifa_diaria, tarifa_diaria, modo_celula
      FROM diario_mes WHERE aeronave_id = ?1 AND (ano < ?2 OR (ano = ?2 AND mes < ?3))
      ORDER BY ano DESC, mes DESC LIMIT 1
    `).bind(p.aeronave_id, ano, mes).first<Record<string, any>>()
    // ID estável: duas requisições simultâneas para o mesmo mês não abrem
    // dois diários. O valor inicial é herdado do mês anterior quando existe.
    const id = `auto-${p.aeronave_id}-${String(ano)}${String(mes).padStart(2, '0')}`
    const baseTotal = numero(anterior?.celula_atual_ttotal), baseVoo = numero(anterior?.celula_atual_tvoo)
    await db.prepare(`
      INSERT OR IGNORE INTO diario_mes
      (id, aeronave_id, ano, mes, celula_anterior_ttotal, celula_atual_ttotal,
       celula_prox_revisao_ttotal, celula_disponivel_ttotal, horimetro_inicio,
       horimetro_final, horimetro_ativo, fechado, aerodromo_base, tarifa_diaria,
       consumo_combustivel, tem_tarifa_diaria, celula_atual_tvoo, celula_disponivel_tvoo,
       celula_anterior_tvoo, celula_prox_revisao_tvoo, modo_celula)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).bind(
      id, p.aeronave_id, ano, mes, baseTotal, baseTotal,
      numero(anterior?.celula_prox_revisao_ttotal), numero(anterior?.horimetro_final),
      numero(anterior?.horimetro_final), anterior?.aerodromo_base || null,
      numero(anterior?.tarifa_diaria), anterior?.consumo_combustivel || null,
      anterior?.tem_tarifa_diaria == null ? 1 : Number(anterior.tem_tarifa_diaria),
      baseVoo, baseVoo, numero(anterior?.celula_prox_revisao_tvoo),
      anterior?.modo_celula === 'tvoo' ? 'tvoo' : 'tempo_total',
    ).run()
    const aberto = await db.prepare('SELECT id, fechado FROM diario_mes WHERE aeronave_id = ?1 AND ano = ?2 AND mes = ?3 ORDER BY id LIMIT 1').bind(p.aeronave_id, ano, mes).first<{ id: string; fechado: number }>()
    if (!aberto) return erroDeDados('Não foi possível abrir o diário da competência da aeronave.')
    if (numero(aberto.fechado) !== 0) return { status: 'mes_fechado', diario_mes_id: aberto.id }
    diarioMesId = aberto.id
  }

  const assinatura = p.lancamento_diario_id
    ? await db.prepare('SELECT id, confirmado, assinado_pic, diario_mes_id FROM lancamentos_diario_bordo WHERE id = ?1').bind(p.lancamento_diario_id).first<{ id: string; confirmado: number; assinado_pic: string | null; diario_mes_id: string }>()
    : null
  if (p.lancamento_diario_id && !assinatura) return erroDeDados('A perna aponta para um lançamento inexistente.')
  if (assinatura && (numero(assinatura.confirmado) !== 0 || assinatura.assinado_pic)) {
    return { status: 'assinado', lancamento_id: assinatura.id, diario_mes_id: assinatura.diario_mes_id }
  }
  // A referência de cliente pode ser uma holding: nunca grave seu ID em
  // cliente_id sem conferir a tabela, para não violar FKs ou alterar o pagador.
  let clienteId: string | null = null, holdingId: string | null = null, socioId: string | null = null
  if (p.cliente_referencia) {
    const cliente = await db.prepare('SELECT id FROM cliente WHERE id = ?1').bind(p.cliente_referencia).first<{ id: string }>()
    if (cliente) clienteId = cliente.id
    else {
      const holding = await db.prepare('SELECT id FROM holdings WHERE id = ?1').bind(p.cliente_referencia).first<{ id: string }>()
      if (holding) holdingId = holding.id
      else return erroDeDados('Cliente/holding do agendamento não encontrado.')
    }
  }
  if (p.socio_referencia) {
    const socio = await db.prepare('SELECT id FROM hold_socios WHERE id = ?1').bind(p.socio_referencia).first<{ id: string }>()
    if (!socio) return erroDeDados('Sócio do agendamento não encontrado.')
    socioId = socio.id
  }

  const tempoVoo = horas(p.horario_dep, p.horario_pouso)
  const tempoTotal = horas(p.horario_ac, p.horario_corte)
  const trecho = `${p.origem} X ${p.destino}`
  const lancamentoId = p.lancamento_diario_id || p.id
  if (!assinatura) {
    const seq = await db.prepare('SELECT COALESCE(MAX(numero_sequencial), 0) + 1 AS proximo FROM lancamentos_diario_bordo WHERE diario_mes_id = ?1').bind(diarioMesId).first<{ proximo: number }>()
    // RASCUNHO: confirmado=0, assinado_pic=NULL, natureza_voo ainda em branco.
    // Tempo diurno/noturno, IFR, combustível e demais detalhes aguardam conferência.
    const criacao = db.prepare(`
      INSERT OR IGNORE INTO lancamentos_diario_bordo
      (id, diario_mes_id, numero_sequencial, aeronave_id, numero_voo, jornada_id,
       cliente_id, holding_id, socio_id, data_registro, aerodromo_partida,
       aerodromo_chegada, trecho, pic_canac, pic_nome, sic_canac, sic_nome,
       tripulacao_checkin_hora, tempo_ac, tempo_dep, tempo_pou, tempo_cor,
       tempo_voo, tempo_total, horas_diurnas, horas_noturnas, pousos_total,
       passageiros, natureza_voo, consumo_combustivel_voo, consumo_combustivel_total,
       confirmado, assinado_pic, data_assinatura, criado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, '', 0, 0, 0, NULL, NULL, ?)
    `).bind(
      lancamentoId, diarioMesId, numero(seq?.proximo || 1), p.aeronave_id,
      p.numero_voo || null, p.jornada_id, clienteId, holdingId, socioId,
      dia, p.origem.toUpperCase(), p.destino.toUpperCase(), trecho,
      p.pic_canac || '', p.pic_nome || null, p.sic_canac || null, p.sic_nome || null,
      hhmm(p.horario_apresentacao), hhmm(p.horario_ac), hhmm(p.horario_dep),
      hhmm(p.horario_pouso), hhmm(p.horario_corte), tempoVoo, tempoTotal,
      p.horario_pouso ? 1 : 0, numero(p.passageiros), usuarioId,
    )
    // Batch: registro e vínculo são atômicos; se houver concorrência, o ID
    // determinístico impede duplicação do mesmo trecho.
    await db.batch([
      criacao,
      db.prepare('UPDATE pernas_jornada_voo SET lancamento_diario_id = ?1 WHERE id = ?2 AND (lancamento_diario_id IS NULL OR lancamento_diario_id = ?1)').bind(lancamentoId, p.id),
    ])
  }
  const lancamento = await db.prepare('SELECT id, confirmado, assinado_pic FROM lancamentos_diario_bordo WHERE id = ?1').bind(lancamentoId).first<{ id: string; confirmado: number; assinado_pic: string | null }>()
  if (!lancamento) return erroDeDados('Rascunho não persistido no D1.')
  if (numero(lancamento.confirmado) !== 0 || lancamento.assinado_pic) return { status: 'assinado', lancamento_id: lancamento.id, diario_mes_id: diarioMesId }
  // Atualizar APENAS os campos operacionais: complementos manuais são mantidos.
  // O mês é o da data de AC; se a data mudar de mês, bloquear a mudança até
  // a operação revisar a competência em vez de mover um lançamento já editado.
  const current = await db.prepare('SELECT diario_mes_id FROM lancamentos_diario_bordo WHERE id = ?1').bind(lancamentoId).first<{ diario_mes_id: string }>()
  if (current?.diario_mes_id !== diarioMesId) return erroDeDados('A data da perna mudou de competência; revise o lançamento no Diário antes de sincronizar.')
  await db.prepare(`
    UPDATE lancamentos_diario_bordo SET
      numero_voo = ?1, jornada_id = ?2, cliente_id = ?3, holding_id = ?4,
      socio_id = ?5, data_registro = ?6, aerodromo_partida = ?7,
      aerodromo_chegada = ?8, trecho = ?9, pic_canac = ?10, pic_nome = ?11,
      sic_canac = ?12, sic_nome = ?13, tripulacao_checkin_hora = ?14,
      tempo_ac = ?15, tempo_dep = ?16, tempo_pou = ?17, tempo_cor = ?18,
      tempo_voo = ?19, tempo_total = ?20
    WHERE id = ?21 AND COALESCE(confirmado, 0) = 0 AND NULLIF(TRIM(COALESCE(assinado_pic, '')), '') IS NULL
  `).bind(
    p.numero_voo || null, p.jornada_id, clienteId, holdingId, socioId, dia,
    p.origem.toUpperCase(), p.destino.toUpperCase(), trecho,
    p.pic_canac || '', p.pic_nome || null, p.sic_canac || null, p.sic_nome || null,
    hhmm(p.horario_apresentacao), hhmm(p.horario_ac), hhmm(p.horario_dep),
    hhmm(p.horario_pouso), hhmm(p.horario_corte), tempoVoo, tempoTotal, lancamentoId,
  ).run()
  await recalcularTotaisDiarioAutomatico(db, diarioMesId)
  return { status: 'rascunho', lancamento_id: lancamentoId, diario_mes_id: diarioMesId }
}

export async function recalcularTotaisDiarioAutomatico(db: D1Database, diarioMesId: string): Promise<void> {
  const mes = await db.prepare(`
    SELECT celula_anterior_ttotal, celula_anterior_tvoo, celula_prox_revisao_ttotal, celula_prox_revisao_tvoo
    FROM diario_mes WHERE id = ?1
  `).bind(diarioMesId).first<Record<string, number>>()
  if (!mes) return
  const rows = await db.prepare(`
    SELECT id, tempo_voo, tempo_total FROM lancamentos_diario_bordo
    WHERE diario_mes_id = ?1 ORDER BY date(data_registro), numero_sequencial, id
  `).bind(diarioMesId).all<{ id: string; tempo_voo: number; tempo_total: number }>()
  let total = numero(mes.celula_anterior_ttotal), voo = numero(mes.celula_anterior_tvoo)
  const updates: D1PreparedStatement[] = []
  for (const row of rows.results || []) {
    total = arredondar(total + numero(row.tempo_total))
    voo = arredondar(voo + numero(row.tempo_voo))
    updates.push(db.prepare('UPDATE lancamentos_diario_bordo SET celula = ?1, celula_tvoo = ?2 WHERE id = ?3').bind(total, voo, row.id))
  }
  if (updates.length) await db.batch(updates)
  const limiteTotal = numero(mes.celula_prox_revisao_ttotal), limiteVoo = numero(mes.celula_prox_revisao_tvoo)
  const proximaTotal = limiteTotal <= 0 && limiteVoo > 0 ? arredondar(total + limiteVoo - voo) : limiteTotal
  const proximaVoo = limiteVoo <= 0 && limiteTotal > 0 ? arredondar(voo + limiteTotal - total) : limiteVoo
  await db.prepare(`
    UPDATE diario_mes SET celula_atual_ttotal = ?1, celula_atual_tvoo = ?2,
    celula_prox_revisao_ttotal = ?3, celula_prox_revisao_tvoo = ?4,
    celula_disponivel_ttotal = ?5, celula_disponivel_tvoo = ?6 WHERE id = ?7
  `).bind(total, voo, proximaTotal, proximaVoo,
    proximaTotal > 0 ? arredondar(proximaTotal - total) : 0,
    proximaVoo > 0 ? arredondar(proximaVoo - voo) : 0, diarioMesId).run()
}
