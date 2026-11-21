export type EnvelopePoint = { peso_kg: number; cg_estacao: number }
export type LoadItem = {
  descricao?: unknown
  categoria?: unknown
  peso_kg?: unknown
  peso?: unknown
  braco?: unknown
  [key: string]: unknown
}

export type WeightConfiguration = Record<string, unknown> & {
  id?: unknown
  validado?: unknown
  peso_vazio_padrao?: unknown
  braco_cg_padrao?: unknown
  momento_padrao?: unknown
  peso_maximo_decolagem?: unknown
  peso_maximo_pouso?: unknown
  peso_maximo_sem_combustivel?: unknown
  cg_limite_dianteiro?: unknown
  cg_limite_traseiro?: unknown
  mac_comprimento?: unknown
  lemac_distancia?: unknown
  capacidade_combustivel_util?: unknown
  envelope_pontos_json?: unknown
  data_ultima_pesagem?: unknown
  numero_relatorio_pesagem?: unknown
  responsavel_tecnico?: unknown
}

export type WeightCalculationInput = {
  passageiros: string[]
  itens_carregamento: LoadItem[]
  fuel_kg: unknown
  fuel_litros: unknown
  fuel_braco: unknown
  consumo_estimado_combustivel_kg: unknown
}

export type WeightCalculation = {
  peso_decolagem_kg: number
  momento_decolagem: number
  cg_decolagem_estacao: number
  peso_pouso_kg: number
  momento_pouso: number
  cg_pouso_estacao: number
  peso_sem_combustivel_kg: number
  cg_zero_combustivel_estacao: number
  envelope_decolagem_ok: boolean
  envelope_pouso_ok: boolean
  envelope_zero_combustivel_ok: boolean
}

export function validarNomesPassageiros(value: unknown, numeroPassageiros: number): { ok: true; nomes: string[] } | { ok: false; error: string } {
  if (!Number.isInteger(numeroPassageiros) || numeroPassageiros < 1) return { ok: false, error: 'numero_passageiros_invalido' }
  if (!Array.isArray(value) || value.length !== numeroPassageiros) return { ok: false, error: 'passageiros_quantidade_invalida' }
  const nomes = value.map((nome) => typeof nome === 'string' ? nome.trim() : '')
  if (nomes.some((nome) => !nome)) return { ok: false, error: 'passageiros_nome_obrigatorio' }
  return { ok: true, nomes }
}

export function parseNomesPassageiros(value: unknown): string[] {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

export function parseEnvelope(value: unknown): EnvelopePoint[] | null {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? '[]'))
    if (!Array.isArray(parsed) || parsed.length < 3) return null
    const points = parsed.map((point: any) => ({ peso_kg: Number(point?.peso_kg), cg_estacao: Number(point?.cg_estacao) }))
    if (parsed.some((point: any) => point?.peso_kg === null || point?.peso_kg === undefined || point?.peso_kg === '' || point?.cg_estacao === null || point?.cg_estacao === undefined || point?.cg_estacao === '') ||
        points.some((point) => !Number.isFinite(point.peso_kg) || point.peso_kg <= 0 || !Number.isFinite(point.cg_estacao))) return null
    const areaDobrada = points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length]
      return area + point.peso_kg * next.cg_estacao - next.peso_kg * point.cg_estacao
    }, 0)
    if (!Number.isFinite(areaDobrada) || Math.abs(areaDobrada) < 1e-9) return null
    return points
  } catch {
    return null
  }
}

function pontoNaAresta(x: number, y: number, a: EnvelopePoint, b: EnvelopePoint): boolean {
  const cross = (x - a.peso_kg) * (b.cg_estacao - a.cg_estacao) - (y - a.cg_estacao) * (b.peso_kg - a.peso_kg)
  if (Math.abs(cross) > 1e-9) return false
  return x >= Math.min(a.peso_kg, b.peso_kg) - 1e-9 && x <= Math.max(a.peso_kg, b.peso_kg) + 1e-9 &&
    y >= Math.min(a.cg_estacao, b.cg_estacao) - 1e-9 && y <= Math.max(a.cg_estacao, b.cg_estacao) + 1e-9
}

/** Point-in-polygon for (weight kg, station) coordinates. Points on the boundary are inside. */
export function pontoDentroEnvelope(pesoKg: number, cgEstacao: number, envelope: EnvelopePoint[]): boolean {
  if (!Number.isFinite(pesoKg) || !Number.isFinite(cgEstacao) || envelope.length < 3) return false
  let dentro = false
  for (let i = 0, j = envelope.length - 1; i < envelope.length; j = i++) {
    const a = envelope[j]
    const b = envelope[i]
    if (pontoNaAresta(pesoKg, cgEstacao, a, b)) return true
    const cruza = (a.cg_estacao > cgEstacao) !== (b.cg_estacao > cgEstacao) &&
      pesoKg < ((b.peso_kg - a.peso_kg) * (cgEstacao - a.cg_estacao)) / (b.cg_estacao - a.cg_estacao) + a.peso_kg
    if (cruza) dentro = !dentro
  }
  return dentro
}

export function erroConfiguracaoPeso(config: WeightConfiguration | null | undefined): string | null {
  if (!config || !(config.validado === true || Number(config.validado) === 1)) return 'configuracao_peso_nao_validada'
  const pesoVazio = Number(config.peso_vazio_padrao)
  const bracoVazio = Number(config.braco_cg_padrao)
  const limites = [config.peso_maximo_decolagem, config.peso_maximo_pouso, config.peso_maximo_sem_combustivel].map(Number)
  const cgDianteiro = Number(config.cg_limite_dianteiro)
  const cgTraseiro = Number(config.cg_limite_traseiro)
  const mac = Number(config.mac_comprimento)
  const lemac = Number(config.lemac_distancia)
  if (!Number.isFinite(pesoVazio) || pesoVazio <= 0 || !Number.isFinite(bracoVazio) ||
      limites.some((limite) => !Number.isFinite(limite) || limite <= 0)) return 'limites_peso_nao_configurados'
  if (!Number.isFinite(cgDianteiro) || !Number.isFinite(cgTraseiro) || cgDianteiro >= cgTraseiro ||
      !Number.isFinite(mac) || mac <= 0 || !Number.isFinite(lemac) || lemac <= 0) return 'limites_cg_nao_configurados'
  if (!parseEnvelope(config.envelope_pontos_json)) return 'envelope_peso_nao_configurado'
  if (!String(config.data_ultima_pesagem ?? '').trim() || !String(config.numero_relatorio_pesagem ?? '').trim() || !String(config.responsavel_tecnico ?? '').trim()) return 'evidencias_pesagem_obrigatorias'
  return null
}

function numeroPositivo(value: unknown): number | null {
  const numero = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(numero) && numero > 0 ? numero : null
}

function numeroEstacao(value: unknown): number | null {
  const numero = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(numero) ? numero : null
}

export function calcularPesoBalanceamento(config: WeightConfiguration, input: WeightCalculationInput): { ok: true; resultado: WeightCalculation; itens: LoadItem[] } | { ok: false; error: string; detail: string } {
  const envelope = parseEnvelope(config.envelope_pontos_json)
  if (!envelope) return { ok: false, error: 'envelope_peso_nao_configurado', detail: 'A configuração aprovada precisa conter um envelope com pelo menos três pontos em peso_kg × cg_estacao.' }

  const itens = input.itens_carregamento.filter((item) => String(item?.categoria ?? '').trim().toLowerCase() !== 'combustivel' && String(item?.descricao ?? '').trim().toLocaleLowerCase('pt-BR') !== 'combustível')
  if (!itens.length) return { ok: false, error: 'itens_carregamento_invalidos', detail: 'Informe um item de carga para cada passageiro, com peso positivo e braço válido.' }
  if (itens.some((item) => !String(item?.descricao ?? '').trim() || !numeroPositivo(item?.peso_kg ?? item?.peso) || numeroEstacao(item?.braco) === null)) {
    return { ok: false, error: 'itens_carregamento_invalidos', detail: 'Cada passageiro e item carregado precisa de descrição, peso positivo e braço/estação válido.' }
  }

  const cargasPassageiros = itens.filter((item) => String(item?.categoria ?? '').trim().toLocaleLowerCase('pt-BR') === 'passageiro')
  const passageirosPendentes = [...input.passageiros]
  for (const item of cargasPassageiros) {
    const index = passageirosPendentes.findIndex((nome) => nome.toLocaleLowerCase('pt-BR') === String(item.descricao ?? '').trim().toLocaleLowerCase('pt-BR'))
    if (index < 0) return { ok: false, error: 'carga_passageiros_incompativel', detail: 'Cada item da categoria passageiro deve corresponder a um nome da solicitação.' }
    passageirosPendentes.splice(index, 1)
  }
  if (passageirosPendentes.length || cargasPassageiros.length !== input.passageiros.length) return { ok: false, error: 'carga_passageiros_incompleta', detail: 'Informe exatamente um item de carga da categoria passageiro para cada nome da solicitação.' }

  const pesoVazio = numeroPositivo(config.peso_vazio_padrao)
  const bracoVazio = numeroEstacao(config.braco_cg_padrao)
  const fuelKg = numeroPositivo(input.fuel_kg)
  const litrosEntrada = input.fuel_litros
  const litros = litrosEntrada === null || litrosEntrada === undefined || litrosEntrada === '' ? null : Number(litrosEntrada)
  const fuelArm = numeroEstacao(input.fuel_braco)
  const consumo = Number(input.consumo_estimado_combustivel_kg)
  const capacidadeFuel = Number(config.capacidade_combustivel_util)
  if (!pesoVazio || bracoVazio === null || !fuelKg || (litros !== null && (!Number.isFinite(litros) || litros < 0)) || fuelArm === null || !Number.isFinite(consumo) || consumo < 0 || consumo > fuelKg || (Number.isFinite(capacidadeFuel) && capacidadeFuel > 0 && fuelKg > capacidadeFuel)) {
    return { ok: false, error: 'dados_peso_combustivel_invalidos', detail: 'Revise peso vazio, massa e capacidade do combustível, braço/estação e consumo previsto até o pouso.' }
  }

  const cargaPeso = itens.reduce((total, item) => total + Number(item.peso_kg ?? item.peso), 0)
  const cargaMomento = itens.reduce((total, item) => total + Number(item.peso_kg ?? item.peso) * Number(item.braco), 0)
  const pesoSemCombustivel = pesoVazio + cargaPeso
  const momentoVazio = pesoVazio * bracoVazio
  const momentoZeroCombustivel = momentoVazio + cargaMomento
  const cgZeroCombustivel = momentoZeroCombustivel / pesoSemCombustivel
  const envelopeZeroCombustivelOk = pontoDentroEnvelope(pesoSemCombustivel, cgZeroCombustivel, envelope)
  const momentoDecolagem = momentoZeroCombustivel + fuelKg * fuelArm
  const pesoDecolagem = pesoSemCombustivel + fuelKg
  const cgDecolagem = momentoDecolagem / pesoDecolagem
  const pesoPouso = pesoDecolagem - consumo
  const momentoPouso = momentoDecolagem - consumo * fuelArm
  const cgPouso = momentoPouso / pesoPouso
  const envelopeDecolagemOk = pontoDentroEnvelope(pesoDecolagem, cgDecolagem, envelope)
  const envelopePousoOk = pontoDentroEnvelope(pesoPouso, cgPouso, envelope)
  const dentroLimites = pesoDecolagem <= Number(config.peso_maximo_decolagem) && pesoPouso <= Number(config.peso_maximo_pouso) &&
    pesoPouso > 0 && pesoSemCombustivel <= Number(config.peso_maximo_sem_combustivel) && envelopeZeroCombustivelOk && envelopeDecolagemOk && envelopePousoOk
  if (!dentroLimites) return { ok: false, error: 'ficha_fora_dos_limites', detail: 'O peso sem combustível, peso de decolagem/pouso ou o CG em estação em alguma fase está fora dos limites técnicos aprovados.' }

  return {
    ok: true,
    itens,
    resultado: {
      peso_decolagem_kg: pesoDecolagem,
      momento_decolagem: momentoDecolagem,
      cg_decolagem_estacao: cgDecolagem,
      peso_pouso_kg: pesoPouso,
      momento_pouso: momentoPouso,
      cg_pouso_estacao: cgPouso,
      peso_sem_combustivel_kg: pesoSemCombustivel,
      cg_zero_combustivel_estacao: cgZeroCombustivel,
      envelope_decolagem_ok: envelopeDecolagemOk,
      envelope_pouso_ok: envelopePousoOk,
      envelope_zero_combustivel_ok: envelopeZeroCombustivelOk,
    },
  }
}
