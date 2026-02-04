import app from '../api/index.js';

const port = process.env.PORT || 3001;

console.log('🚀 Starting Express backend server...');
console.log(`📦 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔑 Supabase URL: ${process.env.VITE_SUPABASE_URL ? '✓ configured' : '✗ missing'}`);

const server = app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
  console.log(`🏥 Health check: http://localhost:${port}/health`);
  console.log(`📊 Cache stats: http://localhost:${port}/api/cache/stats`);
  console.log(`✈️  Aircraft API: http://localhost:${port}/api/aircraft`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
