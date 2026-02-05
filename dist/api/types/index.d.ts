export interface User {
    id: string;
    email: string;
    full_name: string;
    role: 'admin' | 'manager' | 'pilot' | 'crew' | 'client';
    avatar_url?: string;
    created_at: string;
    updated_at: string;
}
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
export interface ApiResponse<T> {
    data: T;
    timestamp: string;
    cached?: boolean;
    realtime?: boolean;
}
export interface ApiError {
    error: string;
    message?: string;
}
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
    maintenance?: MaintenanceLog[];
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
    date: string;
    description: string;
    duration_hours: number;
    status: 'scheduled' | 'in_progress' | 'completed';
    created_at: string;
}
export interface CacheStats {
    size: number;
    maxSize: number;
    timestamp: string;
}
//# sourceMappingURL=index.d.ts.map