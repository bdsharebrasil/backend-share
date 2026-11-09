import { instanteUtc, numeroMinutos, limiteDiarioConfigurado } from './jornadaTempo'
export { instanteUtc, numeroMinutos } from './jornadaTempo'

/** Relatório somente de leitura. Não substitui o motor de limites de jornadasRoutes. */
export type JornadaResumo = {
  id: string;
  tripulante_id: string;
  numero_jornada: number;
  funcao: string;
  status: string;
  apresentacao: string | null;
  corte: string | null;
  encerramento: string | null;
  minutos_pos_corte: number | null;
  minutos_reais: number | null;
  minutos_registrados: number | null;
  quantidade_pernas: number;
  limite_sistema_minutos: number;
  diferenca_sistema_minutos: number | null;
  avisos: string[];
};
export type PeriodoResumo = {
  id: string;
  tipo: 'semana' | 'mes';
  inicio: string;
  fim: string;
  fuso_apuracao: 'UTC';
  criterio: string;
  operacao_minutos: number | null;
  total_minutos: number;
  referencia_minutos: number;
  diferenca_minutos: number | null;
  registros_incompletos: number;
  nivel: 'abaixo_referencia' | 'referencia_atingida' | 'acima_referencia' | 'incompleto';
};
export type TripulanteResumo = {
  id: string;
  nome: string;
  funcoes: string[];
  jornadas: JornadaResumo[];
  minutos_reais_operacao: number | null;
  minutos_registrados_operacao: number | null;
  referencia_em: string | null;
  periodos: PeriodoResumo[];
};
export type ResumoJornadaOperacao = {
  solicitacao_id: string;
  numero_voo: string | null;
  gerado_em: string;
  tripulantes: TripulanteResumo[];
  validacao_legal_completa: false;
  fuso_base: null;
  fora_base: { dias_operacao: null; referencia_dias: 21; local_operacao_referencia_dias: 17; motivo: string };
  avisos: string[];
};

export type JornadaBanco = {
  id: string;
  solicitacao_id: string;
  tripulante_id: string | null;
  jornada_principal_id: string | null;
  numero_jornada: number;
  data: string;
  horario_apresentacao: string | null;
  horario_corte: string | null;
  minutos_pos_corte: number | string | null;
  minutos_jornada: number | string | null;
  funcao_tripulante: string;
  status: string;
  tripulante_nome?: string | null;
  limite_jornada_minutos?: number | string | null;
};
export type PernaBanco = { jornada_id: string; numero: number; horario_corte: string | null };
const MINUTO = 60_000;
const DIA = 86_400_000;

function isoOuNulo(valor: number | null) { return valor === null ? null : new Date(valor).toISOString(); }
function somaCompleta(valores: Array<number | null>): number | null {
  return valores.length && valores.every((valor) => valor !== null) ? valores.reduce<number>((soma, valor) => soma + (valor ?? 0), 0) : null;
}

export function resumirJornada(jornada: JornadaBanco, pernas: PernaBanco[], limiteDiarioPadrao: unknown = 540): JornadaResumo {
  const apresentacao = instanteUtc(jornada.horario_apresentacao);
  const ordenadas = [...pernas].sort((a, b) => a.numero - b.numero);
  // Não substitui COR por POU. A parada dos motores é um evento distinto.
  const corte = instanteUtc(jornada.horario_corte || ordenadas[ordenadas.length - 1]?.horario_corte);
  const posCorte = numeroMinutos(jornada.minutos_pos_corte);
  const encerrada = jornada.status === 'encerrada';
  const fimCandidato = corte !== null && posCorte !== null ? corte + posCorte * MINUTO : null;
  const intervaloValido = apresentacao !== null && fimCandidato !== null && fimCandidato >= apresentacao && (corte === null || corte >= apresentacao);
  const encerramento = encerrada && intervaloValido ? fimCandidato : null;
  const registrado = encerrada ? numeroMinutos(jornada.minutos_jornada) : null;
  const avisos: string[] = [];
  if (!encerrada) avisos.push('Jornada ainda não encerrada.');
  if (apresentacao === null) avisos.push('Apresentação ausente ou inválida.');
  if (corte === null) avisos.push('Corte final ausente ou inválido.');
  if (posCorte === null) avisos.push('Tempo pós-corte não informado.');
  if (apresentacao !== null && fimCandidato !== null && !intervaloValido) avisos.push('Datas fora de ordem; não foi aplicado ajuste automático de dia.');
  if (registrado === null) avisos.push('Tempo computado não registrado no banco.');
  return {
    id: jornada.id, tripulante_id: jornada.tripulante_id || '', numero_jornada: Number(jornada.numero_jornada),
    funcao: jornada.funcao_tripulante, status: jornada.status,
    apresentacao: isoOuNulo(apresentacao), corte: isoOuNulo(corte), encerramento: isoOuNulo(encerramento),
    minutos_pos_corte: posCorte,
    minutos_reais: encerramento !== null && apresentacao !== null ? (encerramento - apresentacao) / MINUTO : null,
    minutos_registrados: registrado, quantidade_pernas: ordenadas.length,
    limite_sistema_minutos: limiteDiarioConfigurado(jornada.limite_jornada_minutos, limiteDiarioPadrao),
    diferenca_sistema_minutos: registrado !== null ? (limiteDiarioConfigurado(jornada.limite_jornada_minutos, limiteDiarioPadrao)) - registrado : null, avisos,
  };
}

function inicioDia(valor: number) { const data = new Date(valor); return Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), data.getUTCDate()); }
function inicioPeriodo(valor: number, tipo: 'semana' | 'mes') {
  const data = new Date(valor);
  return tipo === 'mes' ? Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), 1)
    : inicioDia(valor) - ((data.getUTCDay() + 6) % 7) * DIA;
}
function fimPeriodo(inicio: number, tipo: 'semana' | 'mes') {
  const data = new Date(inicio);
  return tipo === 'mes' ? Date.UTC(data.getUTCFullYear(), data.getUTCMonth() + 1, 1) : inicio + 7 * DIA;
}
function dataJornada(jornada: JornadaBanco): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jornada.data?.slice(0, 10) || '')) return null;
  return instanteUtc(`${jornada.data.slice(0, 10)}T00:00:00Z`);
}
function deduplicar(jornadas: JornadaBanco[]): JornadaBanco[] {
  const mapa = new Map<string, JornadaBanco>();
  for (const jornada of jornadas) {
    const chave = `${jornada.tripulante_id}:${jornada.jornada_principal_id || jornada.id}`;
    const anterior = mapa.get(chave);
    if (!anterior || jornada.id === (jornada.jornada_principal_id || jornada.id)) mapa.set(chave, jornada);
  }
  return [...mapa.values()];
}

/**
 * Posição histórica por operação. Nunca consulta o relógio atual para somar
 * o mês de uma operação antiga, nem soma PIC e SIC como se fossem uma pessoa.
 * A janela semanal de 7 datas e o mês civil usam UTC até existir cadastro do
 * fuso da base e do regime no sistema. Nenhum selo de conformidade é gerado.
 */
export function montarResumoTripulante(operacao: JornadaBanco[], historico: JornadaBanco[], pernas: PernaBanco[], limiteDiarioPadrao: unknown = 540): TripulanteResumo {
  const registrosOperacao = deduplicar(operacao);
  const registrosHistorico = deduplicar(historico);
  const pernasPorId = new Map<string, PernaBanco[]>();
  for (const perna of pernas) pernasPorId.set(perna.jornada_id, [...(pernasPorId.get(perna.jornada_id) || []), perna]);
  const resumir = (registro: JornadaBanco) => resumirJornada(registro, pernasPorId.get(registro.id) || pernasPorId.get(registro.jornada_principal_id || '') || [], limiteDiarioPadrao);
  const jornadas = registrosOperacao.map(resumir).sort((a, b) => String(a.apresentacao || '').localeCompare(String(b.apresentacao || '')));
  const finais = jornadas.map((jornada) => instanteUtc(jornada.encerramento)).filter((valor): valor is number => valor !== null);
  // Se faltar encerramento em qualquer registro, não inventa posição final.
  const referencia = finais.length === jornadas.length && finais.length ? Math.max(...finais) : null;
  const chaves = new Map<string, { tipo: 'semana' | 'mes'; inicio: number; fim: number }>();
  for (const registro of registrosOperacao) {
    const dia = dataJornada(registro) ?? instanteUtc(registro.horario_apresentacao);
    if (dia === null) continue;
    // Mesmo critério do motor existente: competência pela data da jornada.
    const inicioSemana = inicioDia(dia) - 6 * DIA;
    chaves.set(`semana:${inicioSemana}`, { tipo: 'semana', inicio: inicioSemana, fim: inicioDia(dia) + DIA });
    const inicioMes = inicioPeriodo(dia, 'mes');
    chaves.set(`mes:${inicioMes}`, { tipo: 'mes', inicio: inicioMes, fim: fimPeriodo(inicioMes, 'mes') });
  }
  const idsOperacao = new Set(registrosOperacao.map((registro) => registro.id));
  const periodos: PeriodoResumo[] = [...chaves.values()].sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'semana' ? -1 : 1) || a.inicio - b.inicio).map((periodo) => {
    let total = 0; let contribuicao = 0; let incompletos = 0; let incompletosOperacao = 0;
    // Sem encerramento completo, exibe períodos e dados faltantes, sem saldo.
    if (referencia === null) return { id: `${periodo.tipo}:${periodo.inicio}`, tipo: periodo.tipo, inicio: new Date(periodo.inicio).toISOString(), fim: new Date(periodo.fim).toISOString(), fuso_apuracao: 'UTC', criterio: 'Competência pela data da jornada; janela semanal de 7 datas UTC e mês civil UTC.', operacao_minutos: null, total_minutos: 0, referencia_minutos: periodo.tipo === 'semana' ? 2640 : 10560, diferenca_minutos: null, registros_incompletos: 1, nivel: 'incompleto' };
    for (const registro of registrosHistorico) {
      const resumo = resumir(registro);
      const a = instanteUtc(resumo.apresentacao);
      const b = instanteUtc(resumo.encerramento);
      const dia = dataJornada(registro);
      const pertence = idsOperacao.has(registro.id);
      if (dia === null) { incompletos++; if (pertence) incompletosOperacao++; continue; }
      if (dia < periodo.inicio || dia >= periodo.fim) continue;
      if (a !== null && a >= referencia) continue;
      if (b !== null && b > referencia) continue;
      if (resumo.minutos_registrados === null) { incompletos++; if (pertence) incompletosOperacao++; continue; }
      // O valor é atribuído à data da jornada, como no motor existente.
      // Isso é critério do controle registrado, não uma certificação legal.
      if (b === null || a === null) incompletos++;
      total += resumo.minutos_registrados;
      if (pertence) contribuicao += resumo.minutos_registrados;
    }
    const limite = periodo.tipo === 'semana' ? 2640 : 10560;
    const diferenca = incompletos ? null : limite - total;
    const nivel = total > limite ? 'acima_referencia' : incompletos ? 'incompleto' : total === limite ? 'referencia_atingida' : 'abaixo_referencia';
    return { id: `${periodo.tipo}:${periodo.inicio}`, tipo: periodo.tipo, inicio: new Date(periodo.inicio).toISOString(), fim: new Date(periodo.fim).toISOString(), fuso_apuracao: 'UTC', criterio: 'Competência pela data da jornada; janela semanal de 7 datas UTC e mês civil UTC.', operacao_minutos: incompletosOperacao ? null : contribuicao, total_minutos: total, referencia_minutos: limite, diferenca_minutos: diferenca, registros_incompletos: incompletos, nivel };
  });
  return {
    id: registrosOperacao[0]?.tripulante_id || '', nome: registrosOperacao[0]?.tripulante_nome || 'Tripulante sem nome',
    funcoes: [...new Set(registrosOperacao.map((registro) => registro.funcao_tripulante))], jornadas,
    minutos_reais_operacao: somaCompleta(jornadas.map((jornada) => jornada.minutos_reais)),
    minutos_registrados_operacao: somaCompleta(jornadas.map((jornada) => jornada.minutos_registrados)),
    referencia_em: isoOuNulo(referencia), periodos,
  };
}

export async function buscarResumoOperacaoBanco(db: D1Database, solicitacaoId: string, limiteDiarioPadrao: unknown = 540): Promise<ResumoJornadaOperacao | null> {
  const solicitacao = await db.prepare('SELECT id, numero_voo FROM solicitacoes_reserva_voo WHERE id = ?1').bind(solicitacaoId).first<{ id: string; numero_voo: string | null }>();
  if (!solicitacao) return null;
  const operacao = await db.prepare(`SELECT j.*, COALESCE(t.nome_completo, f.nome_completo) AS tripulante_nome
    FROM jornadas_voo j LEFT JOIN tripulacao t ON t.id = j.tripulante_id
    LEFT JOIN tripulacao_freelancer f ON f.id = j.tripulante_id
    WHERE j.solicitacao_id = ?1 ORDER BY j.horario_apresentacao, j.numero_jornada`).bind(solicitacaoId).all<JornadaBanco>();
  const registros = operacao.results || [];
  const ids = [...new Set(registros.map((registro) => registro.tripulante_id).filter((id): id is string => Boolean(id)))];
  const tripulantes = await Promise.all(ids.map(async (id) => {
    // Todas as operações deste tripulante: períodos não ficam limitados ao agendamento.
    const historico = await db.prepare('SELECT * FROM jornadas_voo WHERE tripulante_id = ?1').bind(id).all<JornadaBanco>();
    // Copilotos podem compartilhar as pernas da jornada principal.
    const pernas = await db.prepare(`SELECT p.jornada_id, p.numero, p.horario_corte
      FROM pernas_jornada_voo p WHERE p.jornada_id IN (
        SELECT id FROM jornadas_voo WHERE tripulante_id = ?1
        UNION SELECT jornada_principal_id FROM jornadas_voo WHERE tripulante_id = ?1 AND jornada_principal_id IS NOT NULL
      ) ORDER BY p.jornada_id, p.numero`).bind(id).all<PernaBanco>();
    return montarResumoTripulante(registros.filter((registro) => registro.tripulante_id === id), historico.results || [], pernas.results || [], limiteDiarioPadrao);
  }));
  return {
    solicitacao_id: solicitacao.id, numero_voo: solicitacao.numero_voo, gerado_em: new Date().toISOString(), tripulantes,
    validacao_legal_completa: false, fuso_base: null,
    fora_base: { dias_operacao: null, referencia_dias: 21, local_operacao_referencia_dias: 17, motivo: 'Base contratual, saída, retorno e permanência efetiva no local de operação não informados.' },
    avisos: [
      'Comparação dos tempos computados e salvos. Outras atividades computáveis e os ajustes legais precisam ser verificados.',
      'Competência pela data da jornada: janela semanal de 7 datas UTC e mês civil UTC, conforme o controle configurado. O fuso da base e o enquadramento legal não foram confirmados.',
      ...(registros.some((registro) => !registro.tripulante_id) ? ['Há jornadas sem tripulante vinculado; elas não foram atribuídas ao PIC ou SIC atual.'] : []),
    ],
  };
}
