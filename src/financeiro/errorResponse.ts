import { FinanceError } from './FinanceiroKernel'

export function errorResponse(c: any, error: unknown) {
  if (error instanceof FinanceError) {
    return c.json({ error: error.message, code: error.code }, error.status)
  }

  console.error(
    '[financeiro]',
    error instanceof Error ? error.message : String(error),
    error,
  )
  return c.json({ error: 'falha_ao_processar_financeiro', code: 'erro_interno' }, 500)
}