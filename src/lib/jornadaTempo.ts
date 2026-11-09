export function numeroMinutos(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '' || (typeof valor !== 'number' && typeof valor !== 'string')) return null;
  if (typeof valor === 'string' && !valor.trim()) return null;
  const numero = Number(valor);
  return Number.isFinite(numero) && numero >= 0 ? numero : null;
}
export function limiteDiarioConfigurado(valorRegistro: unknown, valorAmbiente?: unknown): number {
  for (const valor of [valorRegistro, valorAmbiente]) {
    const minutos = numeroMinutos(valor)
    if (minutos !== null && Number.isInteger(minutos) && minutos > 0 && minutos <= 1440) return minutos
  }
  return 540
}
export function instanteUtc(valor: unknown): number | null {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/i.test(texto)) return null;
  const ano = Number(texto.slice(0, 4)); const mes = Number(texto.slice(5, 7)); const dia = Number(texto.slice(8, 10));
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
  const diasMes = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasMes[mes - 1] || Number(texto.slice(11, 13)) > 23 || Number(texto.slice(14, 16)) > 59) return null;
  // O contrato operacional destes campos é UTC. SQLite pode devolver sem o Z.
  const normalizado = texto.replace(' ', 'T');
  const comFuso = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalizado) ? normalizado : `${normalizado}Z`;
  const valorMs = Date.parse(comFuso);
  return Number.isFinite(valorMs) ? valorMs : null;
}
