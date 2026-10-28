export type PosicaoTripulante = 1 | 2

export type DespesaTripulante = {
  id: string
  categoria: string
  data: string
  valor: number
  pago_por: 'tripulante_1' | 'tripulante_2' | 'cliente' | 'sharebrasil'
  descricao: string
}

export type TotaisDespesasTripulante = {
  total_valor: number
  total_combustivel: number
  total_hospedagem: number
  total_alimentacao: number
  total_transporte: number
  total_outros: number
  total_tripulacao: number
  total_tripulante_1: number
  total_tripulante_2: number
  total_cliente: number
  total_sharebrasil: number
}

const categorias = new Map<string, string>([
  ['alimentacao', 'Alimentação'],
  ['hospedagem', 'Hospedagem'],
  ['transporte', 'Transporte'],
  ['combustivel', 'Combustível'],
  ['outros', 'Outros'],
])

function normalizarTexto(valor: unknown): string {
  return String(valor ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_')
}

function valorEmCentavos(valor: unknown): number {
  if (typeof valor === 'string') {
    const texto = valor.trim().replace(/^R\$\s*/i, '')
    const convertido = texto.includes(',')
      ? Number(texto.replace(/\./g, '').replace(',', '.'))
      : Number(texto)
    return Number.isFinite(convertido) ? Math.round(convertido * 100) : NaN
  }
  const convertido = Number(valor)
  return Number.isFinite(convertido) ? Math.round(convertido * 100) : NaN
}

function dataValida(data: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return false
  const valor = new Date(`${data}T00:00:00.000Z`)
  return Number.isFinite(valor.getTime()) && valor.toISOString().slice(0, 10) === data
}

export function normalizarDespesasTripulante(
  entrada: unknown,
  posicao: PosicaoTripulante,
  possuiSegundoTripulante: boolean,
): DespesaTripulante[] {
  if (!Array.isArray(entrada)) throw new Error('despesas_devem_ser_uma_lista')
  if (entrada.length > 250) throw new Error('limite_de_despesas_excedido')
  const ids = new Set<string>()
  const outraPosicao: PosicaoTripulante = posicao === 1 ? 2 : 1

  return entrada.map((valor, indice) => {
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error(`despesa_${indice + 1}_invalida`)
    const item = valor as Record<string, unknown>
    const id = String(item.id ?? '').trim()
    if (!id || id.length > 100 || ids.has(id)) throw new Error(`id_despesa_${indice + 1}_invalido`)
    ids.add(id)

    const categoria = categorias.get(normalizarTexto(item.categoria ?? item.category))
    if (!categoria) throw new Error(`categoria_despesa_${indice + 1}_invalida`)
    const data = String(item.data ?? '').trim().slice(0, 10)
    if (!dataValida(data)) throw new Error(`data_despesa_${indice + 1}_invalida`)
    const centavos = valorEmCentavos(item.valor ?? item.amount)
    if (!Number.isSafeInteger(centavos) || centavos <= 0) throw new Error(`valor_despesa_${indice + 1}_invalido`)

    const pagadorInformado = normalizarTexto(item.pago_por ?? item.paid_by)
    let pagador: DespesaTripulante['pago_por']
    if (['eu', 'tripulante'].includes(pagadorInformado)) {
      pagador = `tripulante_${posicao}` as DespesaTripulante['pago_por']
    } else if (['tripulante_1', 'tripulante1'].includes(pagadorInformado)) {
      pagador = 'tripulante_1'
    } else if (['tripulante_2', 'tripulante2'].includes(pagadorInformado)) {
      pagador = 'tripulante_2'
    } else if (pagadorInformado === 'outro_tripulante') {
      pagador = `tripulante_${outraPosicao}` as DespesaTripulante['pago_por']
    } else if (['cliente', 'client'].includes(pagadorInformado)) {
      pagador = 'cliente'
    } else if (['share', 'sharebrasil', 'share_brasil'].includes(pagadorInformado)) {
      pagador = 'sharebrasil'
    } else {
      throw new Error(`pagador_despesa_${indice + 1}_invalido`)
    }
    if (!possuiSegundoTripulante && pagador === 'tripulante_2') throw new Error('segundo_tripulante_nao_escalado')

    const descricao = String(item.descricao ?? item.description ?? '').trim()
    if (!descricao) throw new Error(`descricao_despesa_${indice + 1}_obrigatoria`)
    if (descricao.length > 500) throw new Error(`descricao_despesa_${indice + 1}_muito_longa`)
    return {
      id,
      categoria,
      data,
      valor: centavos / 100,
      pago_por: pagador,
      descricao,
    }
  })
}

export function calcularTotaisDespesasTripulante(despesas: DespesaTripulante[]): TotaisDespesasTripulante {
  const centavos: Record<keyof TotaisDespesasTripulante, number> = {
    total_valor: 0,
    total_combustivel: 0,
    total_hospedagem: 0,
    total_alimentacao: 0,
    total_transporte: 0,
    total_outros: 0,
    total_tripulacao: 0,
    total_tripulante_1: 0,
    total_tripulante_2: 0,
    total_cliente: 0,
    total_sharebrasil: 0,
  }
  for (const despesa of despesas) {
    const valor = Math.round(despesa.valor * 100)
    centavos.total_valor += valor
    const categoria = normalizarTexto(despesa.categoria)
    const campoCategoria: keyof TotaisDespesasTripulante = categoria === 'combustivel' ? 'total_combustivel'
      : categoria === 'hospedagem' ? 'total_hospedagem'
        : categoria === 'alimentacao' ? 'total_alimentacao'
          : categoria === 'transporte' ? 'total_transporte' : 'total_outros'
    centavos[campoCategoria] += valor
    if (despesa.pago_por === 'tripulante_1') centavos.total_tripulante_1 += valor
    else if (despesa.pago_por === 'tripulante_2') centavos.total_tripulante_2 += valor
    else if (despesa.pago_por === 'cliente') centavos.total_cliente += valor
    else centavos.total_sharebrasil += valor
  }
  centavos.total_tripulacao = centavos.total_tripulante_1 + centavos.total_tripulante_2
  return Object.fromEntries(Object.entries(centavos).map(([campo, valor]) => [campo, valor / 100])) as TotaisDespesasTripulante
}

export function dataFimProvisoriaVoo(dataInicio: string, diasDuracao: unknown): string {
  const data = new Date(`${String(dataInicio).slice(0, 10)}T00:00:00.000Z`)
  if (!Number.isFinite(data.getTime())) throw new Error('data_inicio_do_voo_invalida')
  const dias = Math.max(1, Math.floor(Number(diasDuracao) || 1))
  data.setUTCDate(data.getUTCDate() + dias - 1)
  return data.toISOString().slice(0, 10)
}
