export interface RouteConfig {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description: string;
  cache: {
    enabled: boolean;
    ttl?: number; // em ms
    strategy: 'realtime' | 'short' | 'medium' | 'long' | 'veryLong';
  };
  queryParams?: string[];
}

export const CACHE_STRATEGIES = {
  realtime: { ttl: 0, label: 'Real-time' },
  short: { ttl: 2 * 60 * 1000, label: '2 minutos' },
  medium: { ttl: 10 * 60 * 1000, label: '10 minutos' },
  long: { ttl: 15 * 60 * 1000, label: '15 minutos' },
  veryLong: { ttl: 24 * 60 * 60 * 1000, label: '1 dia' },
};

export const ROUTES_CONFIG: RouteConfig[] = [
  // Users
  {
    path: '/api/users',
    method: 'GET',
    description: 'Listar todos os usuários',
    cache: { enabled: true, ttl: 10 * 60 * 1000, strategy: 'medium' },
  },
  {
    path: '/api/users/:id',
    method: 'GET',
    description: 'Obter usuário específico',
    cache: { enabled: true, ttl: 10 * 60 * 1000, strategy: 'medium' },
  },
  {
    path: '/api/users/:id/profile',
    method: 'GET',
    description: 'Obter perfil do usuário com dados relacionados',
    cache: { enabled: true, ttl: 10 * 60 * 1000, strategy: 'medium' },
  },

  // Flights
  {
    path: '/api/flights',
    method: 'GET',
    description: 'Listar voos com filtros',
    cache: { enabled: false, strategy: 'realtime' },
    queryParams: ['status', 'date', 'aircraft_id'],
  },
  {
    path: '/api/flights/:id',
    method: 'GET',
    description: 'Obter detalhes do voo',
    cache: { enabled: true, ttl: 2 * 60 * 1000, strategy: 'short' },
  },
  {
    path: '/api/flights/active/now',
    method: 'GET',
    description: 'Obter voos em andamento',
    cache: { enabled: false, strategy: 'realtime' },
  },

  // Clients
  {
    path: '/api/clients',
    method: 'GET',
    description: 'Listar todos os clientes',
    cache: { enabled: true, ttl: 15 * 60 * 1000, strategy: 'long' },
  },
  {
    path: '/api/clients/:id',
    method: 'GET',
    description: 'Obter cliente com resumo de voos e despesas',
    cache: { enabled: true, ttl: 15 * 60 * 1000, strategy: 'long' },
  },
  {
    path: '/api/clients/:id/contracts',
    method: 'GET',
    description: 'Obter contratos do cliente',
    cache: { enabled: true, ttl: 24 * 60 * 60 * 1000, strategy: 'veryLong' },
  },

  // Aircraft
  {
    path: '/api/aircraft',
    method: 'GET',
    description: 'Listar todas as aeronaves',
    cache: { enabled: true, ttl: 20 * 60 * 1000, strategy: 'long' },
  },
  {
    path: '/api/aircraft/:id',
    method: 'GET',
    description: 'Obter detalhes da aeronave com manutenção',
    cache: { enabled: true, ttl: 10 * 60 * 1000, strategy: 'medium' },
  },
  {
    path: '/api/aircraft/:id/availability',
    method: 'GET',
    description: 'Obter disponibilidade da aeronave',
    cache: { enabled: true, ttl: 5 * 60 * 1000, strategy: 'short' },
  },

  // Aerodromes
  {
    path: '/api/aerodromes',
    method: 'GET',
    description: 'Listar todos os aeródromos',
    cache: { enabled: true, ttl: 24 * 60 * 60 * 1000, strategy: 'veryLong' },
  },

  // Categories
  {
    path: '/api/categories',
    method: 'GET',
    description: 'Listar todas as categorias financeiras',
    cache: { enabled: true, ttl: 12 * 60 * 60 * 1000, strategy: 'long' },
  },
  {
    path: '/api/categories/unique-by-type',
    method: 'GET',
    description: 'Listar categorias únicas agrupadas por tipo',
    cache: { enabled: true, ttl: 12 * 60 * 60 * 1000, strategy: 'long' },
  },

  // Cache Management
  {
    path: '/api/cache/stats',
    method: 'GET',
    description: 'Obter estatísticas do cache',
    cache: { enabled: false, strategy: 'realtime' },
  },
  {
    path: '/api/cache/clear',
    method: 'POST',
    description: 'Limpar cache',
    cache: { enabled: false, strategy: 'realtime' },
  },
];

export function getRouteConfig(path: string, method: string): RouteConfig | undefined {
  return ROUTES_CONFIG.find(
    (route) =>
      route.method === method &&
      route.path.replace(/:[^/]+/g, ':id').includes(path.replace(/\/[^/]+\/?$/g, ':id'))
  );
}
