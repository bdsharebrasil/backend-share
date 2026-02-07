import dotenv from 'dotenv';

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

export async function query<T>(
  table: string,
  filter?: { column: string; value: any; operator?: string }
): Promise<T[]> {
  let query = supabase.from(table).select('*');

  if (filter) {
    const operator = filter.operator || 'eq';
    query = (query as any)[operator](filter.column, filter.value) as any;
  }

  const { data, error } = await query;

  if (error) {
    console.error(`Error querying ${table}:`, error);
    throw error;
  }

  return data as T[];
}

export async function queryWithJoin<T>(
  table: string,
  select: string = '*'
): Promise<T[]> {
  const { data, error } = await supabase.from(table).select(select);

  if (error) {
    console.error(`Error querying ${table}:`, error);
    throw error;
  }

  return data as T[];
}
