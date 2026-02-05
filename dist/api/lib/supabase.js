import dotenv from 'dotenv';
// Carrega .env aqui para garantir que variáveis existam quando o módulo é importado
dotenv.config();
import { createClient } from '@supabase/supabase-js';
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY || process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase configuration missing!');
    console.error('  VITE_SUPABASE_URL:', supabaseUrl ? '✓' : '✗');
    console.error('  VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY:', supabaseKey ? '✓' : '✗');
    throw new Error('Missing Supabase environment variables');
}
console.log('✅ Supabase client initialized');
export const supabase = createClient(supabaseUrl, supabaseKey);
export async function query(table, filter) {
    let query = supabase.from(table).select('*');
    if (filter) {
        const operator = filter.operator || 'eq';
        query = query[operator](filter.column, filter.value);
    }
    const { data, error } = await query;
    if (error) {
        console.error(`Error querying ${table}:`, error);
        throw error;
    }
    return data;
}
export async function queryWithJoin(table, select = '*') {
    const { data, error } = await supabase.from(table).select(select);
    if (error) {
        console.error(`Error querying ${table}:`, error);
        throw error;
    }
    return data;
}
//# sourceMappingURL=supabase.js.map