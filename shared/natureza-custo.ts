/** A natureza econômica é independente da forma de distribuir a despesa entre cotistas. */
export type GrupoNaturezaCusto = "fixos" | "variaveis" | "extras" | "naoClassificados";
export type CustoPeriodo = { total: number; fixos: number; variaveis: number; extras: number; naoClassificados: number };

export function classificarNaturezaCusto(registro: Record<string, unknown>): GrupoNaturezaCusto {
  // Não usar tipoRateio, tipo_rateio, grupoCategoria ou periodicidade como natureza.
  // grupoCategoria também é um alias de tipo_rateio em respostas legadas.
  const natureza = String(registro.naturezaCusto ?? registro.natureza_custo ?? "")
    .trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, "_");
  if (["FIXO", "CUSTO_FIXO"].includes(natureza)) return "fixos";
  if (["VARIAVEL", "VARIAVEL_POR_HORA", "VARIAVEL_POR_VOO"].includes(natureza)) return "variaveis";
  if (["EXTRA", "CUSTO_EXTRA"].includes(natureza)) return "extras";
  return "naoClassificados";
}

export function projetarCustoPeriodo(total: CustoPeriodo, horasRegistradas: number | null, meses: number, horasProjetadas: number, fatorFixo = 1) {
  if (horasRegistradas === null || ![horasRegistradas, meses, horasProjetadas].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (!Object.values(total).every(Number.isFinite)) return null;
  if (total.naoClassificados !== 0) {
    // Sem natureza econômica, projeta pelo custo/hora observado, sem inventar parcelas.
    const custoHora = total.total / horasRegistradas;
    return { metodo: "media_historica" as const, fixoHora: null, variavelHora: null, extraHora: null, custoHora, custoMensal: custoHora * horasProjetadas };
  }
  if (!Number.isFinite(fatorFixo) || fatorFixo <= 0) return null;
  const fixoMensal = total.fixos / meses * fatorFixo;
  const fixoHora = fixoMensal / horasProjetadas;
  const variavelHora = total.variaveis / horasRegistradas;
  const extraHora = total.extras / horasRegistradas;
  return { metodo: "natureza_custo" as const, fixoHora, variavelHora, extraHora,
    custoHora: fixoHora + variavelHora + extraHora,
    custoMensal: fixoMensal + (total.variaveis + total.extras) / horasRegistradas * horasProjetadas };
}

