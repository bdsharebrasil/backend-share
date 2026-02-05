export interface RouteConfig {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    description: string;
    cache: {
        enabled: boolean;
        ttl?: number;
        strategy: 'realtime' | 'short' | 'medium' | 'long' | 'veryLong';
    };
    queryParams?: string[];
}
export declare const CACHE_STRATEGIES: {
    realtime: {
        ttl: number;
        label: string;
    };
    short: {
        ttl: number;
        label: string;
    };
    medium: {
        ttl: number;
        label: string;
    };
    long: {
        ttl: number;
        label: string;
    };
    veryLong: {
        ttl: number;
        label: string;
    };
};
export declare const ROUTES_CONFIG: RouteConfig[];
export declare function getRouteConfig(path: string, method: string): RouteConfig | undefined;
//# sourceMappingURL=routes.d.ts.map