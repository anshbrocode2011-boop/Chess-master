/**
 * Unified Express + Socket.IO + Native WebSocket (/ws) Chess Multiplayer Backend
 *
 * - Compatible with Netlify-hosted ChessMaster frontend out of the box via wss://<host>/ws
 * - Full Socket.IO server at /socket.io with clean event contracts + ack callbacks
 * - Lightweight & memory-bounded for Render Free Tier
 */

import crypto from 'crypto';
import cors from 'cors';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer } from 'ws';
import { ChessRoomManager } from './roomManager.js';

function parseAllowedOrigins(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '*') return '*';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function getAppOrigin() {
  if (!process.env.APP_URL) return null;
  try {
    return new URL(process.env.APP_URL).origin;
  } catch {
    return null;
  }
}

function isSameOriginRequest(origin, req) {
  if (!origin || !req) return false;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const rawForwarded = req.headers['x-forwarded-host'];
    const forwardedHost = Array.isArray(rawForwarded)
      ? rawForwarded[0]
      : String(rawForwarded || '').split(',')[0].trim();
    const hostHeader = String(req.headers.host || '').trim();
    if (forwardedHost && originHost === forwardedHost.toLowerCase()) return true;
    if (hostHeader && originHost === hostHeader.toLowerCase()) return true;
    const appOrigin = getAppOrigin();
    if (appOrigin && origin.replace(/\/+$/, '') === appOrigin) return true;
    return false;
  } catch {
    return false;
  }
}

function isOriginAllowed(origin, allowedOrigins, req) {
  if (!origin) return true;
  if (allowedOrigins === '*') return true;
  const normalized = origin.replace(/\/+$/, '');
  if (allowedOrigins.includes(normalized)) return true;
  if (isSameOriginRequest(normalized, req)) return true;
  return false;
}

/**
 * Simple per-connection sliding-window rate limiter to protect Render free tier.
 */
function createRateLimiter(maxEvents = 40, windowMs = 5000) {
  let count = 0;
  let resetAt = Date.now() + windowMs;
  return () => {
    const now = Date.now();
    if (now > resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }
    count++;
    return count <= maxEvents;
  };
}

export function attachChessBackend({ app, httpServer, corsOriginsRaw = process.env.CORS_ORIGINS || '*' }) {
  const allowedOrigins = parseAllowedOrigins(corsOriginsRaw);
  const manager = new ChessRoomManager();

  // ---- Express CORS & JSON middleware (never throws 500 on origin mismatch) ----
  const corsDelegate = (req, callback) => {
    const origin = req.headers.origin;
    const allowed = isOriginAllowed(origin, allowedOrigins, req);
    callback(null, {
      origin: allowed,
      methods: ['GET', 'POST', 'OPTIONS'],
    });
  };
  app.use('/api', cors(corsDelegate));
  app.use('/health', cors(corsDelegate));
  app.use(express.json({ limit: '16kb' }));

  // ---- REST Endpoints ----
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'chessmaster-multiplayer-server',
      transports: ['socket.io', 'ws:/ws'],
      ...manager.getStats(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/stats', (_req, res) => {
    res.json(manager.getStats());
  });

  app.get('/api/rooms', (_req, res) => {
    res.json({
      stats: manager.getStats(),
      rooms: manager.getPublicRoomList(),
    });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const room = manager.getPublicRoom(req.params.code);
    if (!room) {
      return res.status(404).json({ error: 'Room not found.' });
    }
    return res.json(room);
  });

  // ---- Socket.IO Server (/socket.io) ----
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 25000,
    pingTimeout: 20000,
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const ok = isOriginAllowed(origin, allowedOrigins, req);
      callback(null, ok);
    },
    cors: {
      origin: (origin, callback) => {
        const appOrigin = getAppOrigin();
        const ok =
          !origin ||
          allowedOrigins === '*' ||
          allowedOrigins.includes(origin.replace(/\/+$/, '')) ||
          (!!appOrigin && origin.replace(/\/+$/, '') === appOrigin);
        callback(null, ok);
      },
      methods: ['GET', 'POST'],
    },
  });

  // Broadcast live stats to monitor subscribers in the /monitor namespace
  const monitorNsp = io.of('/monitor');
  const broadcastMonitor = (event) => {
    monitorNsp.emit('snapshot', {
      event,
      stats: manager.getStats(),
      rooms: manager.getPublicRoomList(),
    });
  };
  manager.onChange(broadcastMonitor);
  monitorNsp.on('connection', (socket) => {
    socket.emit('snapshot', {
      event: { type: 'connected' },
      stats: manager.getStats(),
      rooms: manager.getPublicRoomList(),
    });
  });

  io.on('connection', (socket) => {
    const allow = createRateLimiter();

    // Transport adapter translating roomManager events -> Socket.IO events
    const conn = {
      id: `sio:${socket.id}`,
      transport: 'socket.io',
      send(type, payload = {}) {
        // Emit standard Socket.IO namespaced event
        switch (type) {
          case 'opponent_joined':
            socket.emit('room:opponent_joined', payload);
            break;
          case 'opponent_left':
            socket.emit('room:opponent_left', payload);
            break;
          case 'opponent_back':
            socket.emit('room:opponent_reconnected', payload);
            break;
          case 'move':
            socket.emit('game:move', payload);
            break;
          case 'resign':
            socket.emit('game:resigned', payload);
            break;
          case 'draw_offer':
            socket.emit('game:draw_offered', payload);
            break;
          case 'draw_accept':
            socket.emit('game:draw_accepted', payload);
            break;
          case 'draw_decline':
            socket.emit('game:draw_declined', payload);
            break;
          case 'rematch_request':
            socket.emit('game:rematch_requested', payload);
            break;
          case 'rematch':
            socket.emit('game:rematch_started', payload);
            break;
          default:
            socket.emit(type, payload);
        }
      },
    };

    const reply = (ack, data) => {
      if (typeof ack === 'function') ack(data);
    };

    socket.on('room:create', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.createRoom(conn, payload);
      if (res.ok) {
        socket.emit('room:created', res);
      } else {
        socket.emit('room:error', { message: res.error });
      }
      reply(ack, res);
    });

    socket.on('room:join', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.joinRoom(conn, payload);
      if (res.ok) {
        socket.emit('room:joined', res);
      } else {
        socket.emit('room:error', { message: res.error });
      }
      reply(ack, res);
    });

    socket.on('room:rejoin', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.rejoinRoom(conn, payload);
      if (res.ok) {
        socket.emit('room:joined', res);
      } else {
        socket.emit('room:error', { message: res.error, fatal: !!res.fatal });
      }
      reply(ack, res);
    });

    socket.on('game:move', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleMove(conn, payload);
      if (!res.ok) {
        if (res.sync) {
          socket.emit('game:sync', { moves: res.moves, state: res.state, reason: res.error });
        }
        socket.emit('room:error', { message: res.error });
      }
      reply(ack, res);
    });

    socket.on('game:sync', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleSync(conn, payload);
      if (res.ok) {
        socket.emit('game:sync', { moves: res.moves, state: res.state });
      }
      reply(ack, res);
    });

    socket.on('game:resign', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleResign(conn, payload);
      reply(ack, res);
    });

    socket.on('game:draw_offer', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleDrawOffer(conn, payload);
      reply(ack, res);
    });

    socket.on('game:draw_accept', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleDrawAccept(conn, payload);
      reply(ack, res);
    });

    socket.on('game:draw_decline', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleDrawDecline(conn, payload);
      reply(ack, res);
    });

    socket.on('game:rematch', (payload = {}, ack) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Rate limit exceeded.' });
      const res = manager.handleRematch(conn, payload);
      reply(ack, res);
    });

    socket.on('room:leave', (payload = {}, ack) => {
      const res = manager.handleLeave(conn, payload);
      reply(ack, res);
    });

    socket.on('disconnect', () => {
      manager.detachConnection(conn.id);
    });
  });

  // ---- Native WebSocket Server (/ws) — 100% compatible with existing Netlify ChessMaster index.html ----
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/ws') {
      // Allow same-origin upgrades and configured CORS_ORIGINS
      const origin = req.headers.origin;
      if (!isOriginAllowed(origin, allowedOrigins, req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // Note: /socket.io upgrades are handled automatically by Socket.IO's own upgrade listener.
  });

  const sendRaw = (ws, obj) => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  };

  wss.on('connection', (ws) => {
    const connId = `ws:${crypto.randomUUID()}`;
    const allow = createRateLimiter();

    const conn = {
      id: connId,
      transport: 'ws',
      send(type, payload = {}) {
        // Emit exact ChessMaster PROTOCOL.md frames
        switch (type) {
          case 'opponent_joined':
            sendRaw(ws, { type: 'opponent_joined', name: payload.name });
            break;
          case 'opponent_left':
            sendRaw(ws, { type: 'opponent_left' });
            break;
          case 'opponent_back':
            sendRaw(ws, { type: 'opponent_back' });
            break;
          case 'move':
            sendRaw(ws, { type: 'move', move: payload.move });
            break;
          case 'resign':
          case 'draw_offer':
          case 'draw_accept':
          case 'draw_decline':
          case 'rematch_request':
            sendRaw(ws, { type });
            break;
          case 'rematch':
            sendRaw(ws, { type: 'rematch', color: payload.color });
            break;
          default:
            sendRaw(ws, { type, ...payload });
        }
      },
    };

    ws.on('message', (raw) => {
      if (!allow()) {
        return sendRaw(ws, { type: 'error', message: 'Too many messages. Slow down.' });
      }
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;

      switch (m.type) {
        case 'ping':
          return sendRaw(ws, { type: 'pong' });

        case 'create': {
          const res = manager.createRoom(conn, { name: m.name, color: m.color });
          if (!res.ok) return sendRaw(ws, { type: 'error', message: res.error });
          return sendRaw(ws, { type: 'created', room: res.room, token: res.token, color: res.color });
        }

        case 'join': {
          const res = manager.joinRoom(conn, { room: m.room, name: m.name });
          if (!res.ok) return sendRaw(ws, { type: 'error', message: res.error });
          return sendRaw(ws, {
            type: 'joined',
            room: res.room,
            token: res.token,
            color: res.color,
            opponent: res.opponent,
            opponent_online: res.opponent_online,
            moves: res.moves,
            status: res.state.status,
            outcome: res.state.outcome,
            winner: res.state.winner,
            draw_offer_by: res.state.drawOfferBy,
          });
        }

        case 'rejoin': {
          const res = manager.rejoinRoom(conn, { room: m.room, token: m.token, name: m.name });
          if (!res.ok) {
            return sendRaw(ws, { type: 'error', fatal: !!res.fatal, message: res.error });
          }
          return sendRaw(ws, {
            type: 'joined',
            room: res.room,
            token: res.token,
            color: res.color,
            opponent: res.opponent,
            opponent_online: res.opponent_online,
            moves: res.moves,
            status: res.state.status,
            outcome: res.state.outcome,
            winner: res.state.winner,
            draw_offer_by: res.state.drawOfferBy,
          });
        }

        case 'move': {
          const res = manager.handleMove(conn, { room: m.room, ply: m.ply, move: m.move });
          if (!res.ok) {
            if (res.sync) {
              sendRaw(ws, {
                type: 'sync',
                moves: res.moves,
                status: res.state?.status,
                outcome: res.state?.outcome,
                winner: res.state?.winner,
                draw_offer_by: res.state?.drawOfferBy,
              });
            }
            if (res.error) {
              sendRaw(ws, { type: 'error', message: res.error });
            }
          }
          return;
        }

        case 'sync': {
          const res = manager.handleSync(conn, { room: m.room });
          if (res.ok) {
            return sendRaw(ws, {
              type: 'sync',
              moves: res.moves,
              status: res.state.status,
              outcome: res.state.outcome,
              winner: res.state.winner,
              draw_offer_by: res.state.drawOfferBy,
            });
          }
          return;
        }

        case 'resign': {
          manager.handleResign(conn, { room: m.room });
          return;
        }

        case 'draw_offer': {
          manager.handleDrawOffer(conn, { room: m.room });
          return;
        }

        case 'draw_accept': {
          manager.handleDrawAccept(conn, { room: m.room });
          return;
        }

        case 'draw_decline': {
          manager.handleDrawDecline(conn, { room: m.room });
          return;
        }

        case 'rematch': {
          manager.handleRematch(conn, { room: m.room });
          return;
        }

        case 'leave': {
          manager.handleLeave(conn, { room: m.room });
          return;
        }
      }
    });

    ws.on('close', () => {
      manager.detachConnection(conn.id);
    });
  });

  return { io, wss, manager };
}
