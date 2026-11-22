/**
 * Transport-Agnostic Authoritative Room Manager
 *
 * Powers both Socket.IO (/socket.io) and native WebSocket (/ws) simultaneously
 * so the existing Netlify ChessMaster frontend and Socket.IO clients share the
 * exact same rooms, validation engine, and lifecycle.
 */

import crypto from 'crypto';
import {
  createInitialState,
  otherColor,
  positionKey,
  toFEN,
  validateAndApplyMove,
} from './chessEngine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 10 * 60 * 1000);
const DEFAULT_MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  return cleaned || 'Player';
}

function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

export class ChessRoomManager {
  constructor(options = {}) {
    this.roomTtlMs = options.roomTtlMs || DEFAULT_ROOM_TTL_MS;
    this.maxRooms = options.maxRooms || DEFAULT_MAX_ROOMS;
    this.rooms = new Map();
    this.connectionIndex = new Map(); // connId -> { roomCode, color }
    this.metrics = {
      startedAt: Date.now(),
      totalRoomsCreated: 0,
      totalMovesValidated: 0,
      totalMovesRejected: 0,
      totalGamesCompleted: 0,
    };
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitChange(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // Ignore observer errors
      }
    }
  }

  generateRoomCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  createFreshGame() {
    const state = createInitialState();
    const reps = { [positionKey(state)]: 1 };
    return {
      state,
      reps,
      fen: toFEN(state),
      moves: [], // array of { fr, fc, r, c, promo, from, to, san }
      drawOfferBy: null,
      rematch: { w: false, b: false },
      status: 'waiting', // waiting | playing | finished
      outcome: null, // checkmate | stalemate | draw_agreed | resign | insufficient_material | fifty_move_rule | threefold_repetition
      winner: null, // 'w' | 'b' | null
    };
  }

  getWireMoves(room) {
    // Exact format expected by Netlify ChessMaster index.html
    return room.moves.map(({ fr, fc, r, c, promo }) => ({ fr, fc, r, c, promo: promo || null }));
  }

  getDetailedState(room) {
    return {
      room: room.code,
      status: room.status,
      turn: room.state.turn,
      fen: room.fen,
      ply: room.moves.length,
      moves: this.getWireMoves(room),
      history: room.moves,
      outcome: room.outcome,
      winner: room.winner,
      drawOfferBy: room.drawOfferBy,
      players: {
        w: room.seats.w
          ? { name: room.seats.w.name, online: !!room.seats.w.conn, transport: room.seats.w.transport }
          : null,
        b: room.seats.b
          ? { name: room.seats.b.name, online: !!room.seats.b.conn, transport: room.seats.b.transport }
          : null,
      },
    };
  }

  scheduleCleanupIfEmpty(room) {
    clearTimeout(room.cleanupTimer);
    const whiteOnline = !!(room.seats.w && room.seats.w.conn);
    const blackOnline = !!(room.seats.b && room.seats.b.conn);

    if (!whiteOnline && !blackOnline) {
      room.cleanupTimer = setTimeout(() => {
        const current = this.rooms.get(room.code);
        if (!current) return;
        const stillEmpty = !(current.seats.w && current.seats.w.conn) && !(current.seats.b && current.seats.b.conn);
        if (stillEmpty) {
          this.rooms.delete(room.code);
          this.emitChange({ type: 'room_expired', room: room.code });
        }
      }, this.roomTtlMs);
    }
  }

  detachConnection(connId) {
    const binding = this.connectionIndex.get(connId);
    if (!binding) return;
    this.connectionIndex.delete(connId);

    const room = this.rooms.get(binding.roomCode);
    if (!room) return;
    const seat = room.seats[binding.color];
    if (seat && seat.conn && seat.conn.id === connId) {
      seat.conn = null;
      seat.lastDisconnectedAt = Date.now();
      const opp = room.seats[otherColor(binding.color)];
      if (opp && opp.conn) {
        opp.conn.send('opponent_left', {
          room: room.code,
          color: binding.color,
          name: seat.name,
        });
      }
      this.scheduleCleanupIfEmpty(room);
      this.emitChange({ type: 'player_disconnected', room: room.code, color: binding.color });
    }
  }

  bindConnection(conn, roomCode, color) {
    // If this connection was previously in another room, cleanly detach first
    if (this.connectionIndex.has(conn.id)) {
      this.detachConnection(conn.id);
    }
    this.connectionIndex.set(conn.id, { roomCode, color });
  }

  createRoom(conn, { name, color } = {}) {
    if (this.rooms.size >= this.maxRooms) {
      return { ok: false, error: 'Server room capacity reached. Please try again shortly.' };
    }

    const chosenColor =
      color === 'w' || color === 'b' ? color : crypto.randomInt(2) === 0 ? 'w' : 'b';
    const code = this.generateRoomCode();
    const token = generateToken();
    const cleanName = sanitizeName(name);
    const game = this.createFreshGame();

    const room = {
      code,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cleanupTimer: null,
      seats: {
        w: null,
        b: null,
      },
      ...game,
    };

    room.seats[chosenColor] = {
      name: cleanName,
      token,
      conn,
      transport: conn.transport,
      joinedAt: Date.now(),
      lastDisconnectedAt: null,
    };

    this.rooms.set(code, room);
    this.bindConnection(conn, code, chosenColor);
    this.metrics.totalRoomsCreated++;
    this.emitChange({ type: 'room_created', room: code, color: chosenColor });

    return {
      ok: true,
      room: code,
      token,
      color: chosenColor,
      state: this.getDetailedState(room),
    };
  }

  joinRoom(conn, { room: rawCode, name } = {}) {
    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, error: 'Room not found.' };
    }

    const freeColor = ['w', 'b'].find((c) => !room.seats[c]);
    if (!freeColor) {
      return { ok: false, error: 'Room is full.' };
    }

    const token = generateToken();
    const cleanName = sanitizeName(name);
    const hostColor = otherColor(freeColor);
    const host = room.seats[hostColor];

    room.seats[freeColor] = {
      name: cleanName,
      token,
      conn,
      transport: conn.transport,
      joinedAt: Date.now(),
      lastDisconnectedAt: null,
    };

    clearTimeout(room.cleanupTimer);
    if (room.status === 'waiting') {
      room.status = 'playing';
    }
    room.updatedAt = Date.now();
    this.bindConnection(conn, code, freeColor);

    if (host && host.conn) {
      host.conn.send('opponent_joined', {
        room: code,
        name: cleanName,
        color: freeColor,
        state: this.getDetailedState(room),
      });
    }

    this.emitChange({ type: 'player_joined', room: code, color: freeColor });

    return {
      ok: true,
      room: code,
      token,
      color: freeColor,
      opponent: host ? host.name : null,
      opponent_online: !!(host && host.conn),
      moves: this.getWireMoves(room),
      state: this.getDetailedState(room),
    };
  }

  rejoinRoom(conn, { room: rawCode, token, name } = {}) {
    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, fatal: true, error: 'Room no longer exists.' };
    }
    if (typeof token !== 'string' || !token) {
      return { ok: false, fatal: true, error: 'Missing reconnection token.' };
    }

    const color = ['w', 'b'].find((c) => room.seats[c] && room.seats[c].token === token);
    if (!color) {
      return { ok: false, fatal: true, error: 'Invalid reconnection token for this room.' };
    }

    const seat = room.seats[color];
    // Detach stale connection reference if one still exists
    if (seat.conn && seat.conn.id !== conn.id) {
      this.connectionIndex.delete(seat.conn.id);
    }

    seat.conn = conn;
    seat.transport = conn.transport;
    seat.lastDisconnectedAt = null;
    if (name) {
      seat.name = sanitizeName(name);
    }

    clearTimeout(room.cleanupTimer);
    room.updatedAt = Date.now();
    this.bindConnection(conn, code, color);

    const opp = room.seats[otherColor(color)];
    if (opp && opp.conn) {
      opp.conn.send('opponent_back', {
        room: code,
        name: seat.name,
        color,
      });
    }

    this.emitChange({ type: 'player_rejoined', room: code, color });

    return {
      ok: true,
      room: code,
      token,
      color,
      opponent: opp ? opp.name : null,
      opponent_online: !!(opp && opp.conn),
      moves: this.getWireMoves(room),
      state: this.getDetailedState(room),
    };
  }

  getSeatForConnection(connId, rawCode) {
    const binding = this.connectionIndex.get(connId);
    if (!binding) return null;
    const expectedCode = rawCode ? normalizeRoomCode(rawCode) : binding.roomCode;
    if (expectedCode && expectedCode !== binding.roomCode) return null;
    const room = this.rooms.get(binding.roomCode);
    if (!room) return null;
    const seat = room.seats[binding.color];
    if (!seat || !seat.conn || seat.conn.id !== connId) return null;
    return { room, color: binding.color, seat };
  }

  handleMove(conn, { room: rawCode, ply, move } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) {
      return { ok: false, error: 'You are not seated in this room.' };
    }

    const { room, color } = ctx;

    if (!room.seats.w || !room.seats.b) {
      this.metrics.totalMovesRejected++;
      return {
        ok: false,
        sync: true,
        moves: this.getWireMoves(room),
        state: this.getDetailedState(room),
        error: 'Waiting for opponent to join before moves can be played.',
      };
    }

    if (room.status === 'finished') {
      this.metrics.totalMovesRejected++;
      return {
        ok: false,
        sync: true,
        moves: this.getWireMoves(room),
        state: this.getDetailedState(room),
        error: 'Game is already over.',
      };
    }

    if (room.state.turn !== color) {
      this.metrics.totalMovesRejected++;
      return {
        ok: false,
        sync: true,
        moves: this.getWireMoves(room),
        state: this.getDetailedState(room),
        error: 'Not your turn.',
      };
    }

    if (ply !== undefined && ply !== null && ply !== room.moves.length + 1) {
      this.metrics.totalMovesRejected++;
      return {
        ok: false,
        sync: true,
        moves: this.getWireMoves(room),
        state: this.getDetailedState(room),
        error: 'Move sequence out of sync.',
      };
    }

    const result = validateAndApplyMove(room.state, room.reps, move);
    if (!result.ok) {
      this.metrics.totalMovesRejected++;
      return {
        ok: false,
        sync: true,
        moves: this.getWireMoves(room),
        state: this.getDetailedState(room),
        error: result.reason,
      };
    }

    room.state = result.state;
    room.reps = result.reps;
    room.fen = result.fen;
    room.moves.push(result.move);
    room.drawOfferBy = null; // Any move cancels a pending draw offer
    room.status = result.evaluation.status;
    room.outcome = result.evaluation.outcome;
    room.winner = result.evaluation.winner;
    room.updatedAt = Date.now();

    this.metrics.totalMovesValidated++;
    if (room.status === 'finished') {
      this.metrics.totalGamesCompleted++;
    }

    const opp = room.seats[otherColor(color)];
    const wireMove = {
      fr: result.move.fr,
      fc: result.move.fc,
      r: result.move.r,
      c: result.move.c,
      promo: result.move.promo,
    };

    const stateSnapshot = this.getDetailedState(room);

    if (opp && opp.conn) {
      opp.conn.send('move', {
        room: room.code,
        move: wireMove,
        detailedMove: result.move,
        ply: room.moves.length,
        state: stateSnapshot,
      });
    }

    this.emitChange({
      type: 'move_played',
      room: room.code,
      color,
      san: result.move.san,
      ply: room.moves.length,
    });

    return {
      ok: true,
      room: room.code,
      move: wireMove,
      detailedMove: result.move,
      ply: room.moves.length,
      state: stateSnapshot,
    };
  }

  handleSync(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) {
      return { ok: false, error: 'Not seated in room.' };
    }
    return {
      ok: true,
      moves: this.getWireMoves(ctx.room),
      state: this.getDetailedState(ctx.room),
    };
  }

  handleResign(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) return { ok: false, error: 'Not seated in room.' };
    const { room, color } = ctx;
    if (room.status === 'finished') {
      return { ok: false, error: 'Game is already over.' };
    }

    room.status = 'finished';
    room.outcome = 'resign';
    room.winner = otherColor(color);
    room.drawOfferBy = null;
    room.updatedAt = Date.now();
    this.metrics.totalGamesCompleted++;

    const opp = room.seats[otherColor(color)];
    if (opp && opp.conn) {
      opp.conn.send('resign', {
        room: room.code,
        by: color,
        winner: room.winner,
        state: this.getDetailedState(room),
      });
    }

    this.emitChange({ type: 'game_resigned', room: room.code, by: color });
    return { ok: true, winner: room.winner, state: this.getDetailedState(room) };
  }

  handleDrawOffer(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) return { ok: false, error: 'Not seated in room.' };
    const { room, color } = ctx;
    if (room.status !== 'playing') {
      return { ok: false, error: 'Draw can only be offered during an active game.' };
    }
    if (room.drawOfferBy === color) {
      return { ok: false, error: 'Draw offer already pending.' };
    }

    room.drawOfferBy = color;
    room.updatedAt = Date.now();
    const opp = room.seats[otherColor(color)];
    if (opp && opp.conn) {
      opp.conn.send('draw_offer', { room: room.code, by: color });
    }
    this.emitChange({ type: 'draw_offered', room: room.code, by: color });
    return { ok: true };
  }

  handleDrawAccept(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) return { ok: false, error: 'Not seated in room.' };
    const { room, color } = ctx;
    if (room.status !== 'playing') {
      return { ok: false, error: 'Game is not active.' };
    }
    if (!room.drawOfferBy || room.drawOfferBy === color) {
      return { ok: false, error: 'No opponent draw offer to accept.' };
    }

    room.status = 'finished';
    room.outcome = 'draw_agreed';
    room.winner = null;
    room.drawOfferBy = null;
    room.updatedAt = Date.now();
    this.metrics.totalGamesCompleted++;

    const opp = room.seats[otherColor(color)];
    if (opp && opp.conn) {
      opp.conn.send('draw_accept', { room: room.code, state: this.getDetailedState(room) });
    }
    this.emitChange({ type: 'draw_accepted', room: room.code });
    return { ok: true, state: this.getDetailedState(room) };
  }

  handleDrawDecline(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) return { ok: false, error: 'Not seated in room.' };
    const { room, color } = ctx;
    if (!room.drawOfferBy || room.drawOfferBy === color) {
      return { ok: false, error: 'No opponent draw offer to decline.' };
    }

    room.drawOfferBy = null;
    room.updatedAt = Date.now();
    const opp = room.seats[otherColor(color)];
    if (opp && opp.conn) {
      opp.conn.send('draw_decline', { room: room.code });
    }
    this.emitChange({ type: 'draw_declined', room: room.code });
    return { ok: true };
  }

  handleRematch(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) return { ok: false, error: 'Not seated in room.' };
    const { room, color } = ctx;

    if (!room.seats.w || !room.seats.b) {
      return { ok: false, error: 'Both players must be present for a rematch.' };
    }

    room.rematch[color] = true;
    room.updatedAt = Date.now();

    if (!(room.rematch.w && room.rematch.b)) {
      const opp = room.seats[otherColor(color)];
      if (opp && opp.conn) {
        opp.conn.send('rematch_request', { room: room.code, by: color });
      }
      return { ok: true, pending: true };
    }

    // Both players agreed: swap colors, reset game state, and update connection bindings
    const fresh = this.createFreshGame();
    fresh.status = 'playing';
    Object.assign(room, fresh);

    const prevW = room.seats.w;
    const prevB = room.seats.b;
    room.seats.w = prevB;
    room.seats.b = prevW;

    for (const c of ['w', 'b']) {
      const seat = room.seats[c];
      if (seat && seat.conn) {
        this.connectionIndex.set(seat.conn.id, { roomCode: room.code, color: c });
      }
    }

    const stateSnapshot = this.getDetailedState(room);
    for (const c of ['w', 'b']) {
      const seat = room.seats[c];
      if (seat && seat.conn) {
        seat.conn.send('rematch', {
          room: room.code,
          color: c,
          state: stateSnapshot,
        });
      }
    }

    this.emitChange({ type: 'rematch_started', room: room.code });
    return { ok: true, started: true, state: stateSnapshot };
  }

  handleLeave(conn, { room: rawCode } = {}) {
    const ctx = this.getSeatForConnection(conn.id, rawCode);
    if (!ctx) return { ok: false };
    const { room, color } = ctx;

    this.connectionIndex.delete(conn.id);
    const leavingName = room.seats[color]?.name;
    room.seats[color] = null;
    room.rematch[color] = false;
    room.updatedAt = Date.now();

    const opp = room.seats[otherColor(color)];
    if (opp && opp.conn) {
      opp.conn.send('opponent_left', {
        room: room.code,
        color,
        name: leavingName,
        permanent: true,
      });
    }

    if (!room.seats.w && !room.seats.b) {
      clearTimeout(room.cleanupTimer);
      this.rooms.delete(room.code);
    } else {
      this.scheduleCleanupIfEmpty(room);
    }

    this.emitChange({ type: 'player_left', room: room.code, color });
    return { ok: true };
  }

  getPublicRoomList() {
    const list = [];
    for (const room of this.rooms.values()) {
      list.push({
        code: room.code,
        status: room.status,
        turn: room.state.turn,
        ply: room.moves.length,
        fen: room.fen,
        outcome: room.outcome,
        winner: room.winner,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        players: {
          w: room.seats.w
            ? { name: room.seats.w.name, online: !!room.seats.w.conn, transport: room.seats.w.transport }
            : null,
          b: room.seats.b
            ? { name: room.seats.b.name, online: !!room.seats.b.conn, transport: room.seats.b.transport }
            : null,
        },
        openSeat: !room.seats.w || !room.seats.b,
      });
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPublicRoom(rawCode) {
    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) return null;
    return this.getDetailedState(room);
  }

  getStats() {
    let onlinePlayers = 0;
    let activeGames = 0;
    let waitingRooms = 0;
    for (const room of this.rooms.values()) {
      if (room.seats.w?.conn) onlinePlayers++;
      if (room.seats.b?.conn) onlinePlayers++;
      if (room.status === 'playing') activeGames++;
      if (room.status === 'waiting') waitingRooms++;
    }
    return {
      activeRooms: this.rooms.size,
      waitingRooms,
      activeGames,
      onlinePlayers,
      uptimeSeconds: Math.floor((Date.now() - this.metrics.startedAt) / 1000),
      totalRoomsCreated: this.metrics.totalRoomsCreated,
      totalMovesValidated: this.metrics.totalMovesValidated,
      totalMovesRejected: this.metrics.totalMovesRejected,
      totalGamesCompleted: this.metrics.totalGamesCompleted,
      roomTtlSeconds: Math.floor(this.roomTtlMs / 1000),
      maxRooms: this.maxRooms,
    };
  }
}
