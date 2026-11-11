import { listarTodos } from './repositories/d1'

/** Dados complementares do fechamento. Não grava, não recalcula rateios e não consulta outra aeronave. */
export async function carregarBalancoOperacional(
  db: D1Database,
  schema: Map<string, Set<string>>,
  aeronaveId: string,
  inicio?: string,
  fim?: string,
) {
  const possui = (t: string, cols: string[]) => cols.every(col => schema.get(t)?.has(col))
  const opcional = (t: string, a: string, col: string) => schema.get(t)?.has(col) ? `${a}.${col}` : 'NULL'
  function periodo(alias: string, coluna: string) {
    const where = [`${alias}.aeronave_id = ?`]
    const params: unknown[] = [aeronaveId]
    if (inicio) { where.push(`date(${alias}.${coluna}) >= date(?)`); params.push(inicio) }
    if (fim) { where.push(`date(${alias}.${coluna}) <= date(?)`); params.push(fim) }
    return { where, params }
  }
  const fontes = {
    voos: possui('lancamentos_diario_bordo', ['id', 'aeronave_id', 'data_registro', 'tempo_total']),
    abastecimentos: possui('abastecimentos', ['id', 'aeronave_id', 'data', 'litros']),
    viagens: possui('relatorio_despesa_viagem', ['id', 'aeronave_id', 'data_inicio', 'total_valor']),
    cotistas: possui('cotista_aeronave', ['id', 'aeronave_id', 'cliente_id', 'socio_id', 'percentual_sociedade']),
  }
  const v = periodo('v', 'data_registro')
  const a = periodo('a', 'data')
  const r = periodo('r', 'data_inicio')
  if (schema.get('abastecimentos')?.has('status')) a.where.push("UPPER(COALESCE(a.status, '')) NOT IN ('CANCELADO', 'CANCELADA')")
  // Relatórios são estatística independente; não são somados novamente ao custo financeiro.
  if (schema.get('relatorio_despesa_viagem')?.has('status')) r.where.push("UPPER(COALESCE(r.status, '')) NOT IN ('CANCELADO', 'CANCELADA', 'RASCUNHO', 'REPROVADO', 'REPROVADA')")
  const destino = opcional('lancamentos_diario_bordo', 'v', 'aerodromo_chegada')
  const partida = opcional('lancamentos_diario_bordo', 'v', 'aerodromo_partida')
  const icao = (campo: string) => possui('aerodromo', ['id', 'designativo_icao'])
    ? `COALESCE((SELECT ad.designativo_icao FROM aerodromo ad WHERE ad.id = ${campo} OR UPPER(ad.designativo_icao) = UPPER(${campo}) ORDER BY ad.id LIMIT 1), ${campo})`
    : campo
  const cotaAtual = schema.get('cotista_aeronave')?.has('status')
    ? "CASE WHEN LOWER(TRIM(ca.status)) IN ('ativo', 'ativa') THEN ca.percentual_sociedade ELSE NULL END"
    : 'ca.percentual_sociedade'
  const [cotistas, voos, abastecimentos, viagens] = await Promise.all([
    fontes.cotistas ? listarTodos(db, `SELECT ca.id, ca.cliente_id, ca.socio_id, ${cotaAtual} AS percentual_sociedade,
      COALESCE(NULLIF(cl.razao_social, ''), NULLIF(hs.nome, ''), ca.id) AS nome,
      hs.holding_id
      FROM cotista_aeronave ca LEFT JOIN cliente cl ON cl.id = ca.cliente_id
      LEFT JOIN hold_socios hs ON hs.id = ca.socio_id
      WHERE ca.aeronave_id = ? ORDER BY ca.id`, aeronaveId) : Promise.resolve([]),
    fontes.voos ? listarTodos(db, `SELECT v.id, v.data_registro AS data, v.tempo_total,
      ${opcional('lancamentos_diario_bordo', 'v', 'cliente_id')} AS cliente_id,
      ${opcional('lancamentos_diario_bordo', 'v', 'socio_id')} AS socio_id,
      ${opcional('lancamentos_diario_bordo', 'v', 'holding_id')} AS holding_id,
      ${opcional('lancamentos_diario_bordo', 'v', 'tempo_ac')} AS tempo_ac,
      ${opcional('lancamentos_diario_bordo', 'v', 'tempo_cor')} AS tempo_cor,
      ${opcional('lancamentos_diario_bordo', 'v', 'distancia_nm')} AS distancia_nm,
      ${opcional('lancamentos_diario_bordo', 'v', 'pic_nome')} AS comandante,
      ${opcional('lancamentos_diario_bordo', 'v', 'sic_nome')} AS copiloto,
      ${opcional('lancamentos_diario_bordo', 'v', 'numero_sequencial')} AS numero_sequencial,
      ${opcional('lancamentos_diario_bordo', 'v', 'trecho')} AS trecho,
      ${opcional('lancamentos_diario_bordo', 'v', 'tempo_dep')} AS tempo_dep,
      ${opcional('lancamentos_diario_bordo', 'v', 'tempo_pou')} AS tempo_pou,
      ${opcional('lancamentos_diario_bordo', 'v', 'numero_voo')} AS numero_voo,
      ${opcional('lancamentos_diario_bordo', 'v', 'tempo_voo')} AS tempo_voo,
      ${opcional('lancamentos_diario_bordo', 'v', 'pousos_total')} AS pousos,
      ${icao(partida)} AS origem, ${icao(destino)} AS destino,
      ${opcional('lancamentos_diario_bordo', 'v', 'consumo_combustivel_total')} AS consumo_estimado_litros,
      ${opcional('lancamentos_diario_bordo', 'v', 'voo_emprestado')} AS emprestado,
      ${opcional('lancamentos_diario_bordo', 'v', 'cliente_tomador_emprestimo_id')} AS cliente_tomador_id,
      ${opcional('lancamentos_diario_bordo', 'v', 'socio_tomador_emprestimo_id')} AS socio_tomador_id,
      ${opcional('lancamentos_diario_bordo', 'v', 'natureza_voo')} AS natureza
      FROM lancamentos_diario_bordo v WHERE ${v.where.join(' AND ')} ORDER BY v.data_registro, v.id`, ...v.params) : Promise.resolve([]),
    fontes.abastecimentos ? listarTodos(db, `SELECT a.id, a.data, a.litros,
      ${opcional('abastecimentos', 'a', 'cliente_id')} AS cliente_id,
      ${opcional('abastecimentos', 'a', 'socio_id')} AS socio_id
      FROM abastecimentos a WHERE ${a.where.join(' AND ')} ORDER BY a.data, a.id`, ...a.params) : Promise.resolve([]),
    fontes.viagens ? listarTodos(db, `SELECT r.id, r.data_inicio AS data, r.total_valor,
      ${opcional('relatorio_despesa_viagem', 'r', 'cliente_id')} AS cliente_id,
      ${opcional('relatorio_despesa_viagem', 'r', 'socio_id')} AS socio_id,
      ${opcional('relatorio_despesa_viagem', 'r', 'numero_relatorio')} AS numero,
      ${opcional('relatorio_despesa_viagem', 'r', 'rota')} AS rota
      FROM relatorio_despesa_viagem r WHERE ${r.where.join(' AND ')} ORDER BY r.data_inicio, r.id`, ...r.params) : Promise.resolve([]),
  ])
  const str = (v: unknown) => v == null ? null : String(v)
  const num = (v: unknown) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
  return {
    versao: 1 as const, aeronaveId, inicio: inicio ?? null, fim: fim ?? null, fontes,
    cotistas: cotistas.map(c => ({ id: String(c.id), nome: String(c.nome), clienteId: str(c.cliente_id), socioId: str(c.socio_id), holdingId: str(c.holding_id), percentualSociedade: num(c.percentual_sociedade) })),
    voos: voos.map(v => ({ id: String(v.id), data: String(v.data), numero: str(v.numero_voo), numeroSequencial: num(v.numero_sequencial), trecho: str(v.trecho), tempoDep: str(v.tempo_dep), tempoPou: str(v.tempo_pou), clienteId: str(v.cliente_id), socioId: str(v.socio_id),
      holdingId: str(v.holding_id), tempoAc: str(v.tempo_ac), tempoCor: str(v.tempo_cor),
      distanciaNm: num(v.distancia_nm), comandante: str(v.comandante), copiloto: str(v.copiloto),
      horas: num(v.tempo_total), horasVoo: num(v.tempo_voo), pousos: num(v.pousos), origem: str(v.origem), destino: str(v.destino),
      consumoEstimadoLitros: num(v.consumo_estimado_litros), emprestado: Number(v.emprestado) === 1,
      clienteTomadorId: str(v.cliente_tomador_id), socioTomadorId: str(v.socio_tomador_id), natureza: str(v.natureza) })),
    abastecimentos: abastecimentos.map(a => ({ id: String(a.id), data: String(a.data), litros: num(a.litros), clienteId: str(a.cliente_id), socioId: str(a.socio_id) })),
    viagens: viagens.map(r => ({ id: String(r.id), data: String(r.data), numero: str(r.numero), rota: str(r.rota),
      clienteId: str(r.cliente_id), socioId: str(r.socio_id), valorCentavos: num(r.total_valor) === null ? null : Math.round(Number(r.total_valor) * 100) })),
  }
}

