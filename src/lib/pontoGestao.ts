export type TipoEscala = "12X36" | "6X1" | "5X2" | "ROTATIVA" | "SOBREAVISO";
export type DiaEscala = {
  tipo: "TRABALHO" | "FOLGA" | "SOBREAVISO";
  entrada?: string;
  saida?: string;
  intervalo_min?: number;
};
export type RegrasPonto = {
  tolerancia_atraso_min: number;
  pausa_apos_min: number;
  intervalo_longo_min: number;
  intervalo_curto_min: number;
  noturno_inicio: string;
  noturno_fim: string;
  hora_noturna_min: number;
  adicional_noturno_percentual: number;
  sobreaviso_fator: number;
  banco_horas: boolean;
  banco_validade_meses: number;
  prorrogacao_noturna: boolean;
  fechamento_automatico: boolean;
  dsr_noturno_percentual: number;
  extra_util_percentual: number;
  extra_domingo_feriado_percentual: number;
  dsr_extras_percentual: number;
  banco_fator_util: number;
  banco_fator_domingo_feriado: number;
  carga_semanal_limite_min: number;
  intervalo_curto_remunerado: boolean;
  sobreaviso_validado: boolean;
  antecedencia_escala_dias: number;
  ufs_abrangencia: string;
};
export const REGRAS_REFERENCIA: RegrasPonto = {
  tolerancia_atraso_min: 5,
  pausa_apos_min: 360,
  intervalo_longo_min: 60,
  intervalo_curto_min: 15,
  noturno_inicio: "22:00",
  noturno_fim: "05:00",
  hora_noturna_min: 52.5,
  adicional_noturno_percentual: 20,
  sobreaviso_fator: 1 / 3,
  banco_horas: false,
  banco_validade_meses: 6,
  prorrogacao_noturna: false,
  fechamento_automatico: true,
  dsr_noturno_percentual: 0,
  extra_util_percentual: 50,
  extra_domingo_feriado_percentual: 100,
  dsr_extras_percentual: 0,
  banco_fator_util: 1,
  banco_fator_domingo_feriado: 1,
  carga_semanal_limite_min: 2640,
  intervalo_curto_remunerado: false,
  sobreaviso_validado: false,
  antecedencia_escala_dias: 0,
  ufs_abrangencia: "",
};
export function normalizarPonto(valor: unknown): string {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}
export function departamentoBatePonto(departamento: unknown): boolean {
  return [
    "financeiro",
    "administrativo",
    "operacoes",
    "ctm",
    "financeiro administrativo",
  ].includes(normalizarPonto(departamento));
}
export function dataValida(data: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(data) &&
    !Number.isNaN(Date.parse(`${data}T00:00:00Z`)) &&
    new Date(`${data}T00:00:00Z`).toISOString().slice(0, 10) === data
  );
}
export function horaValida(hora: unknown): hora is string {
  return typeof hora === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hora);
}
export function minutosHora(hora: string): number {
  if (!horaValida(hora)) throw new Error("horario_invalido");
  const [h, m] = hora.split(":").map(Number);
  return h! * 60 + m!;
}
export function somarDias(data: string, dias: number): string {
  if (!dataValida(data)) throw new Error("data_invalida");
  return new Date(Date.parse(`${data}T12:00:00Z`) + dias * 86400_000)
    .toISOString()
    .slice(0, 10);
}
export function datasMes(mes: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(mes) || !dataValida(`${mes}-01`))
    throw new Error("mes_invalido");
  const datas: string[] = [];
  for (let dia = `${mes}-01`; dia.slice(0, 7) === mes; dia = somarDias(dia, 1))
    datas.push(dia);
  return datas;
}
export function validarFuso(fuso: unknown): string {
  if (typeof fuso !== "string" || fuso.length > 80)
    throw new Error("fuso_invalido");
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: fuso }).format();
    return fuso;
  } catch {
    throw new Error("fuso_invalido");
  }
}
const formatadores = new Map<string, Intl.DateTimeFormat>();
export function horarioNoFuso(instante: Date | number, fuso: string) {
  let fmt = formatadores.get(fuso);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: validarFuso(fuso),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatadores.set(fuso, fmt);
  }
  const p = Object.fromEntries(
    fmt.formatToParts(instante).map((x) => [x.type, x.value]),
  );
  return {
    data: `${p.year}-${p.month}-${p.day}`,
    hora: `${p.hour}:${p.minute}`,
    segundo: p.second,
  };
}
export function instanteLocal(
  data: string,
  hora: string,
  fuso: string,
): number {
  if (!dataValida(data) || !horaValida(hora))
    throw new Error("data_ou_horario_invalido");
  const base = Date.parse(`${data}T${hora}:00Z`);
  let instante = base;
  for (let i = 0; i < 4; i++) {
    const local = horarioNoFuso(instante, fuso);
    const deslocamento =
      Date.parse(`${local.data}T${local.hora}:${local.segundo}Z`) - instante;
    instante = base - deslocamento;
  }
  const local = horarioNoFuso(instante, fuso);
  if (local.data !== data || local.hora !== hora)
    throw new Error("horario_inexistente_no_fuso");
  return instante;
}
export function cicloPadrao(tipo: TipoEscala): DiaEscala[] {
  const folga: DiaEscala = { tipo: "FOLGA" };
  if (tipo === "12X36")
    return [
      { tipo: "TRABALHO", entrada: "08:00", saida: "20:00", intervalo_min: 60 },
      folga,
    ];
  if (tipo === "6X1")
    return [
      ...Array.from(
        { length: 6 },
        (): DiaEscala => ({
          tipo: "TRABALHO",
          entrada: "08:00",
          saida: "16:20",
          intervalo_min: 60,
        }),
      ),
      folga,
    ];
  if (tipo === "5X2")
    return [
      ...Array.from(
        { length: 5 },
        (): DiaEscala => ({
          tipo: "TRABALHO",
          entrada: "08:00",
          saida: "17:48",
          intervalo_min: 60,
        }),
      ),
      folga,
      folga,
    ];
  if (tipo === "SOBREAVISO")
    return [
      {
        tipo: "SOBREAVISO",
        entrada: "18:00",
        saida: "08:00",
        intervalo_min: 0,
      },
      folga,
    ];
  return [
    { tipo: "TRABALHO", entrada: "06:00", saida: "14:00", intervalo_min: 60 },
    { tipo: "TRABALHO", entrada: "14:00", saida: "22:00", intervalo_min: 60 },
    { tipo: "TRABALHO", entrada: "22:00", saida: "06:00", intervalo_min: 60 },
    folga,
  ];
}
export function validarCiclo(ciclo: unknown): DiaEscala[] {
  if (!Array.isArray(ciclo) || !ciclo.length || ciclo.length > 62)
    throw new Error("ciclo_invalido");
  return ciclo.map((d) => {
    if (!d || !["TRABALHO", "FOLGA", "SOBREAVISO"].includes(d.tipo))
      throw new Error("tipo_dia_invalido");
    if (d.tipo === "FOLGA") return { tipo: "FOLGA" };
    if (
      !horaValida(d.entrada) ||
      !horaValida(d.saida) ||
      !Number.isInteger(d.intervalo_min) ||
      d.intervalo_min < 0 ||
      d.intervalo_min > 240
    )
      throw new Error("horarios_escala_invalidos");
    const duracao =
      (minutosHora(d.saida) - minutosHora(d.entrada) + 1440) % 1440;
    if (!duracao || d.intervalo_min >= duracao)
      throw new Error("duracao_escala_invalida");
    return {
      tipo: d.tipo,
      entrada: d.entrada,
      saida: d.saida,
      intervalo_min: d.intervalo_min,
    };
  });
}

export function validarModeloEscala(
  tipo: TipoEscala,
  ciclo: DiaEscala[],
): void {
  if (
    tipo === "12X36" &&
    (ciclo.length !== 2 ||
      ciclo[0]?.tipo !== "TRABALHO" ||
      ciclo[1]?.tipo !== "FOLGA" ||
      (minutosHora(ciclo[0].saida!) - minutosHora(ciclo[0].entrada!) + 1440) %
        1440 !==
        720)
  )
    throw new Error("modelo_12x36_exige_12_horas_e_36_de_descanso");
  if (
    (tipo === "6X1" || tipo === "5X2") &&
    (ciclo.length !== 7 ||
      ciclo.filter((d) => d.tipo === "TRABALHO").length !==
        (tipo === "6X1" ? 6 : 5) ||
      ciclo.filter((d) => d.tipo === "FOLGA").length !==
        (tipo === "6X1" ? 1 : 2))
  )
    throw new Error("quantidade_de_dias_incompativel_com_modelo");
  if (tipo === "SOBREAVISO" && !ciclo.some((d) => d.tipo === "SOBREAVISO"))
    throw new Error("ciclo_precisa_conter_sobreaviso");
}

export function escalaDoDia(
  data: string,
  base: string,
  ciclo: DiaEscala[],
): DiaEscala {
  const delta = Math.round(
    (Date.parse(`${data}T12:00:00Z`) - Date.parse(`${base}T12:00:00Z`)) /
      86400_000,
  );
  return ciclo[((delta % ciclo.length) + ciclo.length) % ciclo.length]!;
}
export function validarRegras(valor: unknown): RegrasPonto {
  if (!valor || typeof valor !== "object") throw new Error("regras_invalidas");
  const r = valor as RegrasPonto;
  for (const [campo, maximo] of Object.entries({
    tolerancia_atraso_min: 60,
    pausa_apos_min: 720,
    intervalo_longo_min: 240,
    intervalo_curto_min: 120,
    hora_noturna_min: 60,
    adicional_noturno_percentual: 300,
    sobreaviso_fator: 1,
    banco_validade_meses: 12,
    dsr_noturno_percentual: 100,
    extra_util_percentual: 300,
    extra_domingo_feriado_percentual: 300,
    dsr_extras_percentual: 100,
    banco_fator_util: 5,
    banco_fator_domingo_feriado: 5,
    carga_semanal_limite_min: 5040,
    antecedencia_escala_dias: 90,
  })) {
    const n = r[campo as keyof RegrasPonto];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > maximo)
      throw new Error(`regra_invalida:${campo}`);
  }
  if (
    r.hora_noturna_min <= 0 ||
    !horaValida(r.noturno_inicio) ||
    !horaValida(r.noturno_fim) ||
    r.noturno_inicio === r.noturno_fim ||
    typeof r.banco_horas !== "boolean" ||
    typeof r.prorrogacao_noturna !== "boolean" ||
    typeof r.fechamento_automatico !== "boolean" ||
    typeof r.intervalo_curto_remunerado !== "boolean" ||
    typeof r.sobreaviso_validado !== "boolean" ||
    typeof r.ufs_abrangencia !== "string" ||
    (r.ufs_abrangencia !== "" &&
      !/^[A-Z]{2}(,[A-Z]{2})*$/.test(r.ufs_abrangencia))
  )
    throw new Error("regras_invalidas");
  return r;
}
export type LinhaPonto = {
  id?: string;
  data_entrada: string;
  entrada_hora?: string | null;
  inicio_almoco?: string | null;
  fim_almoco?: string | null;
  saida_hora?: string | null;
};
export type AbonoPonto = { tipo: string; minutos: number };
export type MarcacaoPonto = { tipo: string; registrado_em: string };
const campos = [
  "entrada_hora",
  "inicio_almoco",
  "fim_almoco",
  "saida_hora",
] as const;
export function instantesLinha(
  linha: LinhaPonto,
  fuso: string,
  marcacoes: MarcacaoPonto[] = [],
) {
  const tipos = ["ENTRADA", "INICIO_INTERVALO", "FIM_INTERVALO", "SAIDA"];
  let anterior = -Infinity;
  let data = linha.data_entrada;
  return campos.map((campo, i) => {
    const hora = linha[campo];
    if (!hora) return null;
    const evento = marcacoes.find((m) => m.tipo === tipos[i]);
    let instante = evento
      ? Date.parse(evento.registrado_em)
      : instanteLocal(data, hora, fuso);
    // Marcações antigas só têm HH:mm. A ordem define a virada de dia; novos registros usam UTC imutável.
    if (!evento && instante < anterior) {
      data = somarDias(data, 1);
      instante = instanteLocal(data, hora, fuso);
    }
    if (
      !Number.isFinite(instante) ||
      instante < anterior ||
      (i > 0 && instante - anterior > 36 * 3600_000)
    )
      throw new Error("sequencia_de_horarios_invalida");
    anterior = instante;
    return instante;
  });
}
function sobreposicao(a: number, b: number, c: number, d: number) {
  return Math.max(0, Math.min(b, d) - Math.max(a, c)) / 60000;
}
export function calcularDiaPonto(
  data: string,
  linha: LinhaPonto | null,
  escala: DiaEscala | null,
  regras: RegrasPonto | null,
  fuso: string,
  abonos: AbonoPonto[] = [],
  marcacoes: MarcacaoPonto[] = [],
  agora = Date.now(),
  feriados: string[] = [],
) {
  const alertas: string[] = [];
  const referencia = regras || REGRAS_REFERENCIA;
  const [entrada, pausa, retorno, saida] = linha
    ? instantesLinha(linha, fuso, marcacoes)
    : [null, null, null, null];
  let previstaEntrada: number | null = null;
  let previstaSaida: number | null = null;
  if (escala?.entrada && escala.saida) {
    previstaEntrada = instanteLocal(data, escala.entrada, fuso);
    previstaSaida = instanteLocal(
      minutosHora(escala.saida) <= minutosHora(escala.entrada)
        ? somarDias(data, 1)
        : data,
      escala.saida,
      fuso,
    );
  }
  const pausaRemunerada =
    referencia.intervalo_curto_remunerado &&
    previstaEntrada !== null &&
    previstaSaida !== null &&
    (previstaSaida - previstaEntrada) / 60000 > 240 &&
    (previstaSaida - previstaEntrada) / 60000 < 360;
  const previstos =
    escala?.tipo === "TRABALHO" &&
    previstaEntrada !== null &&
    previstaSaida !== null
      ? (previstaSaida - previstaEntrada) / 60000 -
        (pausaRemunerada ? 0 : escala.intervalo_min || 0)
      : 0;
  const fim =
    saida ??
    (entrada !== null ? Math.min(agora, entrada + 36 * 3600_000) : null);
  const trechos: [number, number][] = [];
  if (entrada !== null && fim !== null && fim >= entrada) {
    if (pausa !== null) {
      trechos.push([entrada, pausa]);
      if (retorno !== null) trechos.push([retorno, fim]);
    } else trechos.push([entrada, fim]);
  }
  const intervalo =
    pausa !== null && retorno !== null ? (retorno - pausa) / 60000 : 0;
  if (pausaRemunerada && pausa !== null && retorno !== null)
    trechos.push([
      pausa,
      Math.min(retorno, pausa + referencia.intervalo_curto_min * 60000),
    ]);
  trechos.sort((a, b) => a[0] - b[0]);
  const trabalhados = trechos.reduce(
    (s, [a, b]) => s + Math.max(0, b - a) / 60000,
    0,
  );
  const aprovado = (tipo: string) =>
    abonos
      .filter((x) => x.tipo === tipo)
      .reduce((s, x) => s + Math.max(0, x.minutos), 0);
  const abonados = Math.min(
    Math.max(0, previstos - trabalhados),
    aprovado("ATESTADO") + aprovado("DISPENSA"),
  );
  const extras = Math.max(0, trabalhados - previstos);
  const extrasAprovadas = Math.min(extras, aprovado("HORA_EXTRA"));
  const deficitBruto = Math.max(0, previstos - trabalhados - abonados);
  const compensados = Math.min(deficitBruto, aprovado("COMPENSACAO"));
  const deficit = deficitBruto - compensados;
  if (!regras) alertas.push("REGRA_PENDENTE");
  if (!escala) alertas.push("ESCALA_PENDENTE");
  if (
    previstaEntrada !== null &&
    escala?.tipo === "TRABALHO" &&
    (entrada ?? agora) >
      previstaEntrada + referencia.tolerancia_atraso_min * 60000 &&
    abonados < previstos
  )
    alertas.push(entrada === null ? "AUSENCIA" : "ATRASO");
  if (
    entrada !== null &&
    saida === null &&
    pausa === null &&
    trabalhados > referencia.pausa_apos_min
  )
    alertas.push("PAUSA_NAO_REGISTRADA");
  if (
    entrada !== null &&
    saida === null &&
    previstaSaida !== null &&
    agora >= previstaSaida
  )
    alertas.push("HORA_EXTRA_INICIANDO");
  if (
    linha &&
    (entrada === null || saida === null || (pausa !== null && retorno === null))
  )
    alertas.push("MARCACAO_INCOMPLETA");
  const pausaDevida =
    trabalhados > 360
      ? referencia.intervalo_longo_min
      : trabalhados > 240 && !pausaRemunerada
        ? referencia.intervalo_curto_min
        : 0;
  if (saida !== null && intervalo < pausaDevida)
    alertas.push("INTERVALO_INSUFICIENTE");
  if (extras > extrasAprovadas + 0.01) alertas.push("HORA_EXTRA_PENDENTE");
  let noturnos = 0;
  for (let dia = -1; dia <= 1; dia++) {
    const inicioDia = somarDias(data, dia);
    const ini = instanteLocal(inicioDia, referencia.noturno_inicio, fuso);
    const fimDia =
      minutosHora(referencia.noturno_fim) <=
      minutosHora(referencia.noturno_inicio)
        ? somarDias(inicioDia, 1)
        : inicioDia;
    let fimNoturno = instanteLocal(fimDia, referencia.noturno_fim, fuso);
    if (
      referencia.prorrogacao_noturna &&
      entrada !== null &&
      entrada <= ini &&
      saida !== null &&
      saida > fimNoturno
    )
      fimNoturno = saida;
    noturnos += trechos.reduce(
      (s, [a, b]) => s + sobreposicao(a, b, ini, fimNoturno),
      0,
    );
  }
  let sobreaviso = 0;
  if (
    escala?.tipo === "SOBREAVISO" &&
    previstaEntrada !== null &&
    previstaSaida !== null
  )
    sobreaviso = Math.max(
      0,
      (previstaSaida - previstaEntrada) / 60000 -
        trechos.reduce(
          (s, [a, b]) =>
            s + sobreposicao(a, b, previstaEntrada!, previstaSaida!),
          0,
        ),
    );
  if (sobreaviso > 0 && !regras?.sobreaviso_validado)
    alertas.push("SOBREAVISO_A_VALIDAR");
  let utilizados = 0;
  let autorizados = extrasAprovadas;
  let creditos = 0;
  let extrasEquivalentes = 0;
  for (const [a, b] of trechos) {
    const duracao = (b - a) / 60000;
    const dentroPrevisto = Math.min(
      duracao,
      Math.max(0, previstos - utilizados),
    );
    utilizados += duracao;
    let inicioExtra = a + dentroPrevisto * 60000;
    const minutosAutorizados = Math.min(
      autorizados,
      Math.max(0, (b - inicioExtra) / 60000),
    );
    const fimExtra = inicioExtra + minutosAutorizados * 60000;
    autorizados -= minutosAutorizados;
    while (inicioExtra < fimExtra) {
      const dia = horarioNoFuso(inicioExtra, fuso).data;
      const fimDia = instanteLocal(somarDias(dia, 1), "00:00", fuso);
      const fimTrecho = Math.min(fimExtra, fimDia);
      const domingoOuFeriado =
        new Date(`${dia}T12:00:00Z`).getUTCDay() === 0 ||
        feriados.includes(dia);
      const minutos = (fimTrecho - inicioExtra) / 60000;
      creditos +=
        minutos *
        (domingoOuFeriado
          ? referencia.banco_fator_domingo_feriado
          : referencia.banco_fator_util);
      extrasEquivalentes +=
        minutos *
        (1 +
          (domingoOuFeriado
            ? referencia.extra_domingo_feriado_percentual
            : referencia.extra_util_percentual) /
            100) *
        (1 + referencia.dsr_extras_percentual / 100);
      inicioExtra = fimTrecho;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    data,
    previstos_min: round(previstos),
    trabalhados_min: round(trabalhados),
    intervalo_min: round(intervalo),
    abonados_min: round(abonados),
    deficit_min: round(deficit),
    compensados_min: round(compensados),
    extras_min: round(extras),
    extras_aprovadas_min: round(extrasAprovadas),
    extras_pendentes_min: round(extras - extrasAprovadas),
    noturnos_reais_min: regras ? round(noturnos) : null,
    noturnos_reduzidos_min: regras
      ? round((noturnos * 60) / regras.hora_noturna_min)
      : null,
    adicional_noturno_percentual: regras?.adicional_noturno_percentual ?? null,
    adicional_noturno_com_dsr_percentual: regras
      ? round(
          regras.adicional_noturno_percentual *
            (1 + regras.dsr_noturno_percentual / 100),
        )
      : null,
    extras_equivalentes_min: regras ? round(extrasEquivalentes) : null,
    sobreaviso_min: round(sobreaviso),
    sobreaviso_equivalente_min: regras?.sobreaviso_validado
      ? round(sobreaviso * regras.sobreaviso_fator)
      : null,
    credito_banco_min: regras?.banco_horas ? round(creditos) : 0,
    debito_banco_min: regras?.banco_horas ? round(compensados) : 0,
    banco_min: regras?.banco_horas ? round(creditos - compensados) : 0,
    encerrado: saida !== null,
    alertas,
    escala,
  };
}
