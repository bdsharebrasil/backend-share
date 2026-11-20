import { obterClassificacaoNatureza } from '../../shared/natureza-custo'
import { temposVooPortal, voosDoCotistaPortal, type CotaVooPortal, type VooPortal } from './portalHoras'

type Registro = Record<string, unknown>
export type GrupoCustoPortal = 'fixos' | 'variaveis' | 'reservas' | 'extras' | 'nao_classificados'
export const normalizarCusto = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
const numero = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0
const competencia = (r: Registro) => String(r.mes ?? '').slice(0, 7)

/** Natureza econômica não é critério de rateio. Não transformar EXTRA ou FIXO do rateio em natureza. */
export function grupoCustoPortal(r: Registro): GrupoCustoPortal {
  const natureza = normalizarCusto(r.natureza_custo)
  const categoria = normalizarCusto(r.categoria_nome)
  if (natureza === 'RESERVA' || (!natureza && /^(RESERVA|RESERVA DE MANUTENCAO|FUNDO DE RESERVA|RESERVA PARA MANUTENCAO)$/.test(categoria))) return 'reservas'
  const classificada = obterClassificacaoNatureza(r)
  if (classificada.grupo !== 'naoClassificados') return classificada.grupo
  if (natureza) return 'nao_classificados'
  // Somente famílias explícitas não cobertas pela função comum do Financeiro.
  if (/^(VIAGEM|DESPESA DE VIAGEM|ALIMENTACAO|HOSPEDAGEM|TRANSPORTE|TAXAS|TARIFAS)$/.test(categoria)) return 'variaveis'
  if (/^(SEGURO|SEGURO AERONAUTICO|SEGUROS|TRIPULACAO|TRIPULACAO E ADMINISTRACAO|ADM E TRIPULACAO)$/.test(categoria)) return 'fixos'
  return 'nao_classificados'
}

export function mesesAte(referencia: string, quantidade: number): string[] {
  const [ano, mes] = referencia.split('-').map(Number)
  return Array.from({ length: quantidade }, (_, i) => {
    const d = new Date(Date.UTC(ano, mes - quantidade + i, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

export function resumoCustosPortal(rateios: Registro[], voos: VooPortal[], meses: string[]) {
  const grupos: Record<GrupoCustoPortal, number> = { fixos: 0, variaveis: 0, reservas: 0, extras: 0, nao_classificados: 0 }
  let total = 0, operacional = 0, tempoVoo = 0, semOperacional = 0, semTempoVoo = 0, lancamentos = 0
  for (const r of rateios) {
    if (!meses.includes(competencia(r))) continue
    lancamentos++
    const valor = Math.round(numero(r.valor_rateado_centavos))
    total += valor
    grupos[grupoCustoPortal(r)] += valor
  }
  for (const v of voos) {
    if (!meses.includes(competencia(v))) continue
    const { minutosOperacionais, minutosVoo } = temposVooPortal(v)
    const fator = Number(v.percentualAtribuido ?? 100) / 100
    if (minutosOperacionais === null) semOperacional++
    else operacional += minutosOperacionais * fator
    if (minutosVoo === null) semTempoVoo++
    else tempoVoo += minutosVoo * fator
  }
  // Custo por hora operacional: nunca dividir a cota pelas horas de toda a aeronave.
  return { total_centavos: total, minutos_voo: Math.round(tempoVoo),
    minutos_operacionais: Math.round(operacional),
    etapas_sem_tempo: semOperacional, etapas_sem_tempo_voo: semTempoVoo,
    custo_hora_centavos: lancamentos > 0 && operacional > 0 && semOperacional === 0
      ? Math.round(total * 60 / operacional) : null,
    grupos: Object.fromEntries(Object.entries(grupos).map(([grupo, valor]) =>
      [grupo, { valor_centavos: valor, percentual: total > 0 ? valor / total * 100 : 0 }])) as
      Record<GrupoCustoPortal, { valor_centavos: number; percentual: number }> }
}

/** Somente agregados da aeronave previamente autorizada; nenhuma identidade de outro cotista é retornada. */
export async function carregarCustosPortal(db: D1Database, aeronaveId: string, cotistaId: string, clienteId: string | null, socioId: string | null, meses: string[]) {
  const tabelas = ['rateio_despesas', 'rateio_hold', 'lancamentos_diario_bordo']
  const schemas = new Map(await Promise.all(tabelas.map(async tabela => {
    const r = await db.prepare('SELECT name FROM pragma_table_info(?1)').bind(tabela).all<{ name: string }>()
    return [tabela, new Set((r.results || []).map(c => c.name))] as const
  })))
  const opcionais = (t: string, cols: string[]) => cols.map(col => `${schemas.get(t)?.has(col) ? `r.${col}` : 'NULL'} AS ${col}`).join(', ')
  const ordenados = [...meses].sort()
  const serie = mesesAte(ordenados[ordenados.length - 1], 6)
  const consultaMeses = [...new Set([...meses, ...serie])].sort()
  const parametros = consultaMeses.map(() => '?').join(', ')
  async function rateios(tabela: 'rateio_despesas' | 'rateio_hold', proprio: boolean) {
    const colunas = schemas.get(tabela)!
    if (!colunas.size) return []
    // A regra de competência é a data de emissão, igual ao Fechamento Share.
    const mes = 'substr(r.data_emissao, 1, 7)'
    const filtro = proprio ? tabela === 'rateio_hold' ? ' AND r.socio_id = ?' : ' AND r.cotista_id = ?' : ''
    const args = proprio ? [aeronaveId, socioId && tabela === 'rateio_hold' ? socioId : cotistaId, ...consultaMeses] : [aeronaveId, ...consultaMeses]
    // SUM das parcelas representa o custo UMA vez. valor_total_centavos se repete por cotista.
    const r = await db.prepare(`SELECT r.id, ${mes} AS mes, r.valor_rateado_centavos,
      ${opcionais(tabela, ['natureza_custo', 'categoria_nome', 'descricao_despesa'])}
      FROM ${tabela} r WHERE r.aeronave_id = ?${filtro}
      AND UPPER(TRIM(COALESCE(r.status, ''))) NOT IN ('CANCELADO', 'CANCELADA', 'ESTORNO', 'ESTORNADO')
      AND ${mes} IN (${parametros})`).bind(...args).all<Registro>()
    return r.results || []
  }
  // Cotas ativas entram apenas no compartilhamento de TR/VT. A referência
  // do próprio usuário é sempre o cotista_aeronave.id validado na rota.
  const cotasResultado = await db.prepare(
    'SELECT id, cliente_id, socio_id, percentual_sociedade, status FROM cotista_aeronave WHERE aeronave_id = ?',
  ).bind(aeronaveId).all<CotaVooPortal>()
  const cotas = cotasResultado.results || []
  const cota = cotas.find(item => item.id === cotistaId)
  if (!cota) throw new Error('Vínculo de cotista inexistente para a aeronave')
  const [aeronave, cotista, voosResultado] = await Promise.all([
    rateios('rateio_despesas', false),
    rateios(socioId ? 'rateio_hold' : 'rateio_despesas', true),
    schemas.get('lancamentos_diario_bordo')!.size
      ? db.prepare(`SELECT r.id, r.data_registro,
        substr(r.data_registro, 1, 7) AS mes,
        ${opcionais('lancamentos_diario_bordo', [
          'tempo_ac', 'tempo_cor', 'tempo_total', 'tempo_dep', 'tempo_pou', 'tempo_voo',
          'natureza_voo', 'voo_emprestado', 'cliente_id', 'socio_id',
          'cliente_tomador_emprestimo_id', 'socio_tomador_emprestimo_id',
        ])}
        FROM lancamentos_diario_bordo r WHERE r.aeronave_id = ?
          AND substr(r.data_registro, 1, 7) IN (${parametros})`)
        .bind(aeronaveId, ...consultaMeses).all<VooPortal>()
      : Promise.resolve({ results: [] as VooPortal[] }),
  ])
  const voos = voosResultado.results || []
  const meusVoos = voosDoCotistaPortal(voos, cota, cotas)
  return {
    resposta: { aeronave_id: aeronaveId, meses,
      resumo: { aeronave: resumoCustosPortal(aeronave, voos, meses), cotista: resumoCustosPortal(cotista, meusVoos, meses) },
      mensal: serie.map(mes => ({ mes, aeronave: resumoCustosPortal(aeronave, voos, [mes]), cotista: resumoCustosPortal(cotista, meusVoos, [mes]) })),
      fontes: { custos: schemas.get('rateio_despesas')!.size > 0, voos: schemas.get('lancamentos_diario_bordo')!.size > 0 } },
    rateios: aeronave.filter(r => meses.includes(competencia(r))), voos: voos.filter(v => meses.includes(competencia(v))),
  }
}

/** Valores históricos observados, sem substituir premissas ausentes por constantes da demonstração. */
export function premissasHistoricasPortal(rateios: Registro[], voos: Registro[]) {
  const meses = [...new Set(rateios.map(competencia))]
  const resumo = resumoCustosPortal(rateios, voos, meses)
  const fixos = resumo.grupos.fixos.valor_centavos
  const reservas = resumo.grupos.reservas.valor_centavos
  const eTaxa = (r: Registro) => /\b(TAXAS?|TARIFAS?|DECEA|INFRAERO)\b/.test(normalizarCusto(`${r.categoria_nome} ${r.descricao_despesa}`))
  const eCombustivel = (r: Registro) => /\b(COMBUSTIVEIS?|ABASTECIMENTOS?|AVGAS|QUEROSENE)\b/.test(normalizarCusto(`${r.categoria_nome} ${r.descricao_despesa}`))
  const taxas = rateios.filter(eTaxa).reduce((s, r) => s + numero(r.valor_rateado_centavos), 0)
  const viagem = rateios.filter(r => !eTaxa(r) && !eCombustivel(r) && /^(VIAGEM|DESPESAS DE VIAGEM|ALIMENTACAO|HOSPEDAGEM|TRANSPORTE)$/.test(normalizarCusto(r.categoria_nome))).reduce((s, r) => s + numero(r.valor_rateado_centavos), 0)
  const dias = new Set(voos.map(v => String(v.data_registro).slice(0, 10))).size
  const horas = resumo.minutos_voo / 60
  return {
    meses_observados: meses.length,
    fixo_anual_centavos: fixos > 0 && meses.length ? Math.round(fixos * 12 / meses.length) : null,
    reserva_hora_centavos: reservas > 0 && horas > 0 && !resumo.etapas_sem_tempo ? Math.round(reservas / horas) : null,
    taxas_trecho_centavos: taxas > 0 && voos.length ? Math.round(taxas / voos.length) : null,
    viagem_dia_centavos: viagem > 0 && dias ? Math.round(viagem / dias) : null,
    nao_classificados_centavos: resumo.grupos.nao_classificados.valor_centavos,
  }
}

export function calcularCamadasPortal(input: {
  horas: number; horasAno: number; participacao: number; passageiros: number; dias: number;
  combustivel: number; taxas: number | null; viagem: number | null; fixoAnual: number | null; reservaHora: number | null;
}) {
  const { horas, horasAno, participacao, passageiros, dias, combustivel, taxas, viagem, fixoAnual, reservaHora } = input
  if (![horas, horasAno, passageiros, dias].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(participacao) || participacao <= 0 || participacao > 1) throw new Error('parametros_invalidos')
  const curto = taxas !== null && viagem !== null ? combustivel + taxas + viagem : null
  const medio = fixoAnual !== null ? Math.round(fixoAnual * participacao / horasAno * horas) : null
  const longo = reservaHora !== null ? Math.round(reservaHora * horas) : null
  const subtotal = combustivel + (taxas ?? 0) + (viagem ?? 0) + (medio ?? 0) + (longo ?? 0)
  const completo = curto !== null && medio !== null && longo !== null
  return { curto_prazo_centavos: curto, medio_prazo_centavos: medio, longo_prazo_centavos: longo,
    total_alocado_centavos: completo ? subtotal : null, subtotal_conhecido_centavos: subtotal,
    custo_hora_centavos: completo ? Math.round(subtotal / horas) : null,
    por_passageiro_centavos: completo ? Math.round(subtotal / passageiros) : null,
    fixo_mensal_cotista_centavos: fixoAnual !== null ? Math.round(fixoAnual * participacao / 12) : null,
    completo, dias }
}
