export type TipoPagamentoFolha = 'SALARIO' | 'FERIAS' | 'DECIMO_TERCEIRO' | 'RESCISAO' | 'ADIANTAMENTO' | 'OUTRO'
export type RotuloPagamentoFolha = 'SALARIO' | 'FERIAS' | '13_P1' | '13_P2' | 'BENEFICIO' | 'HORAS_VOO' | 'EXTRA'

export type ItemPagamentoFolha = {
  rotulo: RotuloPagamentoFolha
  tipo_pagamento: TipoPagamentoFolha
  valor_centavos: number
}

export type RegistrarPagamentoFolha = {
  user_id: string
  ano: number
  mes: number
  data_pagamento: string | null
  conta_pagamento_id: string | null
  observacoes: string | null
  comprovante_url: string | null
  holerite_url: string | null
  itens: ItemPagamentoFolha[]
  idempotency_key: string
}

const TIPO_POR_ROTULO: Record<RotuloPagamentoFolha, TipoPagamentoFolha> = {
  SALARIO: 'SALARIO',
  FERIAS: 'FERIAS',
  '13_P1': 'DECIMO_TERCEIRO',
  '13_P2': 'DECIMO_TERCEIRO',
  BENEFICIO: 'OUTRO',
  HORAS_VOO: 'OUTRO',
  EXTRA: 'OUTRO',
}

const ROTULOS = Object.keys(TIPO_POR_ROTULO) as RotuloPagamentoFolha[]
const textoOpcional = (valor: unknown, max: number): string | null => {
  if (valor === null || valor === undefined || valor === '') return null
  if (typeof valor !== 'string' || valor.length > max) throw new Error('campo_texto_invalido')
  return valor.trim() || null
}

function dataISOValida(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false
  const data = new Date(`${valor}T00:00:00.000Z`)
  return Number.isFinite(data.getTime()) && data.toISOString().slice(0, 10) === valor
}

export function validarRegistroPagamentoFolha(input: unknown): { valor: RegistrarPagamentoFolha } | { erro: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { erro: 'payload_invalido' }
  const body = input as Record<string, unknown>
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  const ano = Number(body.ano)
  const mes = Number(body.mes)
  const key = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
  if (!userId || userId.length > 128) return { erro: 'user_id_invalido' }
  if (!Number.isInteger(ano) || ano < 2000 || ano > 9999) return { erro: 'ano_invalido' }
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return { erro: 'mes_invalido' }
  if (!key || key.length > 200) return { erro: 'idempotency_key_invalida' }
  if (body.data_pagamento !== null && body.data_pagamento !== undefined && body.data_pagamento !== '' && !dataISOValida(body.data_pagamento)) return { erro: 'data_pagamento_invalida' }
  if (!Array.isArray(body.itens) || body.itens.length < 1 || body.itens.length > ROTULOS.length) return { erro: 'itens_invalidos' }

  const rotulos = new Set<string>()
  const itens: ItemPagamentoFolha[] = []
  for (const rawItem of body.itens) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return { erro: 'item_pagamento_invalido' }
    const item = rawItem as Record<string, unknown>
    const rotulo = item.rotulo
    if (typeof rotulo !== 'string' || !ROTULOS.includes(rotulo as RotuloPagamentoFolha)) return { erro: 'rotulo_pagamento_invalido' }
    if (rotulos.has(rotulo)) return { erro: 'rotulo_pagamento_duplicado' }
    rotulos.add(rotulo)
    if (item.tipo_pagamento !== TIPO_POR_ROTULO[rotulo as RotuloPagamentoFolha]) return { erro: 'tipo_pagamento_incompativel_com_rotulo' }
    const valor = item.valor_centavos
    if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) return { erro: 'valor_centavos_invalido' }
    itens.push({ rotulo: rotulo as RotuloPagamentoFolha, tipo_pagamento: TIPO_POR_ROTULO[rotulo as RotuloPagamentoFolha], valor_centavos: valor })
  }

  try {
    const contaId = textoOpcional(body.conta_pagamento_id, 128)
    const observacoes = textoOpcional(body.observacoes, 2000)
    const comprovanteUrl = textoOpcional(body.comprovante_url, 2048)
    const holeriteUrl = textoOpcional(body.holerite_url, 2048)
    return {
      valor: {
        user_id: userId,
        ano,
        mes,
        data_pagamento: body.data_pagamento ? String(body.data_pagamento) : null,
        conta_pagamento_id: contaId,
        observacoes,
        comprovante_url: comprovanteUrl,
        holerite_url: holeriteUrl,
        itens,
        idempotency_key: key,
      },
    }
  } catch {
    return { erro: 'campo_texto_invalido' }
  }
}

export function parcelaDecimoTerceiro(rotulo: RotuloPagamentoFolha): 'PRIMEIRA' | 'SEGUNDA' | null {
  if (rotulo === '13_P1') return 'PRIMEIRA'
  if (rotulo === '13_P2') return 'SEGUNDA'
  return null
}

export async function idDeterministicoPagamentoFolha(chave: string): Promise<string> {
  const bytes = new TextEncoder().encode(chave)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 32)
}
