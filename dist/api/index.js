import dotenv from 'dotenv';
// Carrega variáveis de ambiente de .env em desenvolvimento
dotenv.config();
import express from 'express';
import cors from 'cors';
import apiRouter from './routes';
import { globalCache } from './lib/cache';
const app = express();
// No Vercel, a função já é exposta sob o path `/api`, então removemos o prefixo interno.
// Quando em ambiente local (dev), mantemos o prefixo `/api` para compatibilidade com docs.
const base = process.env.VERCEL ? '' : '/api';
// Middleware
const corsOrigins = [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:3000',
    process.env.FRONTEND_URL || '',
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
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=*');
    res.setHeader('Feature-Policy', 'geolocation *');
    next();
});
// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    const originalJson = res.json;
    res.json = function (data) {
        const duration = Date.now() - start;
        const cacheStatus = res.get('X-Cache') || 'MISS';
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${cacheStatus} - ${duration}ms`);
        return originalJson.call(this, data);
    };
    next();
});
// Health check
app.get(`${base}/health`, (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cacheSize: globalCache.size(),
        uptime: process.uptime()
    });
});
// Debug endpoint
app.get(`${base}/debug/cors`, (req, res) => {
    const origin = req.get('origin');
    res.json({
        requestOrigin: origin,
        corsAllowed: true,
        serverTime: new Date().toISOString(),
        message: 'CORS debugging endpoint'
    });
});
// Cache stats endpoint
app.get(`${base}/cache/stats`, (req, res) => {
    res.json({
        size: globalCache.size(),
        maxSize: 500,
        timestamp: new Date().toISOString()
    });
});
// Clear cache endpoint (admin only - should be protected in production)
app.post(`${base}/cache/clear`, (req, res) => {
    const { pattern } = req.body;
    if (pattern) {
        globalCache.delete(pattern);
        res.json({ message: `Cache cleared for pattern: ${pattern}` });
    }
    else {
        globalCache.clear();
        res.json({ message: 'All cache cleared' });
    }
});
// API Routes (consolidated)
app.use(base, apiRouter);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});
// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});
// Export for Vercel serverless
export default app;
//# sourceMappingURL=index.js.map