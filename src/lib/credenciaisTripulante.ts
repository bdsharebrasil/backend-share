export type HabilitacaoTripulante = {
  id: string; tipo_habilitacao: string; data_validade: string | null;
  validade_cma: string | null; classe_cma: string | null; fs_rh: string | null;
}

/** Preserva todos os registros; o CMA explícito mais recente prevalece sobre campos legados. */
export function resumirCredenciais(registros: HabilitacaoTripulante[]) {
  const tipo = (r: HabilitacaoTripulante) => r.tipo_habilitacao.trim().toUpperCase();
  const explicitos = registros.filter(r => tipo(r) === 'CMA');
  const candidatos = explicitos.length ? explicitos : registros.filter(r => r.validade_cma);
  const cma = [...candidatos].sort((a, b) =>
    String(b.validade_cma || b.data_validade || '').localeCompare(String(a.validade_cma || a.data_validade || '')) || a.id.localeCompare(b.id))[0];
  return {
    habilitacoes: registros.filter(r => !['CMA', 'FS/RH'].includes(tipo(r))),
    cma: cma ? { id: cma.id, classe: cma.classe_cma, validade: cma.validade_cma || cma.data_validade } : null,
  };
}

export async function carregarCredenciaisTripulante(db: D1Database, tripulanteId?: string) {
  if (!tripulanteId) return { habilitacoes: [], cma: null };
  const registros = await db.prepare(`SELECT id, tipo_habilitacao, data_validade, validade_cma, classe_cma, fs_rh
    FROM habilitacoes_tripulante WHERE tripulacao_id = ?1 ORDER BY tipo_habilitacao, data_validade DESC, id`)
    .bind(tripulanteId).all<HabilitacaoTripulante>();
  return resumirCredenciais(registros.results || []);
}
