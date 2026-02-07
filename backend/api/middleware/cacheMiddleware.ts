import { Request, Response, NextFunction, RequestHandler } from 'express';
import { globalCache } from '../lib/cache';

export interface CacheOptions {
  ttl?: number;
  key?: string | ((req: Request) => string);
}

export function cacheMiddleware(options: CacheOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') {
      return next();
    }

    const cacheKey = typeof options.key === 'function'
      ? options.key(req)
      : options.key ?? `${req.method}:${req.originalUrl}`;

    const cachedData = globalCache.get(cacheKey);
    if (cachedData) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    res.set('X-Cache', 'MISS');

    const originalJson = res.json;
    res.json = function (data: any) {
      globalCache.set(cacheKey, data, options.ttl);
      return originalJson.call(this, data);
    };

    next();
  };
}

export function clearCache(pattern?: string): void {
  if (!pattern) {
    globalCache.clear();
    return;
  }

  const keys = Array.from((globalCache as any).cache.keys()) as string[];
  keys.forEach((key) => {
    if (key.includes(pattern)) {
      globalCache.delete(key);
    }
  });
}
