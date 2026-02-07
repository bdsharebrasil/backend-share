import SunCalc from 'suncalc';

export function calculateDistanceNM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 3440.065;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 100) / 100;
}

export function calculateNightTime(
flightDate: string, landingTime: string, latitude: number, longitude: number, p0: Date, flight_duration: any): number {
  try {
    const date = new Date(`${flightDate}T00:00:00Z`);
    const times = SunCalc.getTimes(date, latitude, longitude);

    const duskMinutes = times.dusk.getUTCHours() * 60 + times.dusk.getUTCMinutes();

    const [landingHours, landingMinutes] = landingTime.split(':').map(Number);
    const landingTotalMinutes = landingHours * 60 + landingMinutes;

    if (landingTotalMinutes > duskMinutes) {
      const nightMinutes = landingTotalMinutes - duskMinutes;
      return Math.round(nightMinutes * 100) / 100 / 60;
    }

    return 0;
  } catch (error) {
    console.error('Erro ao calcular tempo noturno:', error);
    return 0;
  }
}

export function getSolarTimes(
  flightDate: string,
  latitude: number,
  longitude: number
) {
  const date = new Date(`${flightDate}T00:00:00Z`);
  const times = SunCalc.getTimes(date, latitude, longitude);

  return {
    sunrise: times.sunrise.toISOString(),
    sunriseMinutes: times.sunrise.getUTCHours() * 60 + times.sunrise.getUTCMinutes(),
    sunset: times.sunset.toISOString(),
    sunsetMinutes: times.sunset.getUTCHours() * 60 + times.sunset.getUTCMinutes(),
    dawn: times.dawn.toISOString(),
    dawnMinutes: times.dawn.getUTCHours() * 60 + times.dawn.getUTCMinutes(),
    dusk: times.dusk.toISOString(),
    duskMinutes: times.dusk.getUTCHours() * 60 + times.dusk.getUTCMinutes(),
  };
}

export function parseDMSCoordinate(dmsString: string): { lat: number; lng: number } | null {
  try {
    const [latStr, lngStr] = dmsString.split(',');

    const latMatch = latStr.match(/([\d.]+)°([\d.]+)'([\d.]+)"([NSEW])/);
    if (!latMatch) return null;

    let lat = Number(latMatch[1]) + Number(latMatch[2]) / 60 + Number(latMatch[3]) / 3600;
    if (latMatch[4] === 'S') lat = -lat;

    const lngMatch = lngStr.match(/([\d.]+)°([\d.]+)'([\d.]+)"([NSEW])/);
    if (!lngMatch) return null;

    let lng = Number(lngMatch[1]) + Number(lngMatch[2]) / 60 + Number(lngMatch[3]) / 3600;
    if (lngMatch[4] === 'W') lng = -lng;

    return { lat, lng };
  } catch (error) {
    console.error('Erro ao fazer parse de coordenadas DMS:', error);
    return null;
  }
}

export interface FlightCalculationInput {
  departureIcao: string;
  departureCoords?: { lat: number; lng: number };
  arrivalIcao?: string;
  arrivalCoords?: { lat: number; lng: number };
  flightDate: string;
  landingTime: string;
}

export interface FlightCalculationResult {
  distanceNM: number;
  nightTime: number;
  solarTimes: ReturnType<typeof getSolarTimes>;
  isNightFlightAtLanding: boolean;
}

export function calculateFlightMetrics(
  distanceLat1: number,
  distanceLon1: number,
  distanceLat2: number,
  distanceLon2: number,
  flightDate: string,
  landingTime: string,
  p0: Date,
  flight_duration: any
): FlightCalculationResult {
  const distance = calculateDistanceNM(distanceLat1, distanceLon1, distanceLat2, distanceLon2);
  const nightTime = calculateNightTime(flightDate, landingTime, distanceLat2, distanceLon2, p0, flight_duration);
  const solar = getSolarTimes(flightDate, distanceLat2, distanceLon2);

  const [landingHours, landingMinutes] = landingTime.split(':').map(Number);
  const landingTotalMinutes = landingHours * 60 + landingMinutes;

  return {
    distanceNM: distance,
    nightTime: nightTime,
    solarTimes: solar,
    isNightFlightAtLanding: landingTotalMinutes > solar.duskMinutes,
  };
}
