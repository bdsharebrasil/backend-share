import { Request, RequestHandler } from 'express';
export interface CacheOptions {
    ttl?: number;
    key?: string | ((req: Request) => string);
}
export declare function cacheMiddleware(options?: CacheOptions): RequestHandler;
export declare function clearCache(pattern?: string): void;
//# sourceMappingURL=cacheMiddleware.d.ts.map