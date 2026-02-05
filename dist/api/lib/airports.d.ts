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
export declare function getAirportCoordinates(icao: string): Promise<AirportInfo | null>;
/**
 * Batch fetch airport coordinates
 */
export declare function getMultipleAirportCoordinates(icaos: string[]): Promise<Map<string, AirportInfo>>;
/**
 * Search airports by name or ICAO
 * First searches local database, then Supabase
 */
export declare function searchAirports(query: string): Promise<AirportInfo[]>;
//# sourceMappingURL=airports.d.ts.map