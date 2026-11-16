import { REGRAS_REFERENCIA } from "./pontoGestao";
// Conferido no documento anexado pelo usuário, páginas 1, 5, 16 e 19-20.
export const CCT_SINEATA_FENASCON_2025 = {
  grupo_codigo: "SINEATA_FENASCON_ADMIN",
  nome: "SINEATA × FENASCON 2025 · Administrativo",
  vigencia_inicio: "2025-01-01",
  vigencia_fim: "2025-12-31",
  fonte_documento:
    "CCT SINEATA × FENASCON 2025 assinada; cláusulas 1, 2, 8, 24, 25, 27 e 29. SHA-256: 415a7dd96ec95630a776fb258ae120283de9b81f28570fd7c8c282408c5b2834",
  parametros: {
    ...REGRAS_REFERENCIA,
    adicional_noturno_percentual: 40,
    dsr_noturno_percentual: 25,
    extra_util_percentual: 60,
    extra_domingo_feriado_percentual: 100,
    dsr_extras_percentual: 25,
    banco_horas: true,
    banco_validade_meses: 2,
    banco_fator_util: 2,
    banco_fator_domingo_feriado: 2.5,
    intervalo_curto_remunerado: true,
    carga_semanal_limite_min: 2640,
    antecedencia_escala_dias: 5,
    sobreaviso_validado: false,
    ufs_abrangencia:
      "AC,AL,AP,BA,CE,DF,ES,GO,MA,MS,PA,PB,PE,PI,PR,RN,RO,RR,RS,SC,SE,TO",
  },
};
export const BASES_CCT_PONTO = [
  CCT_SINEATA_FENASCON_2025,
  {
    ...CCT_SINEATA_FENASCON_2025,
    grupo_codigo: "SINEATA_FENASCON_OPERACIONAL",
    nome: "SINEATA × FENASCON 2025 · Operacional",
    parametros: {
      ...CCT_SINEATA_FENASCON_2025.parametros,
      carga_semanal_limite_min: 2520,
    },
  },
];

// Aplicação operacional em 2026 solicitada pelo responsável pelo projeto.
// Não altera o instrumento assinado em 2025 e não afirma sua ultratividade.
export const REFERENCIAS_INTERNAS_2026 = BASES_CCT_PONTO.map((base) => ({
  ...base,
  nome: `${base.nome.split("2025")[0]}2026 · referência interna baseada em 2025 · ${base.nome.endsWith("Operacional") ? "Operacional" : "Administrativo"}`,
  vigencia_inicio: "2026-01-01",
  vigencia_fim: "2026-12-31",
  fonte_documento: `${base.fonte_documento}; aplicação interna em 2026 por instrução do responsável, sem declaração de nova CCT ou prorrogação sindical`,
  parametros: { ...base.parametros, ufs_abrangencia: "" },
}));
