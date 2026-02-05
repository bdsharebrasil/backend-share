export declare const supabase: import("@supabase/supabase-js").SupabaseClient<any, "public", "public", any, any>;
export declare function query<T>(table: string, filter?: {
    column: string;
    value: any;
    operator?: string;
}): Promise<T[]>;
export declare function queryWithJoin<T>(table: string, select?: string): Promise<T[]>;
//# sourceMappingURL=supabase.d.ts.map