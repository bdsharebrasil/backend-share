export class LRUCache {
    constructor(maxSize = 100, defaultTTL = 5 * 60 * 1000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.defaultTTL = defaultTTL;
    }
    set(key, data, ttl) {
        const entryTTL = ttl ?? this.defaultTTL;
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            ttl: entryTTL,
        });
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return null;
        }
        const isExpired = Date.now() - entry.timestamp > entry.ttl;
        if (isExpired) {
            this.cache.delete(key);
            return null;
        }
        // Move to end (LRU)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.data;
    }
    has(key) {
        return this.get(key) !== null;
    }
    clear() {
        this.cache.clear();
    }
    delete(key) {
        this.cache.delete(key);
    }
    size() {
        return this.cache.size;
    }
}
export const globalCache = new LRUCache(500, 10 * 60 * 1000); // 500 entries, 10 min TTL by default
//# sourceMappingURL=cache.js.map