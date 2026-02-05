import { BRAZILIAN_AIRPORTS } from '../config/airports';
import { supabase } from './supabase';

export interface AirportInfo {
  icao: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * Fetch airport coordinates by ICAO code
 * First tries local database, then Supabase
 */
export async function getAirportCoordinates(icao: string): Promise<AirportInfo | null> {
  const upperIcao = icao.toUpperCase().trim();
  
  // First: Try local database (BRAZILIAN_AIRPORTS)
  if (BRAZILIAN_AIRPORTS[upperIcao]) {
    const airport = BRAZILIAN_AIRPORTS[upperIcao];
    return {
      icao: upperIcao,
      name: airport.name,
      lat: airport.lat,
      lng: airport.lng,
    };
  }
  
  // Second: Try Supabase if not found locally
  try {
    const { data, error } = await supabase
      .from('aerodromes')
      .select('name, designativo, coordenadas')
      .eq('designativo', upperIcao)
      .single();

    if (data && data.coordenadas) {
      // Parse coordinates in format "lat,lng"
      const [lat, lng] = data.coordenadas.split(',').map((coord: string) => parseFloat(coord.trim()));
      
      if (!isNaN(lat) && !isNaN(lng)) {
        return {
          icao: upperIcao,
          name: data.name || '',
          lat,
          lng,
        };
      }
    }
  } catch (error) {
    console.warn(`Error fetching airport ${upperIcao} from Supabase:`, error);
  }
  
  return null;
}

/**
 * Batch fetch airport coordinates
 */
export async function getMultipleAirportCoordinates(icaos: string[]): Promise<Map<string, AirportInfo>> {
  const results = new Map<string, AirportInfo>();
  
  for (const icao of icaos) {
    const info = await getAirportCoordinates(icao);
    if (info) {
      results.set(icao.toUpperCase(), info);
    }
  }
  
  return results;
}

/**
 * Search airports by name or ICAO
 * First searches local database, then Supabase
 */
export async function searchAirports(query: string): Promise<AirportInfo[]> {
  const lowerQuery = query.toLowerCase();
  const results: AirportInfo[] = [];
  const seen = new Set<string>();
  
  // First: Search local database
  Object.entries(BRAZILIAN_AIRPORTS)
    .filter(([icao, airport]) => 
      icao.toLowerCase().includes(lowerQuery) ||
      airport.name.toLowerCase().includes(lowerQuery)
    )
    .forEach(([icao, airport]) => {
      results.push({
        icao,
        name: airport.name,
        lat: airport.lat,
        lng: airport.lng,
      });
      seen.add(icao);
    });
  
  // Second: Search Supabase if we need more results
  if (results.length < 10) {
    try {
      const { data, error } = await supabase
        .from('aerodromes')
        .select('name, designativo, coordenadas')
        .or(`designativo.ilike.%${query}%,name.ilike.%${query}%`)
        .limit(10 - results.length);

      if (data && !error) {
        for (const airport of data) {
          if (!seen.has(airport.designativo) && airport.coordenadas) {
            const [lat, lng] = airport.coordenadas.split(',').map((coord: string) => parseFloat(coord.trim()));
            
            if (!isNaN(lat) && !isNaN(lng)) {
              results.push({
                icao: airport.designativo,
                name: airport.name || '',
                lat,
                lng,
              });
              seen.add(airport.designativo);
            }
          }
        }
      }
    } catch (error) {
      console.warn('Error searching airports in Supabase:', error);
    }
  }
  
  return results.slice(0, 10);
}
