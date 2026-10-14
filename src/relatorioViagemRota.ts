export type PernaRotaRelatorio = {
  numero: number;
  destino: string | null;
  jornada_numero: number;
};

export function sequenciaRotaRelatorio(
  origem: string | null | undefined,
  destino: string | null | undefined,
  pernas: PernaRotaRelatorio[],
): string[] {
  const ordenadas = [...pernas].sort(
    (a, b) => a.jornada_numero - b.jornada_numero || a.numero - b.numero,
  );
  const sequencia = [origem, destino, ...ordenadas.map((perna) => perna.destino)]
    .map((codigo) => codigo?.trim().toUpperCase())
    .filter((codigo): codigo is string => Boolean(codigo));
  const semRepetidos = sequencia.filter(
    (codigo, indice) => indice === 0 || codigo !== sequencia[indice - 1],
  );

  if (semRepetidos.length > 1 && semRepetidos[semRepetidos.length - 1] === semRepetidos[0]) {
    semRepetidos.pop();
  }

  return semRepetidos;
}

export function nomearRotaRelatorio(
  icaos: string[],
  nomesPorIcao: ReadonlyMap<string, string>,
): string {
  return icaos.map((icao) => nomesPorIcao.get(icao) || icao).join(' - ');
}
