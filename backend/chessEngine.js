/**
 * Server-Authoritative Chess Engine (Zero Dependencies)
 *
 * Coordinate system matches ChessMaster Netlify frontend:
 * - Row 0 = rank 8 (Black back rank), Row 7 = rank 1 (White back rank)
 * - Col 0 = file 'a', Col 7 = file 'h'
 * - Move object: { fr, fc, r, c, promo: 'q' | 'r' | 'b' | 'n' | null }
 * - Also accepts algebraic notation: { from: 'e2', to: 'e4', promotion?: 'q' }
 */

const FILES = 'abcdefgh';
const KNIGHT_DELTAS = [
  [1, 2], [2, 1], [-1, 2], [-2, 1],
  [1, -2], [2, -1], [-1, -2], [-2, -1],
];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const PROMO_TYPES = new Set(['q', 'r', 'b', 'n']);

export function colorOf(piece) {
  return piece ? piece[0] : undefined;
}

export function typeOf(piece) {
  return piece ? piece[1] : undefined;
}

export function otherColor(c) {
  return c === 'w' ? 'b' : 'w';
}

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

export function createInitialState() {
  return {
    b: [
      ['br', 'bn', 'bb', 'bq', 'bk', 'bb', 'bn', 'br'],
      Array(8).fill('bp'),
      Array(8).fill(null),
      Array(8).fill(null),
      Array(8).fill(null),
      Array(8).fill(null),
      Array(8).fill('wp'),
      ['wr', 'wn', 'wb', 'wq', 'wk', 'wb', 'wn', 'wr'],
    ],
    turn: 'w',
    ep: null,
    castle: { wK: true, wQ: true, bK: true, bQ: true },
    half: 0,
    full: 1,
  };
}

export function squareToCoords(sq) {
  if (typeof sq !== 'string' || sq.length !== 2) return null;
  const fc = FILES.indexOf(sq[0].toLowerCase());
  const rank = Number(sq[1]);
  if (fc < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) return null;
  return { r: 8 - rank, c: fc };
}

export function coordsToSquare(r, c) {
  if (!inside(r, c)) return '';
  return `${FILES[c]}${8 - r}`;
}

/**
 * Validates and normalizes client move input into { fr, fc, r, c, promo }.
 * Accepts either { fr, fc, r, c, promo? } or { from: 'e2', to: 'e4', promotion? }.
 */
export function normalizeMoveInput(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let fr;
  let fc;
  let r;
  let c;

  if (typeof raw.from === 'string' && typeof raw.to === 'string') {
    const fromCoords = squareToCoords(raw.from);
    const toCoords = squareToCoords(raw.to);
    if (!fromCoords || !toCoords) return null;
    fr = fromCoords.r;
    fc = fromCoords.c;
    r = toCoords.r;
    c = toCoords.c;
  } else {
    fr = raw.fr;
    fc = raw.fc;
    r = raw.r;
    c = raw.c;
  }

  if (
    !Number.isInteger(fr) ||
    !Number.isInteger(fc) ||
    !Number.isInteger(r) ||
    !Number.isInteger(c) ||
    !inside(fr, fc) ||
    !inside(r, c)
  ) {
    return null;
  }

  const rawPromo = raw.promo ?? raw.promotion ?? null;
  let promo = null;
  if (rawPromo !== null && rawPromo !== undefined && rawPromo !== '') {
    if (typeof rawPromo !== 'string') return null;
    const lower = rawPromo.toLowerCase();
    if (!PROMO_TYPES.has(lower)) return null;
    promo = lower;
  }

  return { fr, fc, r, c, promo };
}

export function isAttacked(board, r, c, byColor) {
  const dp = byColor === 'w' ? 1 : -1;
  for (const dc of [-1, 1]) {
    const rr = r + dp;
    const cc = c + dc;
    if (inside(rr, cc) && board[rr][cc] === `${byColor}p`) return true;
  }
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const rr = r + dr;
    const cc = c + dc;
    if (inside(rr, cc) && board[rr][cc] === `${byColor}n`) return true;
  }
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (inside(rr, cc) && board[rr][cc] === `${byColor}k`) return true;
    }
  }
  for (const [dr, dc] of ROOK_DIRS) {
    let rr = r + dr;
    let cc = c + dc;
    while (inside(rr, cc)) {
      const p = board[rr][cc];
      if (p) {
        if (p === `${byColor}r` || p === `${byColor}q`) return true;
        break;
      }
      rr += dr;
      cc += dc;
    }
  }
  for (const [dr, dc] of BISHOP_DIRS) {
    let rr = r + dr;
    let cc = c + dc;
    while (inside(rr, cc)) {
      const p = board[rr][cc];
      if (p) {
        if (p === `${byColor}b` || p === `${byColor}q`) return true;
        break;
      }
      rr += dr;
      cc += dc;
    }
  }
  return false;
}

export function findKing(board, col) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === `${col}k`) return [r, c];
    }
  }
  return null;
}

export function isInCheck(board, col) {
  const king = findKing(board, col);
  if (!king) return true;
  return isAttacked(board, king[0], king[1], otherColor(col));
}

function pseudoMoves(state, r, c) {
  const b = state.b;
  const p = b[r][c];
  if (!p) return [];
  const col = colorOf(p);
  const t = typeOf(p);
  const opp = otherColor(col);
  const out = [];

  const add = (rr, cc, extra) => {
    if (!inside(rr, cc) || colorOf(b[rr][cc]) === col) return false;
    out.push({ fr: r, fc: c, r: rr, c: cc, ...(extra || {}) });
    return !b[rr][cc];
  };

  if (t === 'p') {
    const dir = col === 'w' ? -1 : 1;
    const lastRank = col === 'w' ? 0 : 7;
    const push = (rr, cc, extra) => {
      if (rr === lastRank) {
        for (const pr of ['q', 'r', 'b', 'n']) {
          out.push({ fr: r, fc: c, r: rr, c: cc, promo: pr, ...(extra || {}) });
        }
      } else {
        out.push({ fr: r, fc: c, r: rr, c: cc, ...(extra || {}) });
      }
    };
    if (inside(r + dir, c) && !b[r + dir][c]) {
      push(r + dir, c);
      if (r === (col === 'w' ? 6 : 1) && !b[r + 2 * dir][c]) {
        push(r + 2 * dir, c, { double: true });
      }
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir;
      const cc = c + dc;
      if (!inside(rr, cc)) continue;
      if (b[rr][cc] && colorOf(b[rr][cc]) === opp) {
        push(rr, cc);
      } else if (
        !b[rr][cc] &&
        state.ep &&
        state.ep.r === rr &&
        state.ep.c === cc &&
        b[r][cc] === `${opp}p`
      ) {
        push(rr, cc, { enpassant: true });
      }
    }
  } else if (t === 'n') {
    for (const [dr, dc] of KNIGHT_DELTAS) add(r + dr, c + dc);
  } else if (t === 'k') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr || dc) add(r + dr, c + dc);
      }
    }
    const homeRow = col === 'w' ? 7 : 0;
    if (r === homeRow && c === 4 && b[homeRow][4] === `${col}k` && !isAttacked(b, homeRow, 4, opp)) {
      if (
        state.castle[`${col}K`] &&
        b[homeRow][7] === `${col}r` &&
        !b[homeRow][5] &&
        !b[homeRow][6] &&
        !isAttacked(b, homeRow, 5, opp) &&
        !isAttacked(b, homeRow, 6, opp)
      ) {
        out.push({ fr: r, fc: c, r: homeRow, c: 6, castle: 'K' });
      }
      if (
        state.castle[`${col}Q`] &&
        b[homeRow][0] === `${col}r` &&
        !b[homeRow][1] &&
        !b[homeRow][2] &&
        !b[homeRow][3] &&
        !isAttacked(b, homeRow, 3, opp) &&
        !isAttacked(b, homeRow, 2, opp)
      ) {
        out.push({ fr: r, fc: c, r: homeRow, c: 2, castle: 'Q' });
      }
    }
  } else {
    const dirs = t === 'b' ? BISHOP_DIRS : t === 'r' ? ROOK_DIRS : BISHOP_DIRS.concat(ROOK_DIRS);
    for (const [dr, dc] of dirs) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc)) {
        if (!add(rr, cc)) break;
        rr += dr;
        cc += dc;
      }
    }
  }

  return out;
}

export function applyMove(state, move) {
  const b = cloneBoard(state.b);
  const p = b[move.fr][move.fc];
  const col = colorOf(p);
  const target = b[move.r][move.c];
  const castle = { ...state.castle };

  b[move.fr][move.fc] = null;
  b[move.r][move.c] = p;

  if (move.enpassant) {
    b[move.fr][move.c] = null;
  }
  if (move.castle === 'K') {
    b[move.r][5] = b[move.r][7];
    b[move.r][7] = null;
  }
  if (move.castle === 'Q') {
    b[move.r][3] = b[move.r][0];
    b[move.r][0] = null;
  }
  if (typeOf(p) === 'p' && (move.r === 0 || move.r === 7)) {
    b[move.r][move.c] = `${col}${move.promo || 'q'}`;
  }

  if (typeOf(p) === 'k') {
    castle[`${col}K`] = false;
    castle[`${col}Q`] = false;
  }
  if (typeOf(p) === 'r') {
    const hr = col === 'w' ? 7 : 0;
    if (move.fr === hr && move.fc === 0) castle[`${col}Q`] = false;
    if (move.fr === hr && move.fc === 7) castle[`${col}K`] = false;
  }
  if (typeOf(target) === 'r') {
    const oc = colorOf(target);
    const hr = oc === 'w' ? 7 : 0;
    if (move.r === hr && move.c === 0) castle[`${oc}Q`] = false;
    if (move.r === hr && move.c === 7) castle[`${oc}K`] = false;
  }

  const ep =
    typeOf(p) === 'p' && Math.abs(move.r - move.fr) === 2
      ? { r: (move.r + move.fr) / 2, c: move.fc }
      : null;

  const resetHalf = typeOf(p) === 'p' || !!target || !!move.enpassant;

  return {
    b,
    turn: otherColor(state.turn),
    ep,
    castle,
    half: resetHalf ? 0 : state.half + 1,
    full: state.turn === 'b' ? state.full + 1 : state.full,
  };
}

export function getLegalMoves(state) {
  const out = [];
  const col = state.turn;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (colorOf(state.b[r][c]) === col) {
        for (const m of pseudoMoves(state, r, c)) {
          if (!isInCheck(applyMove(state, m).b, col)) {
            out.push(m);
          }
        }
      }
    }
  }
  return out;
}

export function positionKey(state) {
  let epKey = '-';
  if (state.ep) {
    const col = state.turn;
    const d = col === 'w' ? 1 : -1;
    for (const dc of [-1, 1]) {
      const rr = state.ep.r + d;
      const cc = state.ep.c + dc;
      if (inside(rr, cc) && state.b[rr][cc] === `${col}p`) {
        const m = { fr: rr, fc: cc, r: state.ep.r, c: state.ep.c, enpassant: true };
        if (!isInCheck(applyMove(state, m).b, col)) {
          epKey = `${state.ep.r}${state.ep.c}`;
          break;
        }
      }
    }
  }
  return (
    state.b.map((row) => row.map((p) => p || '..').join('')).join('/') +
    state.turn +
    (state.castle.wK ? 'K' : '') +
    (state.castle.wQ ? 'Q' : '') +
    (state.castle.bK ? 'k' : '') +
    (state.castle.bQ ? 'q' : '') +
    epKey
  );
}

export function hasInsufficientMaterial(board) {
  const minors = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const t = typeOf(p);
      if (t === 'k') continue;
      if (t === 'p' || t === 'r' || t === 'q') return false;
      minors.push({ t, col: colorOf(p), sq: (r + c) % 2 });
    }
  }
  if (minors.length <= 1) return true;
  if (minors.every((x) => x.t === 'b') && minors.every((x) => x.sq === minors[0].sq)) {
    return true;
  }
  return false;
}

export function moveToSAN(state, move, legal) {
  const p = state.b[move.fr][move.fc];
  const t = typeOf(p);
  let txt;
  if (move.castle) {
    txt = move.castle === 'K' ? 'O-O' : 'O-O-O';
  } else {
    const cap = !!state.b[move.r][move.c] || !!move.enpassant;
    if (t === 'p') {
      txt = (cap ? `${FILES[move.fc]}x` : '') + FILES[move.c] + (8 - move.r) + (move.promo ? `=${move.promo.toUpperCase()}` : '');
    } else {
      let dis = '';
      const others = legal.filter(
        (x) =>
          x !== move &&
          x.r === move.r &&
          x.c === move.c &&
          typeOf(state.b[x.fr][x.fc]) === t &&
          !(x.fr === move.fr && x.fc === move.fc)
      );
      if (others.length) {
        const sameFile = others.some((x) => x.fc === move.fc);
        const sameRank = others.some((x) => x.fr === move.fr);
        dis = !sameFile
          ? FILES[move.fc]
          : !sameRank
            ? String(8 - move.fr)
            : `${FILES[move.fc]}${8 - move.fr}`;
      }
      txt = t.toUpperCase() + dis + (cap ? 'x' : '') + FILES[move.c] + (8 - move.r);
    }
  }

  const next = applyMove(state, move);
  if (isInCheck(next.b, next.turn)) {
    txt += getLegalMoves(next).length ? '+' : '#';
  }
  return txt;
}

export function toFEN(state) {
  const rows = state.b.map((row) => {
    let out = '';
    let empty = 0;
    for (const p of row) {
      if (!p) {
        empty++;
      } else {
        if (empty) {
          out += empty;
          empty = 0;
        }
        const ch = typeOf(p);
        out += colorOf(p) === 'w' ? ch.toUpperCase() : ch;
      }
    }
    if (empty) out += empty;
    return out;
  });

  const castle =
    (state.castle.wK ? 'K' : '') +
      (state.castle.wQ ? 'Q' : '') +
      (state.castle.bK ? 'k' : '') +
      (state.castle.bQ ? 'q' : '') || '-';

  const ep = state.ep ? coordsToSquare(state.ep.r, state.ep.c) : '-';
  return `${rows.join('/')} ${state.turn} ${castle} ${ep} ${state.half} ${state.full}`;
}

export function evaluateGameStatus(state, reps) {
  const legal = getLegalMoves(state);
  const check = isInCheck(state.b, state.turn);

  if (legal.length === 0) {
    if (check) {
      return {
        status: 'finished',
        outcome: 'checkmate',
        winner: otherColor(state.turn),
        inCheck: true,
      };
    }
    return {
      status: 'finished',
      outcome: 'stalemate',
      winner: null,
      inCheck: false,
    };
  }

  if (hasInsufficientMaterial(state.b)) {
    return {
      status: 'finished',
      outcome: 'insufficient_material',
      winner: null,
      inCheck: check,
    };
  }

  if (state.half >= 100) {
    return {
      status: 'finished',
      outcome: 'fifty_move_rule',
      winner: null,
      inCheck: check,
    };
  }

  if ((reps[positionKey(state)] || 0) >= 3) {
    return {
      status: 'finished',
      outcome: 'threefold_repetition',
      winner: null,
      inCheck: check,
    };
  }

  return {
    status: 'playing',
    outcome: null,
    winner: null,
    inCheck: check,
  };
}

/**
 * Validates and applies a candidate move against the current authoritative state.
 */
export function validateAndApplyMove(state, reps, rawMove) {
  const norm = normalizeMoveInput(rawMove);
  if (!norm) {
    return { ok: false, reason: 'Invalid move coordinates.' };
  }

  const legal = getLegalMoves(state);
  const match = legal.find(
    (m) =>
      m.fr === norm.fr &&
      m.fc === norm.fc &&
      m.r === norm.r &&
      m.c === norm.c &&
      (m.promo || null) === (norm.promo || null)
  );

  if (!match) {
    return { ok: false, reason: 'Illegal chess move.' };
  }

  const san = moveToSAN(state, match, legal);
  const nextState = applyMove(state, match);
  const nextReps = { ...reps };
  const key = positionKey(nextState);
  nextReps[key] = (nextReps[key] || 0) + 1;
  const evaluation = evaluateGameStatus(nextState, nextReps);

  const wireMove = {
    fr: match.fr,
    fc: match.fc,
    r: match.r,
    c: match.c,
    promo: match.promo || null,
    from: coordsToSquare(match.fr, match.fc),
    to: coordsToSquare(match.r, match.c),
    san,
  };

  return {
    ok: true,
    move: wireMove,
    state: nextState,
    reps: nextReps,
    fen: toFEN(nextState),
    evaluation,
  };
}
