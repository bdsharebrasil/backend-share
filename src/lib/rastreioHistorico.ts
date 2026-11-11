import type { PosicaoAeronave } from './adsbProvider'

export const LIMITE_SINAL_S = 120
export type PontoTrilha = { lat: number; lon: number; alt_ft: number; registrado_em: string; trilha_id: string }
export type EventoRastreio = { id: number; tipo: 'SINAL_RECEBIDO' | 'SINAL_PERDIDO' | 'EM_SOLO_ADSB'; ocorrido_em: string; detectado_em: string; lat: number; lon: number }
export type HistoricoRastreio = { trilha: PontoTrilha[]; eventos: EventoRastreio[]; disponivel: boolean }

export function instantePosicao(posicao: PosicaoAeronave | null, agora: number): string | null {
  const idade = posicao?.visto_ha_s
  return idade != null && idade >= 0 && idade <= 30 ? new Date(agora - idade * 1000).toISOString() : null
}

/** D1 batch mantém evento e estado na mesma transação; condições SQL evitam eventos duplicados entre cron e tela. */
export async function registrarSinal(db: D1Database, solicitacaoId: string, trilhaId: string, posicao: PosicaoAeronave | null, indisponivel: boolean, agora = Date.now()): Promise<void> {
  if (indisponivel) return
  const consultaEm = new Date(agora).toISOString()
  const observadoEm = instantePosicao(posicao, agora)
  if (observadoEm && posicao) {
    await db.batch([
      db.prepare(`INSERT INTO rastreio_eventos (solicitacao_id, tipo, ocorrido_em, detectado_em, lat, lon)
        SELECT solicitacao_id, 'SINAL_PERDIDO', ultimo_sinal_em, ?2, lat, lon FROM rastreio_sinais
        WHERE solicitacao_id = ?1 AND sinal_ativo = 1 AND julianday(ultimo_sinal_em) < julianday(?3, '-${LIMITE_SINAL_S} seconds')`)
        .bind(solicitacaoId, consultaEm, observadoEm),
      db.prepare(`UPDATE rastreio_sinais SET sinal_ativo = 0
        WHERE solicitacao_id = ?1 AND sinal_ativo = 1 AND julianday(ultimo_sinal_em) < julianday(?2, '-${LIMITE_SINAL_S} seconds')`)
        .bind(solicitacaoId, observadoEm),
      db.prepare(`INSERT INTO rastreio_eventos (solicitacao_id, tipo, ocorrido_em, detectado_em, lat, lon)
        SELECT ?1, 'SINAL_RECEBIDO', ?2, ?3, ?4, ?5
        WHERE NOT EXISTS (SELECT 1 FROM rastreio_sinais WHERE solicitacao_id = ?1 AND sinal_ativo = 1)`)
        .bind(solicitacaoId, observadoEm, consultaEm, posicao.lat, posicao.lon),
      db.prepare(`INSERT INTO rastreio_eventos (solicitacao_id, tipo, ocorrido_em, detectado_em, lat, lon)
        SELECT ?1, 'EM_SOLO_ADSB', ?2, ?3, ?4, ?5 FROM rastreio_sinais
        WHERE solicitacao_id = ?1 AND sinal_ativo = 1 AND no_solo = 0 AND ?6 = 1 AND ultimo_sinal_em < ?2`)
        .bind(solicitacaoId, observadoEm, consultaEm, posicao.lat, posicao.lon, Number(posicao.no_solo)),
      db.prepare(`INSERT INTO rastreio_posicoes (trilha_id, solicitacao_id, lat, lon, alt_ft, rumo_graus, registrado_em)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
        WHERE NOT EXISTS (SELECT 1 FROM rastreio_posicoes WHERE solicitacao_id = ?2 AND julianday(registrado_em) >= julianday(?7, '-15 seconds'))`)
        .bind(trilhaId, solicitacaoId, posicao.lat, posicao.lon, posicao.no_solo ? 0 : posicao.alt_ft ?? 0, posicao.rumo_graus, observadoEm),
      db.prepare(`INSERT INTO rastreio_sinais (solicitacao_id, sinal_ativo, no_solo, ultimo_sinal_em, lat, lon)
        VALUES (?1, 1, ?2, ?3, ?4, ?5)
        ON CONFLICT(solicitacao_id) DO UPDATE SET sinal_ativo = 1, no_solo = excluded.no_solo,
          ultimo_sinal_em = excluded.ultimo_sinal_em, lat = excluded.lat, lon = excluded.lon
        WHERE excluded.ultimo_sinal_em >= rastreio_sinais.ultimo_sinal_em`)
        .bind(solicitacaoId, Number(posicao.no_solo), observadoEm, posicao.lat, posicao.lon),
    ])
  } else {
    await db.batch([
      db.prepare(`INSERT INTO rastreio_eventos (solicitacao_id, tipo, ocorrido_em, detectado_em, lat, lon)
        SELECT solicitacao_id, 'SINAL_PERDIDO', ultimo_sinal_em, ?2, lat, lon FROM rastreio_sinais
        WHERE solicitacao_id = ?1 AND sinal_ativo = 1 AND julianday(ultimo_sinal_em) < julianday(?2, '-${LIMITE_SINAL_S} seconds')`)
        .bind(solicitacaoId, consultaEm),
      db.prepare(`UPDATE rastreio_sinais SET sinal_ativo = 0
        WHERE solicitacao_id = ?1 AND sinal_ativo = 1 AND julianday(ultimo_sinal_em) < julianday(?2, '-${LIMITE_SINAL_S} seconds')`)
        .bind(solicitacaoId, consultaEm),
    ])
  }
}

export async function lerHistorico(db: D1Database, solicitacaoId: string): Promise<HistoricoRastreio> {
  try {
    // Mantém o voo inteiro, inclusive pontos anteriores à criação de uma perna na jornada.
    const [pontos, eventos] = await db.batch([
      db.prepare(`SELECT lat, lon, alt_ft, registrado_em, trilha_id FROM rastreio_posicoes WHERE solicitacao_id = ? ORDER BY julianday(registrado_em), id`).bind(solicitacaoId),
      db.prepare(`SELECT id, tipo, ocorrido_em, detectado_em, lat, lon FROM rastreio_eventos WHERE solicitacao_id = ? ORDER BY id`).bind(solicitacaoId),
    ])
    return { trilha: (pontos.results || []) as PontoTrilha[], eventos: (eventos.results || []) as EventoRastreio[], disponivel: true }
  } catch (erro) {
    console.warn('[rastreio] histórico indisponível', erro instanceof Error ? erro.message : erro)
    return { trilha: [], eventos: [], disponivel: false }
  }
}
