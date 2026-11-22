// Minimal reference server for ChessMaster online play.  node server.js  (needs: npm i ws)
// Pure relay: it pairs two players, stores the move list for reconnects, and forwards messages.
// Game rules are validated by the clients; add chess validation here if you want an authoritative server.
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT, path: '/ws' });
const rooms = new Map(); // code -> { seats:{w,b}, moves:[], rematch:{w,b}, timer }
const other = c => (c === 'w' ? 'b' : 'w');
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const code = () => { let c; do { c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); } while (rooms.has(c)); return c; };
const token = () => crypto.randomBytes(12).toString('hex');
const seatOf = (room, ws) => ['w', 'b'].find(c => room.seats[c] && room.seats[c].ws === ws);

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = rooms.get(String(m.room || '').toUpperCase());
    const me = room && seatOf(room, ws);
    switch (m.type) {
      case 'ping': return send(ws, { type: 'pong' });
      case 'create': {
        const color = m.color === 'w' || m.color === 'b' ? m.color : (Math.random() < .5 ? 'w' : 'b');
        const id = code(), tk = token();
        rooms.set(id, { seats: { [color]: { ws, name: String(m.name || 'Player').slice(0, 16), token: tk }, [other(color)]: null }, moves: [], rematch: {} });
        return send(ws, { type: 'created', room: id, token: tk, color });
      }
      case 'join': {
        if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
        const free = ['w', 'b'].find(c => !room.seats[c]);
        if (!free) return send(ws, { type: 'error', message: 'Room is full.' });
        const tk = token(), host = room.seats[other(free)];
        room.seats[free] = { ws, name: String(m.name || 'Player').slice(0, 16), token: tk };
        clearTimeout(room.timer);
        send(ws, { type: 'joined', room: String(m.room).toUpperCase(), token: tk, color: free, opponent: host.name, opponent_online: !!host.ws, moves: room.moves });
        return send(host.ws, { type: 'opponent_joined', name: room.seats[free].name });
      }
      case 'rejoin': {
        if (!room) return send(ws, { type: 'error', fatal: true, message: 'Room no longer exists.' });
        const c = ['w', 'b'].find(c => room.seats[c] && room.seats[c].token === m.token);
        if (!c) return send(ws, { type: 'error', fatal: true, message: 'Could not rejoin this room.' });
        room.seats[c].ws = ws; clearTimeout(room.timer);
        const opp = room.seats[other(c)];
        send(ws, { type: 'joined', room: m.room, token: m.token, color: c, opponent: opp ? opp.name : null, opponent_online: !!(opp && opp.ws), moves: room.moves });
        return opp && send(opp.ws, { type: 'opponent_back' });
      }
      case 'sync': return me && send(ws, { type: 'sync', moves: room.moves });
      case 'move': {
        if (!me) return;
        const turn = room.moves.length % 2 === 0 ? 'w' : 'b';
        if (me !== turn || m.ply !== room.moves.length + 1) return send(ws, { type: 'sync', moves: room.moves });
        room.moves.push(m.move);
        return send(room.seats[other(me)]?.ws, { type: 'move', move: m.move });
      }
      case 'resign': case 'draw_offer': case 'draw_accept': case 'draw_decline':
        return me && send(room.seats[other(me)]?.ws, { type: m.type });
      case 'rematch': {
        if (!me) return;
        room.rematch[me] = true;
        if (!(room.rematch.w && room.rematch.b)) return send(room.seats[other(me)]?.ws, { type: 'rematch_request' });
        room.rematch = {}; room.moves = [];
        [room.seats.w, room.seats.b] = [room.seats.b, room.seats.w];
        for (const c of ['w', 'b']) send(room.seats[c].ws, { type: 'rematch', color: c });
        return;
      }
      case 'leave': return me && drop(room, me, true);
    }
  });
  ws.on('close', () => { for (const room of rooms.values()) { const c = seatOf(room, ws); if (c) drop(room, c, false); } });
});
function drop(room, c, left) {
  const opp = room.seats[other(c)];
  if (left) room.seats[c] = null; else room.seats[c].ws = null;
  send(opp && opp.ws, { type: 'opponent_left' });
  if (!(room.seats.w && room.seats.w.ws) && !(room.seats.b && room.seats.b.ws)) {
    room.timer = setTimeout(() => { for (const [k, v] of rooms) if (v === room) rooms.delete(k); }, 10 * 60 * 1000);
  }
}
console.log('ChessMaster server on ws://localhost:' + PORT + '/ws');
