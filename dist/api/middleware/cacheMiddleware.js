import { globalCache } from '../lib/cache';
export function cacheMiddleware(options = {}) {
    return (req, res, next) => {
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
        res.json = function (data) {
            globalCache.set(cacheKey, data, options.ttl);
            return originalJson.call(this, data);
        };
        next();
    };
}
export function clearCache(pattern) {
    if (!pattern) {
        globalCache.clear();
        return;
    }
    const keys = Array.from(globalCache.cache.keys());
    keys.forEach((key) => {
        if (key.includes(pattern)) {
            globalCache.delete(key);
        }
    });
}
//# sourceMappingURL=cacheMiddleware.js.map