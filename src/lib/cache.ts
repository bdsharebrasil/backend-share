type CacheContext = {
  env: {
    CACHE_KV: KVNamespace
    RATE_LIMITER: DurableObjectNamespace
  }
  executionCtx: {
    waitUntil(promise: Promise<unknown>): void
  }
  req: {
    header(name: string): string | undefined
  }
}

const log = {
  debug: (...args: unknown[]) => console.debug(...args),
  error: (...args: unknown[]) => console.error(...args),
}

export async function checkRateLimit(c: CacheContext, bucket: string, perMinute: number): Promise<boolean> {
  const minuteWindow = Math.floor(Date.now() / 60_000)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bucket))
  const name = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const id = c.env.RATE_LIMITER.idFromName(name)
  const response = await c.env.RATE_LIMITER.get(id).fetch('https://rate-limiter/increment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minuteWindow, perMinute }),
  })
  if (!response.ok) throw new Error(`rate_limit_unavailable:${response.status}`)
  return (await response.json<{ allowed: boolean }>()).allowed
}

export function clientIp(c: Pick<CacheContext, 'req'>): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
}

export async function cachedFetch(
  c: CacheContext,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<any>,
): Promise<any> {
  const kv = c.env.CACHE_KV
  const raw = await kv.get(key, { type: 'json' }) as any
  const now = Date.now()

  const isNewFormat = raw !== null && typeof raw === 'object' && 'fetchedAt' in raw && 'data' in raw
  const fetchedAt = isNewFormat ? (raw.fetchedAt as number) : 0
  const cachedData = isNewFormat ? raw.data : raw
  const ageSeconds = (now - fetchedAt) / 1000
  const hasCachedData = cachedData !== null && cachedData !== undefined
  const isFresh = hasCachedData && ageSeconds < ttlSeconds
  const isStale = hasCachedData && ageSeconds >= ttlSeconds

  const save = async (data: any) => {
    const payload = JSON.stringify({ data, fetchedAt: Date.now() })
    await kv.put(key, payload, { expirationTtl: ttlSeconds * 4 })
    return data
  }

  if (isFresh) {
    log.debug(`[kv] FRESH key="${key}" age=${Math.round(ageSeconds)}s`)
    return cachedData
  }

  const lockKey = `${key}:lock`

  if (isStale) {
    log.debug(`[kv] STALE key="${key}" — background refresh`)
    const locked = await kv.get(lockKey)
    if (!locked) {
      c.executionCtx.waitUntil((async () => {
        await kv.put(lockKey, '1', { expirationTtl: 60 })
        try {
          await save(await fetcher())
          log.debug(`[kv] Refresh OK key="${key}"`)
        } catch (error: any) {
          log.error(`[kv] Refresh FAIL key="${key}":`, error.message)
        } finally {
          await kv.delete(lockKey)
        }
      })())
    }
    return cachedData
  }

  log.debug(`[kv] MISS key="${key}" — buscando na DECEA`)

  let locked = await kv.get(lockKey)
  if (locked) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 700))
      const retry = await kv.get(key, { type: 'json' }) as any
      if (retry && 'data' in retry) return retry.data
      if (retry) return retry
      locked = await kv.get(lockKey)
      if (!locked) break
    }
  }

  await kv.put(lockKey, '1', { expirationTtl: 60 })
  try {
    const data = await fetcher()
    await save(data)
    return data
  } finally {
    await kv.delete(lockKey)
  }
}