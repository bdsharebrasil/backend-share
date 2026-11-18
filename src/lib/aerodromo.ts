/** Designativos de aeródromo publicados podem incluir números, como SN9T. */
export function codigoAerodromoValido(valor: unknown): valor is string {
  return typeof valor === 'string' && /^[A-Z0-9]{4}$/i.test(valor.trim())
}
