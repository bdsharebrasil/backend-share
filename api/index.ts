import dotenv from 'dotenv';

// Carrega variáveis de ambiente de .env em desenvolvimento
dotenv.config();

import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import apiRouter from './routes';
import { globalCache } from './lib/cache';

const app: Application = express();

// No Vercel, a função já é exposta sob o path `/api`, então removemos o prefixo interno.
// Quando em ambiente local (dev), mantemos o prefixo `/api` para compatibilidade com docs.
const base = process.env.VERCEL ? '' : '/api';

// Middleware
const frontendUrls = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const corsOrigins = [
  'http://localhost:5173',
  'http://localhost:8080',
  'http://localhost:3000',
  // URLs definidas via FRONTEND_URL (pode ser múltiplas, separadas por vírgula)
  ...frontendUrls,
  // Em produção no Vercel, permite requests da mesma origem
  process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : ''
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permite requests sem origem (same-origin)
    if (!origin) {
      return callback(null, true);
    }

    // Verifica se a origem está na lista de origens permitidas
    if (corsOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Permite qualquer domínio fly.dev em desenvolvimento/staging
    if (origin.includes('fly.dev')) {
      return callback(null, true);
    }

    // Rejeita outras origens em produção
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());

// Permissions Policy middleware - Allow geolocation
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Permissions-Policy', 'geolocation=*');
  res.setHeader('Feature-Policy', 'geolocation *');
  next();
});

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const originalJson = (res as any).json;

  (res as any).json = function (data: any) {
    const duration = Date.now() - start;
    const cacheStatus = res.get('X-Cache') || 'MISS';

    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${cacheStatus} - ${duration}ms`
    );

    return originalJson.call(this, data);
  };

  next();
});

// Health check
app.get(`${base}/health`, (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cacheSize: globalCache.size(),
    uptime: process.uptime()
  });
});

// Debug endpoint
app.get(`${base}/debug/cors`, (req: Request, res: Response) => {
  const origin = req.get('origin');
  res.json({
    requestOrigin: origin,
    corsAllowed: true,
    serverTime: new Date().toISOString(),
    message: 'CORS debugging endpoint'
  });
});

// Cache stats endpoint
app.get(`${base}/cache/stats`, (req: Request, res: Response) => {
  res.json({
    size: globalCache.size(),
    maxSize: 500,
    timestamp: new Date().toISOString()
  });
});

// Clear cache endpoint (admin only - should be protected in production)
app.post(`${base}/cache/clear`, (req: Request, res: Response) => {
  const { pattern } = req.body;
  
  if (pattern) {
    globalCache.delete(pattern);
    res.json({ message: `Cache cleared for pattern: ${pattern}` });
  } else {
    globalCache.clear();
    res.json({ message: 'All cache cleared' });
  }
});

// API Routes (consolidated)
app.use(base, apiRouter);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Export for Vercel serverless
export default app;
