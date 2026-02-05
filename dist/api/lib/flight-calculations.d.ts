/**
 * Calcula distância entre dois pontos usando a fórmula de Haversine
 * @param lat1 Latitude do ponto 1
 * @param lon1 Longitude do ponto 1
 * @param lat2 Latitude do ponto 2
 * @param lon2 Longitude do ponto 2
 * @returns Distância em milhas náuticas (NM)
 */
export declare function calculateDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number;
/**
 * Calcula tempo noturno baseado na hora do pôr do sol (ANAC)
 * Regra ANAC: Noturno é o tempo entre o final do crepúsculo civil (dusk) e o início (dawn)
 * @param flightDate Data do voo (YYYY-MM-DD)
 * @param landingTime Hora de pouso (HH:MM)
 * @param latitude Latitude do destino
 * @param longitude Longitude do destino
 * @returns Tempo noturno em horas (decimal)
 */
export declare function calculateNightTime(flightDate: string, landingTime: string, latitude: number, longitude: number): number;
/**
 * Calcula horas solares para o destino
 * @param flightDate Data do voo
 * @param latitude Latitude
 * @param longitude Longitude
 * @returns Objeto com horários de sunrise, sunset, dusk, dawn
 */
export declare function getSolarTimes(flightDate: string, latitude: number, longitude: number): {
    sunrise: any;
    sunriseMinutes: any;
    sunset: any;
    sunsetMinutes: any;
    dawn: any;
    dawnMinutes: any;
    dusk: any;
    duskMinutes: any;
};
/**
 * Converte string DMS (Graus, Minutos, Segundos) para decimal
 * Formato esperado: "23°30'15.5\"S,45°15'30.2\"W"
 * @param dmsString String em formato DMS
 * @returns Objeto com latitude e longitude em decimal
 */
export declare function parseDMSCoordinate(dmsString: string): {
    lat: number;
    lng: number;
} | null;
/**
 * Calcula os cálculos finais do trecho
 * Integra distância, tempo noturno e métricas solares
 */
export interface FlightCalculationInput {
    departureIcao: string;
    departureCoords?: {
        lat: number;
        lng: number;
    };
    arrivalIcao?: string;
    arrivalCoords?: {
        lat: number;
        lng: number;
    };
    flightDate: string;
    landingTime: string;
}
export interface FlightCalculationResult {
    distanceNM: number;
    nightTime: number;
    solarTimes: ReturnType<typeof getSolarTimes>;
    isNightFlightAtLanding: boolean;
}
/**
 * Processa cálculo completo do trecho
 */
export declare function calculateFlightMetrics(distanceLat1: number, distanceLon1: number, distanceLat2: number, distanceLon2: number, flightDate: string, landingTime: string): FlightCalculationResult;
//# sourceMappingURL=flight-calculations.d.ts.map