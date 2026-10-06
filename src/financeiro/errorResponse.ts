import { FinanceError } from './FinanceiroKernel'
import { createLogger } from '../lib/logger'

export function errorResponse(c: any, error: unknown) {
  if (error instanceof FinanceError) {
    return c.json({ error: error.message, code: error.code }, error.status)
  }

  createLogger(c.get?.('requestId') || null).error('financeiro.request_error', error)
  return c.json({ error: 'falha_ao_processar_financeiro', code: 'erro_interno' }, 500)
}
