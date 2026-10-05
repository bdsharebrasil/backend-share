import { Hono } from "hono"
import { errorResponse } from "./errorResponse"

type Bindings = { GEMINI_API_KEY?: string; SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string }
type Variables = { userId: string | null }

export const demonstrativoIARoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const DEMONSTRATIVO_IA_PROMPT = (tipo: string) => `Você é um EXTRATOR DE DADOS estritamente fiel de demonstrativos/faturas de tarifas aeroportuárias e de navegação aérea brasileiras.
O campo TIPO DO DEMONSTRATIVO informado pelo usuário é ${tipo}. Antes de extrair as linhas, confira o cabeçalho/layout: "DEMONSTRATIVO DAS TARIFAS A COBRAR", colunas POU/PER/PAN/PAT e emissor INFRAERO indicam TARIFA DE POUSO (INFRAERO); documento emitido pelo DECEA, com TAN/TAT, plano de voo IFR e rota origem-destino, indica TARIFA DECEA. Não confunda o aeroporto emissor com uma rota DECEA.

Sua única tarefa é TRANSCREVER o que está escrito no documento. Você NÃO conhece a operação da aeronave, não sabe quem é o cotista/dono do avião, e não sabe a rota que o avião fez. NÃO adivinhe, NÃO infira, NÃO complete nada que não esteja literalmente no documento.

FORMATO DE SAÍDA — responda EXCLUSIVAMENTE com este JSON, sem markdown, sem comentários, sem texto fora do JSON:
{
  "numero_documento": string|null,
  "competencia": string|null,
  "data_faturamento": string|null,
  "aeronave_matricula": string|null,
  "tipo_detectado": "INFRAERO"|"DECEA"|"POUSO"|null,
  "cliente_nome": string|null,
  "valor_total": number|null,
  "itens": [
    {
      "data": "YYYY-MM-DD",
      "hora": "HH:MM"|null,
      "operacao": string|null,
      "origem": string|null,
      "destino": string|null,
      "matricula": string|null,
      "valor": number
    }
  ]
}

REGRAS OBRIGATÓRIAS POR ITEM:
1. "data": data do evento da tarifa, SEMPRE em YYYY-MM-DD (converta DD/MM/AAAA quando for o caso).
2. "hora": horário exato no formato HH:MM (24h). Se não houver horário no documento, use null — nunca invente.
3. Para INFRAERO/POUSO: "operacao" é o código ICAO de 4 letras do aeródromo onde ocorreu o pouso (ex: SBCY, SBGL), repetido em cada item quando o documento não variar o aeroporto; deixe origem e destino null.
4. Para DECEA: quando a linha trouxer uma rota/plano de voo, preencha "origem" e "destino" com os códigos ICAO de 4 letras. Não force "operacao" nem descarte a rota; se houver apenas um aeródromo/evento, use "operacao" e deixe origem/destino null.
5. "valor": número decimal puro (float), sem "R$", sem separador de milhar, com ponto decimal. Ex: "R$ 1.234,56" vira 1234.56.
6. "matricula": matrícula da aeronave se aparecer na linha; senão null.

REGRAS DE NEGÓCIO — OBRIGATÓRIAS:
- INFRAERO (tarifa de pouso) é cobrada por POUSO, no aeródromo onde o avião ATERRISSOU. O documento NÃO mostra de onde o avião veio nem para onde foi.
- Para DECEA, a ligação com o trecho voado usa origem e destino extraídos do plano de voo e depois é confirmada pelo diário de bordo. Para INFRAERO/POUSO, a ligação usa o aeródromo de chegada e o horário do pouso.
- NUNCA escreva nome de cotista, cliente, sócio ou proprietário nos itens, mesmo que veja anotação manuscrita no documento sugerindo isso. Ignore.
- NUNCA invente, arredonde ou corrija valores — apenas converta o formato numérico do que está escrito.
- "itens" nunca pode ser null/omitido; se não houver linha legível, retorne [].
- Inclua TODAS as linhas do documento, na ordem em que aparecem.
- Campo ausente no documento → null (nunca repita o rótulo da coluna como valor).
- Se o cabeçalho/layout contradizer o tipo informado, informe o tipo real em "tipo_detectado", mas continue extraindo fielmente as linhas. Nesse caso, nunca fabrique origem/destino.`

type ItemExtraidoBruto = Record<string, unknown>

function paraNumeroDemonstrativo(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor
  if (typeof valor !== 'string') return null
  const limpo = valor
    .replace(/R\$\s?/gi, '')
    .trim()
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
  const numero = Number(limpo)
  return Number.isFinite(numero) ? numero : null
}

function paraDataIsoDemonstrativo(valor: unknown): string {
  const texto = String(valor ?? '').trim()
  if (!texto) return ''
  const brasileira = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (brasileira) return `${brasileira[3]}-${brasileira[2]}-${brasileira[1]}`
  const iso = texto.match(/^\d{4}-\d{2}-\d{2}/)
  return iso ? iso[0] : texto
}

function normalizarItensDemonstrativo(dados: Record<string, unknown>): Record<string, unknown> {
  const itensBrutos = Array.isArray(dados.itens) ? (dados.itens as ItemExtraidoBruto[]) : []
  // Nos demonstrativos INFRAERO a matrícula normalmente aparece apenas no
  // cabeçalho (como PRMDL no demonstrativo mensal), não em cada operação.
  // Propagar esse contexto para cada item evita que o cruzamento dependa de
  // uma repetição que não existe no documento.
  const matriculaCabecalho = dados.aeronave_matricula ? String(dados.aeronave_matricula).trim().toUpperCase() : null
  const itens = itensBrutos.map((item) => ({
    ...item,
    data: paraDataIsoDemonstrativo(item.data),
    hora: item.hora ? String(item.hora).slice(0, 5) : null,
    operacao: item.operacao ? String(item.operacao).trim().toUpperCase() : null,
    origem: item.origem ? String(item.origem).trim().toUpperCase() : null,
    destino: item.destino ? String(item.destino).trim().toUpperCase() : null,
    matricula: item.matricula ? String(item.matricula).trim().toUpperCase() : matriculaCabecalho,
    valor: paraNumeroDemonstrativo(item.valor) ?? 0,
  }))
  const somaItens = Math.round(itens.reduce((total, item) => total + (Number(item.valor) || 0), 0) * 100) / 100
  const valorTotal = paraNumeroDemonstrativo(dados.valor_total)
  const precisaRevisaoManual = valorTotal !== null && Math.abs(somaItens - valorTotal) > 0.01
  return {
    ...dados,
    tipo_detectado: dados.tipo_detectado ? String(dados.tipo_detectado).trim().toUpperCase() : null,
    valor_total: valorTotal,
    itens,
    _meta: { soma_itens: somaItens, precisa_revisao_manual: precisaRevisaoManual },
  }
}

function normalizarBase64(value: unknown): string {
  return String(value ?? '').replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
}

demonstrativoIARoutes.post('/recibos/leitura-demonstrativo', async (c) => {
  try {
    const body = await c.req.json<{ imageBase64?: string; image?: string; mimeType?: string; tipo?: string }>().catch(() => ({} as { imageBase64?: string; image?: string; mimeType?: string; tipo?: string }))
    const base64 = normalizarBase64(body.imageBase64 ?? body.image)
    const mimeType = String(body.mimeType || 'application/pdf').trim().toLowerCase()
    const tipo = String(body.tipo || 'INFRAERO').trim().toUpperCase()
    if (base64.length < 100) return c.json({ error: 'arquivo_invalido' }, 400)
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return c.json({ error: 'tipo_arquivo_nao_suportado' }, 400)
    const payload = { imageBase64: base64, mimeType, tipo }
    const resposta = c.env.GEMINI_API_KEY
      ? await (async () => {
        const modelos = ['gemini-flash-latest', 'gemini-3.6-flash']
        let aiRes: Response | null = null
        const maxAttempts = 3
        for (const modelo of modelos) {
          let attempts = 0
          while (attempts < maxAttempts) {
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(c.env.GEMINI_API_KEY as string)}`
            aiRes = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: DEMONSTRATIVO_IA_PROMPT(tipo) }] },
                contents: [{ role: 'user', parts: [{ text: `Tipo do demonstrativo: ${tipo}. Extraia os dados para revisão manual; não crie nem altere registros.` }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
                generationConfig: { response_mime_type: 'application/json' },
              }),
            })
            if (aiRes.status !== 503) return aiRes
            attempts++
            if (attempts < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 2000 * attempts))
          }
        }
        return aiRes
      })()
      : c.env.SUPABASE_URL && c.env.SUPABASE_ANON_KEY
        ? await fetch(`${c.env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/demonstrativo-ocr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: c.env.SUPABASE_ANON_KEY, Authorization: c.req.header('Authorization') || '' },
          body: JSON.stringify(payload),
        })
        : null
    if (!resposta) return c.json({ error: 'servico_de_leitura_ia_nao_configurado' }, 503)
    if (!resposta.ok) return c.json({ error: 'falha_na_leitura_por_ia', details: await resposta.text() }, 502)
    const json = await resposta.json<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; dados_extraidos?: Record<string, unknown> }>()
    if (json.dados_extraidos) return c.json({ sucesso: true, persistido: false, tipo, dados_extraidos: normalizarItensDemonstrativo(json.dados_extraidos) })
    const texto = String(json.candidates?.[0]?.content?.parts?.[0]?.text || '{}').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
    let dados: Record<string, unknown>
    try { dados = JSON.parse(texto) as Record<string, unknown> } catch { return c.json({ error: 'formato_invalido_retornado_pela_ia' }, 422) }
    return c.json({ sucesso: true, persistido: false, tipo, dados_extraidos: normalizarItensDemonstrativo(dados) })
  } catch (error) { return errorResponse(c, error) }
})
