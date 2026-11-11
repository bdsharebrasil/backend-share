/** A natureza econômica é independente da forma de distribuir a despesa entre cotistas. */
export type GrupoNaturezaCusto = "fixos" | "variaveis" | "extras" | "naoClassificados";
export type CustoPeriodo = { total: number; fixos: number; variaveis: number; extras: number; naoClassificados: number };
export type ClassificacaoNatureza = { grupo: GrupoNaturezaCusto; origem: "informada" | "categoria" | "descricao" | "nao_informada" };

const normalizar = (valor: unknown) => String(valor ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const primeiroPreenchido = (...valores: unknown[]) => valores.find((valor) => String(valor ?? "").trim());
const CATEGORIAS_FIXAS = new Set(["TRIPULACAO ADM", "ADM E TRIP SHARE", "TRIPULACAO E ADM", "HANGARAGEM", "HANGARAGENS", "HANGARAREM"]);
const CATEGORIAS_VARIAVEIS = new Set(["MANUTENCAO", "TAXAS AEROPORTUARIAS", "TARIFAS AEROPORTUARIAS"]);

export function obterClassificacaoNatureza(registro: Record<string, unknown>): ClassificacaoNatureza {
  // O cadastro explícito tem prioridade, inclusive para exceções às regras abaixo.
  // Não usar tipoRateio, tipo_rateio, grupoCategoria ou periodicidade: eles não são natureza.
  const informada = primeiroPreenchido(registro.naturezaCusto, registro.natureza_custo);
  if (informada !== undefined) {
    const natureza = normalizar(informada);
    if (["FIXO", "CUSTO FIXO"].includes(natureza)) return { grupo: "fixos", origem: "informada" };
    if (["VARIAVEL", "VARIAVEL POR HORA", "VARIAVEL POR VOO"].includes(natureza)) return { grupo: "variaveis", origem: "informada" };
    if (["EXTRA", "CUSTO EXTRA"].includes(natureza)) return { grupo: "extras", origem: "informada" };
    return { grupo: "naoClassificados", origem: "nao_informada" };
  }

  const categoria = normalizar(primeiroPreenchido(registro.categoria, registro.categoria_nome));
  const descricao = normalizar(primeiroPreenchido(registro.descricao, registro.descricao_despesa));
  const porCategoria = CATEGORIAS_FIXAS.has(categoria) ? "fixos" : CATEGORIAS_VARIAVEIS.has(categoria) ? "variaveis" : null;
  const descricaoFixa = /\bHANGARAGEM\b/.test(descricao) || /\bADM(?:INISTRACAO)?\b.*\b(?:PILOT(?:AGEM)?|TRIP(?:ULACAO)?)\b/.test(descricao);
  const descricaoVariavel = /\bDECEA\b/.test(descricao) || /\b(?:TROCA|SUBSTITUICAO)\b.*\bPNEUS?\b/.test(descricao) || /\bPECAS?\b.*\bMANUT(?:ENCAO)?\b/.test(descricao);
  const porDescricao = descricaoFixa === descricaoVariavel ? null : descricaoFixa ? "fixos" : "variaveis";

  // Categorias mistas (ex.: HANGARAGENS & TAXAS) precisam de descrição específica.
  // Evidências conflitantes ou desconhecidas continuam sem classificação.
  if (descricaoFixa && descricaoVariavel || porCategoria && porDescricao && porCategoria !== porDescricao) return { grupo: "naoClassificados", origem: "nao_informada" };
  if (porCategoria) return { grupo: porCategoria, origem: "categoria" };
  if (porDescricao) return { grupo: porDescricao, origem: "descricao" };
  return { grupo: "naoClassificados", origem: "nao_informada" };
}

export function classificarNaturezaCusto(registro: Record<string, unknown>): GrupoNaturezaCusto {
  return obterClassificacaoNatureza(registro).grupo;
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

