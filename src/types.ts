// User types
export interface User {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'manager' | 'pilot' | 'crew' | 'client';
  avatar_url?: string;
  created_at: string;
  updated_at: string;
}

// Aircraft types
export interface Aircraft {
  id: string;
  registration: string;
  model: string;
  manufacturer: string;
  max_range?: number;
  cruise_speed?: number;
  max_altitude?: number;
  created_at: string;
  status?: string;
  cell_hours_current?: number;
  cell_hours_before?: number;
  cell_hours_prev?: number;
  owner_name?: string;
  serial_number?: string;
  base?: string;
  year?: string;
  image_url?: string;
  fuel_consumption?: number;
  hourly_price?: string;
  horimeter_start?: number;
  horimeter_end?: number;
  horimeter_active?: number;
  updated_at?: string;
}

// Airport/Coordinates types
export interface AirportCoordinates {
  latitude: number;
  longitude: number;
  airport_code?: string;
  airport_name?: string;
  city?: string;
  country?: string;
}

export interface AirportSearchResult {
  code: string;
  name: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
}

// Flight types
export interface FlightSchedule {
  id: string;
  origin: string;
  destination: string;
  flight_date: string;
  flight_time: string;
  estimated_duration: string;
  status: 'agendado' | 'confirmado' | 'em_voo' | 'completado' | 'cancelado';
  aircraft_id: string;
  crew_member_id: string;
  client_id: string;
  created_at: string;
  updated_at: string;
}

// Client types
export interface Client {
  id: string;
  company_name: string;
  contact_person: string;
  email: string;
  phone: string;
  address?: string;
  city?: string;
  country?: string;
  created_at: string;
  updated_at: string;
}

// Flight Plan types
export interface FlightPlan {
  id: string;
  flight_schedule_id: string;
  aircraft_registration: string;
  departure_airport: string;
  destination_airport: string;
  alternate_airport?: string;
  cruise_altitude: string;
  cruise_speed: string;
  route: string;
  departure_metar: string;
  destination_metar: string;
  fuel_endurance: string;
  remarks: string;
  created_at: string;
  updated_at: string;
}

// Calculation types
export interface DistanceCalculation {
  origin: string;
  destination: string;
  distance_nm: number;
  distance_km: number;
  origin_coordinates: AirportCoordinates;
  destination_coordinates: AirportCoordinates;
}

export interface NightTimeCalculation {
  night_time_hours: number;
  departure_time: string;
  flight_duration_hours: number;
  origin: string;
  destination: string;
}

export interface SolarTimes {
  sunrise: string;
  sunset: string;
  solar_noon: string;
  civil_twilight_begin: string;
  civil_twilight_end: string;
  nautical_twilight_begin: string;
  nautical_twilight_end: string;
  astronomical_twilight_begin: string;
  astronomical_twilight_end: string;
}

export interface SolarTimesResponse {
  airport: string;
  date: string;
  sunrise: string;
  sunset: string;
  solar_noon: string;
  civil_twilight_begin: string;
  civil_twilight_end: string;
  nautical_twilight_begin: string;
  nautical_twilight_end: string;
  astronomical_twilight_begin: string;
  astronomical_twilight_end: string;
  coordinates: AirportCoordinates;
}

// API Response types
export interface ApiResponse<T> {
  data: T;
  timestamp: string;
  cached?: boolean;
  realtime?: boolean;
}

export interface ApiError {
  error: string;
  message?: string;
  details?: string;
}

// Aggregated types for complex queries
export interface FlightDetail extends FlightSchedule {
  aircraft?: Aircraft;
  crew_members?: User;
  clients?: Client;
  flight_plans?: FlightPlan[];
  weather?: WeatherData;
}

export interface ClientDetail extends Client {
  flight_schedules?: FlightSchedule[];
  totalExpenses?: number;
  flightCount?: number;
}

export interface AircraftDetail extends Aircraft {
  maintenance_records?: MaintenanceLog[];
  totalFlightHours?: number;
  flightCount?: number;
}

export interface WeatherData {
  id: string;
  flight_id: string;
  departure_metar: string;
  destination_metar: string;
  departure_taf?: string;
  destination_taf?: string;
  updated_at: string;
}

export interface MaintenanceLog {
  id: string;
  aircraft_id: string;
  maintenance_date: string;
  type: string;
  description: string;
  cost?: number;
  duration_hours?: number;
  status: 'scheduled' | 'in_progress' | 'completed';
  created_at: string;
}

export interface CrewMember {
  id: string;
  full_name: string;
  license: string;
  flight_hours?: number;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

export interface CrewLicense {
  id: string;
  crew_id: string;
  license_type: string;
  license_number: string;
  issue_date: string;
  expiry_date: string;
  created_at: string;
}

export interface CrewDetail extends CrewMember {
  crew_licenses?: CrewLicense[];
}

export interface DashboardStatistics {
  totalFlights: number;
  activeFlights: number;
  totalAircraft: number;
  totalClients: number;
  activeCrew: number;
}

export interface FlightStatistics {
  total: number;
  byStatus: Record<string, number>;
  byAircraft: Record<string, number>;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  timestamp: string;
}

// Request body types
export interface CalculateDistanceRequest {
  origin: string;
  destination: string;
}

export interface CalculateNightTimeRequest {
  origin: string;
  destination: string;
  departure_time: string;
  flight_duration: number;
}

export interface SolarTimesRequest {
  airport: string;
  date?: string;
}
