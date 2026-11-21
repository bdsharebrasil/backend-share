import { Hono, type Context } from 'hono'

/**
 * API versionada consumida pelo app mobile (Expo).
 *
 * Regra de ouro: nenhuma regra de negócio nova mora aqui. As rotas de clima e
 * plano de voo apenas reencaminham para as implementações legadas (AISWEB),
 * garantindo que o contrato antigo continue intacto para o painel web. Só
 * `/aerodromos` tem implementação própria, porque o app precisa de um contrato
 * enxuto e paginado (`limit`/`cursor`), diferente do retorno legado.
 *
 * Versionar importa: um app instalado não atualiza na hora, então /api/v1 não
 * pode mudar de forma incompatível.
 */

export type V1Bindings = { SHARE_DB: D1Database }

type AerodromoV1 = {
  id: string
  nome: string
  designativo_icao: string
  coordenadas: string | null
}

const LIMITE_PADRAO = 20
const LIMITE_MAXIMO = 50
const TAMANHO_MAXIMO_BUSCA = 60

/** Cursor opaco (base64url) para paginação por chave, sem OFFSET. */
function codificarCursor(valor: string): string {
  return btoa(valor).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodificarCursor(valor: string): string | null {
  try {
    const base64 = valor.replace(/-/g, '+').replace(/_/g, '/')
    const comPadding = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const decodificado = atob(comPadding)
    return decodificado.length > 0 && decodificado.length <= 8 ? decodificado : null
  } catch {
    return null
  }
}

/** Escapa curingas do LIKE para que a busca seja literal. */
function escaparLike(termo: string): string {
  return termo.replace(/[\\%_]/g, caractere => `\\${caractere}`)
}

function lerLimite(bruto: string | undefined): number {
  const numero = Number.parseInt(bruto ?? '', 10)
  if (!Number.isFinite(numero) || numero <= 0) return LIMITE_PADRAO
  return Math.min(numero, LIMITE_MAXIMO)
}

/**
 * Reencaminha a requisição para a rota legada equivalente dentro do mesmo app.
 * Não há chamada de rede: é apenas um novo dispatch do Hono, com o mesmo env.
 */
async function delegarParaLegado(
  legado: Hono<any>,
  c: Context<any>,
  caminho: string,
  busca = '',
): Promise<Response> {
  const destino = new URL(c.req.url)
  destino.pathname = caminho
  destino.search = busca
  const requisicao = new Request(destino.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
  })
  let executionCtx: Parameters<typeof legado.fetch>[2]
  try {
    executionCtx = c.executionCtx
  } catch {
    executionCtx = undefined
  }
  return legado.fetch(requisicao, c.env, executionCtx)
}

export function criarV1Routes(legado: Hono<any>) {
  const v1 = new Hono<{ Bindings: V1Bindings }>()

  /**
   * GET /api/v1/aerodromos?q=&limit=&cursor=
   * Busca por `LIKE` em `nome` e `designativo_icao`, devolvendo apenas os
   * campos que o app usa. `limit` padrão 20 (máximo 50) e paginação por cursor.
   */
  v1.get('/aerodromos', async c => {
    const busca = (c.req.query('q') ?? '').trim().slice(0, TAMANHO_MAXIMO_BUSCA)
    const limite = lerLimite(c.req.query('limit'))
    const cursorBruto = (c.req.query('cursor') ?? '').trim()

    let cursor = ''
    if (cursorBruto) {
      const decodificado = decodificarCursor(cursorBruto)
      if (!decodificado) return c.json({ error: 'cursor_invalido' }, 400)
      cursor = decodificado.toUpperCase()
    }

    const termo = `%${escaparLike(busca.toUpperCase())}%`
    try {
      const resultado = await c.env.SHARE_DB.prepare(
        `SELECT id, nome, designativo_icao, coordenadas
           FROM aerodromo
          WHERE (?1 = '' OR upper(designativo_icao) LIKE ?2 ESCAPE '\\' OR upper(nome) LIKE ?2 ESCAPE '\\')
            AND (?3 = '' OR upper(designativo_icao) > ?3)
          ORDER BY upper(designativo_icao) ASC
          LIMIT ?4`,
      )
        .bind(busca, termo, cursor, limite + 1)
        .all<AerodromoV1>()

      const linhas = resultado.results ?? []
      const pagina = linhas.slice(0, limite)
      const ultimo = pagina[pagina.length - 1]
      const proximoCursor =
        linhas.length > limite && ultimo?.designativo_icao
          ? codificarCursor(ultimo.designativo_icao.trim().toUpperCase())
          : null

      return c.json({ data: pagina, next_cursor: proximoCursor })
    } catch (erro: any) {
      console.error('[v1/aerodromos] falha ao consultar D1:', erro?.message ?? erro)
      return c.json({ error: 'falha_ao_consultar_aerodromos' }, 502)
    }
  })

  // Clima (METAR/TAF) — mesmo comportamento de /api/weather/:icao.
  v1.get('/weather/:icao', c => delegarParaLegado(legado, c, `/api/weather/${encodeURIComponent(c.req.param('icao'))}`))

  // Plano de voo — mesmos parâmetros de /api/flightplan (adep, ades, etc.).
  v1.get('/flightplan', c => {
    return delegarParaLegado(legado, c, '/api/flightplan', new URL(c.req.url).search)
  })

  return v1
}
