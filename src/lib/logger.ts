type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogArgument = unknown

function serializable(value: LogArgument): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (typeof value === 'bigint') return value.toString()
  return value
}

function emit(level: LogLevel, requestId: string | null, event: string, args: LogArgument[]): void {
  const payload = {
    level,
    request_id: requestId,
    event,
    ...(args.length ? { data: args.map(serializable) } : {}),
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else if (level === 'info') console.info(line)
  else console.debug(line)
}

export type StructuredLogger = {
  debug(event: string, ...args: LogArgument[]): void
  info(event: string, ...args: LogArgument[]): void
  warn(event: string, ...args: LogArgument[]): void
  error(event: string, ...args: LogArgument[]): void
}

export function createLogger(requestId: string | null = null): StructuredLogger {
  return {
    debug: (event, ...args) => emit('debug', requestId, event, args),
    info: (event, ...args) => emit('info', requestId, event, args),
    warn: (event, ...args) => emit('warn', requestId, event, args),
    error: (event, ...args) => emit('error', requestId, event, args),
  }
}
