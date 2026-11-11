import { classificarNaturezaCusto, projetarCustoPeriodo } from "../../shared/natureza-custo"

/**
 * Relatório geral da aeronave (equivalente à planilha "RESUMO GERAL / MÉDIAS / TABELAS 1 e 2").
 * Valores monetários em centavos. Horas em horas decimais, distância em NM.
 */
export type BucketCusto =
  | 'adm_trip' | 'hangaragem' | 'manut_fixa'          // custos fixos
  | 'combustivel' | 'manut_hora'                      // variáveis por hora
  | 'taxas_voo' | 'hoteis_alim'                       // variáveis por voo
  | 'extras' | 'nao_classificados'

export const BUCKETS: BucketCusto[] = ['adm_trip', 'hangaragem', 'manut_fixa', 'combustivel', 'manut_hora', 'taxas_voo', 'hoteis_alim', 'extras', 'nao_classificados']
const FIXOS: BucketCusto[] = ['adm_trip', 'hangaragem', 'manut_fixa']
const VARIAVEIS: BucketCusto[] = ['combustivel', 'manut_hora', 'taxas_voo', 'hoteis_alim']
const KM_POR_NM = 1.852

export type CustoBruto = {
  data: string | null
  categoria?: string | null
  grupo?: string | null
  tipo_rateio?: string | null
  natureza_custo?: string | null
  naturezaCusto?: string | null
  periodicidade?: string | null
  descricao?: string | null
  valor_centavos: number
}
export type VooMes = { mes: string; h_voo: number; h_ttl: number; pousos: number; distancia_nm: number; litros: number; dias_voo: number }

const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
const RX = {
  comb: /COMBUST|ABASTEC|QAV|AVGAS|QUEROSENE/,
  hangar: /HANGAR/,
  manut: /MANUT|PECA|REVIS|OFICINA|LUBRIF|CORRETIV|PREVENTIV/,
  hotel: /HOTEL|HOSPED|ALIMENT|DIARIA|REFEIC|VIAGEM/,
  taxas: /TAXA|TARIFA|INFRAERO|DECEA|POUSO|ATENDIMENTO|PROTECAO|TERCEIRO/,
  adm: /ADM|PILOT|TRIPUL|COPILOT|SALARIO/,
}

export function classificarCusto(c: CustoBruto): BucketCusto {
  const texto = `${norm(c.categoria)} ${norm(c.descricao)}`
  switch (classificarNaturezaCusto(c)) {
    case 'extras': return 'extras'
    case 'fixos': return RX.hangar.test(texto) ? 'hangaragem' : RX.manut.test(texto) && !RX.adm.test(texto) ? 'manut_fixa' : 'adm_trip'
    case 'variaveis': return RX.comb.test(texto) ? 'combustivel' : RX.hotel.test(texto) ? 'hoteis_alim' : RX.taxas.test(texto) ? 'taxas_voo' : 'manut_hora'
    default: return 'nao_classificados'
  }
}

const vazio = (): Record<BucketCusto, number> => ({ adm_trip: 0, hangaragem: 0, manut_fixa: 0, combustivel: 0, manut_hora: 0, taxas_voo: 0, hoteis_alim: 0, extras: 0, nao_classificados: 0 })
const soma = (o: Record<BucketCusto, number>, ks: BucketCusto[]) => ks.reduce((t, k) => t + o[k], 0)
const div = (a: number, b: number) => (b > 0 ? a / b : 0)
const r2 = (n: number) => Math.round(n * 100) / 100

export function montarRelatorioGeral(custos: CustoBruto[], voos: VooMes[], ano: number, nCotas: number, opcoes: { fatorFixo?: number; maxHoras?: number } = {}) {
  const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`)
  const porMes = new Map(meses.map((mes) => [mes, vazio()]))
  for (const custo of custos) {
    const mes = String(custo.data ?? '').slice(0, 7)
    const alvo = porMes.get(mes)
    if (!alvo) continue
    alvo[classificarCusto(custo)] += Math.max(0, Math.round(Number(custo.valor_centavos) || 0))
  }
  const vooPorMes = new Map(voos.map((v) => [v.mes, v]))

  const linhas = meses.map((mes) => {
    const c = porMes.get(mes)!
    const v = vooPorMes.get(mes) ?? { mes, h_voo: 0, h_ttl: 0, pousos: 0, distancia_nm: 0, litros: 0, dias_voo: 0 }
    const fixos = soma(c, FIXOS), variaveis = soma(c, VARIAVEIS), total = fixos + variaveis + c.extras + c.nao_classificados
    const por_hora = Object.fromEntries(BUCKETS.map((k) => [k, r2(div(c[k], v.h_ttl))])) as Record<BucketCusto, number>
    return {
      mes, custos: c, fixos, variaveis, extras: c.extras, nao_classificados: c.nao_classificados, total, ativo: total > 0 || v.h_ttl > 0,
      operacional: { abastecido_l: r2(v.litros), distancia_nm: r2(v.distancia_nm), pousos: v.pousos, h_voo: r2(v.h_voo), h_ttl: r2(v.h_ttl), dias_voo: v.dias_voo },
      medias: {
        por_hora, // R$/h de cada bucket (centavos por hora)
        litros_por_hora: r2(div(v.litros, v.h_ttl)),
        valor_litro_centavos: r2(div(c.combustivel, v.litros)),
        velocidade_kt: r2(div(v.distancia_nm, v.h_voo)),
        custo_hora_centavos: r2(div(total, v.h_ttl)),
        custo_km_centavos: r2(div(total, v.distancia_nm * KM_POR_NM)),
        custo_dia_centavos: r2(div(total, v.dias_voo)),
      },
    }
  })

  const totalC = vazio()
  const op = { abastecido_l: 0, distancia_nm: 0, pousos: 0, h_voo: 0, h_ttl: 0, dias_voo: 0 }
  for (const l of linhas) {
    BUCKETS.forEach((k) => { totalC[k] += l.custos[k] })
    op.abastecido_l += l.operacional.abastecido_l; op.distancia_nm += l.operacional.distancia_nm; op.pousos += l.operacional.pousos
    op.h_voo += l.operacional.h_voo; op.h_ttl += l.operacional.h_ttl; op.dias_voo += l.operacional.dias_voo
  }
  const mesesAtivos = Math.max(1, linhas.filter((l) => l.ativo).length) // a planilha divide por 12; aqui só meses com movimento
  const fixos = soma(totalC, FIXOS), variaveis = soma(totalC, VARIAVEIS), totalGeral = fixos + variaveis + totalC.extras + totalC.nao_classificados
  const mediaMes = Object.fromEntries(BUCKETS.map((k) => [k, Math.round(totalC[k] / mesesAtivos)])) as Record<BucketCusto, number>
  const porHora = Object.fromEntries(BUCKETS.map((k) => [k, r2(div(totalC[k], op.h_ttl))])) as Record<BucketCusto, number>

  // Tabelas de projeção (1 e 2): fixo rateado pelas horas; variável e extra = média por hora do período.
  const variavelHora = div(variaveis, op.h_ttl), extraHora = div(totalC.extras, op.h_ttl), combHora = div(totalC.combustivel, op.h_ttl)
  const projecao = Array.from({ length: opcoes.maxHoras ?? 45 }, (_, i) => {
    const h = i + 1
    const p = projetarCustoPeriodo({ total: totalGeral, fixos, variaveis, extras: totalC.extras, naoClassificados: totalC.nao_classificados }, op.h_ttl, mesesAtivos, h, opcoes.fatorFixo ?? 1)
    if (!p) return null
    return { h_voadas: h, metodo: p.metodo, custo_fixo: p.fixoHora === null ? null : r2(p.fixoHora),
      custo_variavel: p.variavelHora === null ? null : r2(p.variavelHora), custo_extra: p.extraHora === null ? null : r2(p.extraHora),
      custo_hora_tt: r2(p.custoHora), custo_comb: r2(combHora), custo_total: r2(p.custoMensal),
      indice: r2(div(p.custoHora, combHora)), fixo_por_cota: p.fixoHora === null ? null : r2(div(p.fixoHora, nCotas)) }
  }).filter((p) => p !== null)

  return {
    ano, n_cotas: nCotas, meses_ativos: mesesAtivos, linhas,
    total: { custos: totalC, fixos, variaveis, extras: totalC.extras, nao_classificados: totalC.nao_classificados, total: totalGeral, operacional: { ...op, abastecido_l: r2(op.abastecido_l), distancia_nm: r2(op.distancia_nm), h_voo: r2(op.h_voo), h_ttl: r2(op.h_ttl) } },
    media_mes: { custos: mediaMes, fixos: Math.round(fixos / mesesAtivos), variaveis: Math.round(variaveis / mesesAtivos), extras: Math.round(totalC.extras / mesesAtivos), nao_classificados: Math.round(totalC.nao_classificados / mesesAtivos), total: Math.round(totalGeral / mesesAtivos) },
    medias: {
      por_hora: porHora, fixos_hora: r2(div(fixos, op.h_ttl)), variaveis_hora: r2(variavelHora), extras_hora: r2(extraHora),
      custo_hora_centavos: r2(div(totalGeral, op.h_ttl)), custo_km_centavos: r2(div(totalGeral, op.distancia_nm * KM_POR_NM)),
      litros_por_hora: r2(div(op.abastecido_l, op.h_ttl)), litros_por_nm: r2(div(op.abastecido_l, op.distancia_nm)), valor_litro_centavos: r2(div(totalC.combustivel, op.abastecido_l)),
      velocidade_kt: r2(div(op.distancia_nm, op.h_voo)), horas_por_ciclo: r2(div(op.h_voo, op.pousos)), diarias_por_hora: r2(div(op.dias_voo, op.h_ttl)),
      custo_dia_centavos: r2(div(totalGeral, op.dias_voo)),
    },
    projecao,
    taxa_projecao_centavos: r2(totalC.nao_classificados ? div(totalGeral, op.h_ttl) : variavelHora + extraHora),
  }
}

