export declare class LRUCache<T = any> {
    private cache;
    private maxSize;
    private defaultTTL;
    constructor(maxSize?: number, defaultTTL?: number);
    set(key: string, data: T, ttl?: number): void;
    get(key: string): T | null;
    has(key: string): boolean;
    clear(): void;
    delete(key: string): void;
    size(): number;
}
export declare const globalCache: LRUCache<any>;
//# sourceMappingURL=cache.d.ts.map