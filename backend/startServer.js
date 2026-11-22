import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { attachChessBackend } from './createChessServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist');
const distIndex = path.join(distDir, 'index.html');

const PORT = Number(process.env.PORT || 3000);
const isRender = process.env.RENDER === 'true';
const isProduction = process.env.NODE_ENV === 'production' || isRender;

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // Trust Render / reverse-proxy headers
  app.set('trust proxy', 1);

  const { io, wss } = attachChessBackend({
    app,
    httpServer,
    corsOriginsRaw: process.env.CORS_ORIGINS || '*',
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: rootDir,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distIndex)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(distIndex);
    });
  } else {
    app.get('*', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('Frontend build not found (dist/index.html missing). Run "npm run build" in your Render Build Command.');
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ChessMaster full-stack server listening on http://0.0.0.0:${PORT}`);
    console.log(`  Mode      : ${isProduction ? 'production' : 'development'}`);
    console.log(`  WebSocket : /ws`);
    console.log(`  Socket.IO : /socket.io`);
    console.log(`  Health    : /health`);
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    io.close();
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Failed to start ChessMaster server:', err);
  process.exit(1);
});
