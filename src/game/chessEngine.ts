export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PromoType = 'q' | 'r' | 'b' | 'n';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'master';
export type PieceCode = `${Color}${PieceType}`;
export type Board = (PieceCode | null)[][];

export interface CastleRights {
  wK: boolean;
  wQ: boolean;
  bK: boolean;
  bQ: boolean;
}

export interface ChessState {
  b: Board;
  turn: Color;
  ep: { r: number; c: number } | null;
  castle: CastleRights;
  half: number;
}

export interface Move {
  fr: number;
  fc: number;
  r: number;
  c: number;
  promo?: PromoType;
  double?: boolean;
  enpassant?: boolean;
  castle?: 'K' | 'Q';
}

export const values: Record<PieceType, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

export const files = 'abcdefgh';

const KN: [number, number][] = [
  [1, 2], [2, 1], [-1, 2], [-2, 1],
  [1, -2], [2, -1], [-1, -2], [-2, -1],
];
const ROOK: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISH: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function color(p: PieceCode | null | undefined): Color | undefined {
  return p ? (p[0] as Color) : undefined;
}

export function type(p: PieceCode | null | undefined): PieceType | undefined {
  return p ? (p[1] as PieceType) : undefined;
}

function inside(r: number, c: number): boolean {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function cloneB(b: Board): Board {
  return b.map((r) => r.slice());
}

export function startState(): ChessState {
  return {
    b: [
      ['br', 'bn', 'bb', 'bq', 'bk', 'bb', 'bn', 'br'],
      Array<PieceCode | null>(8).fill('bp'),
      ...Array.from({ length: 4 }, () => Array<PieceCode | null>(8).fill(null)),
      Array<PieceCode | null>(8).fill('wp'),
      ['wr', 'wn', 'wb', 'wq', 'wk', 'wb', 'wn', 'wr'],
    ],
    turn: 'w',
    ep: null,
    castle: { wK: true, wQ: true, bK: true, bQ: true },
    half: 0,
  };
}

export function attacked(b: Board, r: number, c: number, by: Color): boolean {
  const dp = by === 'w' ? 1 : -1;
  for (const dc of [-1, 1]) {
    const R = r + dp;
    const C = c + dc;
    if (inside(R, C) && b[R][C] === `${by}p`) return true;
  }
  for (const [x, y] of KN) {
    const R = r + x;
    const C = c + y;
    if (inside(R, C) && b[R][C] === `${by}n`) return true;
  }
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const R = r + dr;
      const C = c + dc;
      if (inside(R, C) && b[R][C] === `${by}k`) return true;
    }
  }
  for (const [dr, dc] of ROOK) {
    let R = r + dr;
    let C = c + dc;
    while (inside(R, C)) {
      const p = b[R][C];
      if (p) {
        if (p === `${by}r` || p === `${by}q`) return true;
        break;
      }
      R += dr;
      C += dc;
    }
  }
  for (const [dr, dc] of BISH) {
    let R = r + dr;
    let C = c + dc;
    while (inside(R, C)) {
      const p = b[R][C];
      if (p) {
        if (p === `${by}b` || p === `${by}q`) return true;
        break;
      }
      R += dr;
      C += dc;
    }
  }
  return false;
}

export function kingPos(b: Board, col: Color): [number, number] | null {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (b[r][c] === `${col}k`) return [r, c];
    }
  }
  return null;
}

export function inCheck(b: Board, col: Color): boolean {
  const k = kingPos(b, col);
  if (!k) return true;
  return attacked(b, k[0], k[1], col === 'w' ? 'b' : 'w');
}

function pseudo(s: ChessState, r: number, c: number): Move[] {
  const b = s.b;
  const p = b[r][c];
  const col = color(p);
  const t = type(p);
  if (!p || !col || !t) return [];
  const opp: Color = col === 'w' ? 'b' : 'w';
  const out: Move[] = [];

  const add = (R: number, C: number, extra?: Partial<Move>): boolean => {
    if (!inside(R, C) || color(b[R][C]) === col) return false;
    out.push({ fr: r, fc: c, r: R, c: C, ...(extra || {}) });
    return !b[R][C];
  };

  if (t === 'p') {
    const d = col === 'w' ? -1 : 1;
    const last = col === 'w' ? 0 : 7;
    const push = (R: number, C: number, extra?: Partial<Move>) => {
      if (R === last) {
        for (const pr of ['q', 'r', 'b', 'n'] as PromoType[]) {
          out.push({ fr: r, fc: c, r: R, c: C, promo: pr, ...(extra || {}) });
        }
      } else {
        out.push({ fr: r, fc: c, r: R, c: C, ...(extra || {}) });
      }
    };
    if (inside(r + d, c) && !b[r + d][c]) {
      push(r + d, c);
      if (r === (col === 'w' ? 6 : 1) && !b[r + 2 * d][c]) {
        push(r + 2 * d, c, { double: true });
      }
    }
    for (const dc of [-1, 1]) {
      const R = r + d;
      const C = c + dc;
      if (!inside(R, C)) continue;
      if (b[R][C] && color(b[R][C]) === opp) {
        push(R, C);
      } else if (!b[R][C] && s.ep && s.ep.r === R && s.ep.c === C && b[r][C] === `${opp}p`) {
        push(R, C, { enpassant: true });
      }
    }
  } else if (t === 'n') {
    for (const x of KN) add(r + x[0], c + x[1]);
  } else if (t === 'k') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr || dc) add(r + dr, c + dc);
      }
    }
    const row = col === 'w' ? 7 : 0;
    if (r === row && c === 4 && b[row][4] === `${col}k` && !attacked(b, row, 4, opp)) {
      if (
        s.castle[`${col}K` as keyof CastleRights] &&
        b[row][7] === `${col}r` &&
        !b[row][5] &&
        !b[row][6] &&
        !attacked(b, row, 5, opp) &&
        !attacked(b, row, 6, opp)
      ) {
        out.push({ fr: r, fc: c, r: row, c: 6, castle: 'K' });
      }
      if (
        s.castle[`${col}Q` as keyof CastleRights] &&
        b[row][0] === `${col}r` &&
        !b[row][1] &&
        !b[row][2] &&
        !b[row][3] &&
        !attacked(b, row, 3, opp) &&
        !attacked(b, row, 2, opp)
      ) {
        out.push({ fr: r, fc: c, r: row, c: 2, castle: 'Q' });
      }
    }
  } else {
    const dirs = t === 'b' ? BISH : t === 'r' ? ROOK : BISH.concat(ROOK);
    for (const [dr, dc] of dirs) {
      let R = r + dr;
      let C = c + dc;
      while (inside(R, C)) {
        if (!add(R, C)) break;
        R += dr;
        C += dc;
      }
    }
  }
  return out;
}

export function apply(s: ChessState, m: Move): ChessState {
  const n = cloneB(s.b);
  const p = n[m.fr][m.fc]!;
  const col = color(p)!;
  const target = n[m.r][m.c];
  const castle: CastleRights = { ...s.castle };

  n[m.fr][m.fc] = null;
  n[m.r][m.c] = p;

  if (m.enpassant) n[m.fr][m.c] = null;
  if (m.castle === 'K') {
    n[m.r][5] = n[m.r][7];
    n[m.r][7] = null;
  }
  if (m.castle === 'Q') {
    n[m.r][3] = n[m.r][0];
    n[m.r][0] = null;
  }
  if (type(p) === 'p' && (m.r === 0 || m.r === 7)) {
    n[m.r][m.c] = `${col}${m.promo || 'q'}` as PieceCode;
  }
  if (type(p) === 'k') {
    castle[`${col}K` as keyof CastleRights] = false;
    castle[`${col}Q` as keyof CastleRights] = false;
  }
  if (type(p) === 'r') {
    const hr = col === 'w' ? 7 : 0;
    if (m.fr === hr && m.fc === 0) castle[`${col}Q` as keyof CastleRights] = false;
    if (m.fr === hr && m.fc === 7) castle[`${col}K` as keyof CastleRights] = false;
  }
  if (type(target) === 'r') {
    const oc = color(target)!;
    const hr = oc === 'w' ? 7 : 0;
    if (m.r === hr && m.c === 0) castle[`${oc}Q` as keyof CastleRights] = false;
    if (m.r === hr && m.c === 7) castle[`${oc}K` as keyof CastleRights] = false;
  }

  const ep =
    type(p) === 'p' && Math.abs(m.r - m.fr) === 2
      ? { r: (m.r + m.fr) / 2, c: m.fc }
      : null;
  const reset = type(p) === 'p' || !!target || !!m.enpassant;

  return {
    b: n,
    turn: s.turn === 'w' ? 'b' : 'w',
    ep,
    castle,
    half: reset ? 0 : s.half + 1,
  };
}

export function legalMoves(s: ChessState): Move[] {
  const out: Move[] = [];
  const col = s.turn;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (color(s.b[r][c]) === col) {
        for (const m of pseudo(s, r, c)) {
          if (!inCheck(apply(s, m).b, col)) out.push(m);
        }
      }
    }
  }
  return out;
}

export function posKey(s: ChessState): string {
  let epk = '-';
  if (s.ep) {
    const col = s.turn;
    const d = col === 'w' ? 1 : -1;
    for (const dc of [-1, 1]) {
      const R = s.ep.r + d;
      const C = s.ep.c + dc;
      if (inside(R, C) && s.b[R][C] === `${col}p`) {
        const m: Move = { fr: R, fc: C, r: s.ep.r, c: s.ep.c, enpassant: true };
        if (!inCheck(apply(s, m).b, col)) {
          epk = `${s.ep.r}${s.ep.c}`;
          break;
        }
      }
    }
  }
  return (
    s.b.map((r) => r.map((p) => p || '..').join('')).join('/') +
    s.turn +
    (s.castle.wK ? 'K' : '') +
    (s.castle.wQ ? 'Q' : '') +
    (s.castle.bK ? 'k' : '') +
    (s.castle.bQ ? 'q' : '') +
    epk
  );
}

export function insufficient(b: Board): boolean {
  const minors: { t: PieceType; col: Color; sq: number }[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = b[r][c];
      if (!p) continue;
      const t = type(p)!;
      if (t === 'k') continue;
      if (t === 'p' || t === 'r' || t === 'q') return false;
      minors.push({ t, col: color(p)!, sq: (r + c) % 2 });
    }
  }
  if (minors.length <= 1) return true;
  if (minors.every((x) => x.t === 'b') && minors.every((x) => x.sq === minors[0].sq)) return true;
  return false;
}

export function sanOf(s: ChessState, m: Move, legal: Move[]): string {
  const p = s.b[m.fr][m.fc]!;
  const t = type(p)!;
  let txt: string;
  if (m.castle) {
    txt = m.castle === 'K' ? 'O-O' : 'O-O-O';
  } else {
    const cap = !!s.b[m.r][m.c] || !!m.enpassant;
    if (t === 'p') {
      txt = (cap ? `${files[m.fc]}x` : '') + files[m.c] + (8 - m.r) + (m.promo ? `=${m.promo.toUpperCase()}` : '');
    } else {
      let dis = '';
      const others = legal.filter(
        (x) =>
          x !== m &&
          x.r === m.r &&
          x.c === m.c &&
          type(s.b[x.fr][x.fc]) === t &&
          !(x.fr === m.fr && x.fc === m.fc)
      );
      if (others.length) {
        const sameFile = others.some((x) => x.fc === m.fc);
        const sameRank = others.some((x) => x.fr === m.fr);
        dis = !sameFile ? files[m.fc] : !sameRank ? String(8 - m.fr) : files[m.fc] + (8 - m.fr);
      }
      txt = t.toUpperCase() + dis + (cap ? 'x' : '') + files[m.c] + (8 - m.r);
    }
  }
  const n = apply(s, m);
  if (inCheck(n.b, n.turn)) txt += legalMoves(n).length ? '+' : '#';
  return txt;
}

export function moveToUci(m: Move): string {
  return `${files[m.fc]}${8 - m.fr}${files[m.c]}${8 - m.r}${m.promo || ''}`;
}

export function uciToMove(s: ChessState, uci: string): Move | null {
  const clean = (uci || '').trim().toLowerCase();
  if (clean.length < 4 || clean === '(none)' || clean === '0000') return null;
  const fc = files.indexOf(clean[0]);
  const fr = 8 - parseInt(clean[1], 10);
  const c = files.indexOf(clean[2]);
  const r = 8 - parseInt(clean[3], 10);
  const promoChar = clean[4] as PromoType | undefined;
  const promo: PromoType | undefined =
    promoChar && 'qrbn'.includes(promoChar) ? promoChar : undefined;
  if (fc < 0 || c < 0 || Number.isNaN(fr) || Number.isNaN(r)) return null;
  const all = legalMoves(s);
  return (
    all.find(
      (m) =>
        m.fr === fr &&
        m.fc === fc &&
        m.r === r &&
        m.c === c &&
        (m.promo || '') === (promo || '')
    ) || null
  );
}

export function stateToFen(s: ChessState, fullMove = 1): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    let row = '';
    for (let c = 0; c < 8; c++) {
      const p = s.b[r][c];
      if (!p) {
        empty++;
      } else {
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        const ch = p[1];
        row += p[0] === 'w' ? ch.toUpperCase() : ch;
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  const castling =
    (s.castle.wK ? 'K' : '') +
      (s.castle.wQ ? 'Q' : '') +
      (s.castle.bK ? 'k' : '') +
      (s.castle.bQ ? 'q' : '') || '-';
  const ep = s.ep ? `${files[s.ep.c]}${8 - s.ep.r}` : '-';
  return `${rows.join('/')} ${s.turn} ${castling} ${ep} ${s.half} ${Math.max(1, fullMove)}`;
}

// ---- AI (fallback JS engine when Stockfish is unavailable) ----
const MATE = 100000;
const PST: Record<string, number[]> = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  K: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
};

function evaluate(s: ChessState): number {
  let score = 0;
  let nonPawn = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = s.b[r][c];
      if (!p) continue;
      const t = type(p)!;
      if (t !== 'p' && t !== 'k') nonPawn += values[t];
    }
  }
  const endgame = nonPawn <= 2400;
  let wb = 0;
  let bb = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = s.b[r][c];
      if (!p) continue;
      const t = type(p)!;
      const w = color(p) === 'w';
      const idx = (w ? r : 7 - r) * 8 + c;
      let v = t === 'k' ? 0 : values[t];
      v += PST[t === 'k' && endgame ? 'K' : t][idx];
      if (t === 'b') {
        if (w) wb++;
        else bb++;
      }
      score += w ? v : -v;
    }
  }
  if (wb >= 2) score += 30;
  if (bb >= 2) score -= 30;
  return score;
}

function evalSide(s: ChessState): number {
  return (s.turn === 'w' ? 1 : -1) * evaluate(s);
}

function ordered(s: ChessState, ms: Move[]): Move[] {
  return ms
    .map((m): [number, Move] => {
      const t = s.b[m.r][m.c];
      let k = 0;
      if (t) k = values[type(t)!] * 10 - values[type(s.b[m.fr][m.fc])!];
      else if (m.enpassant) k = 900;
      if (m.promo === 'q') k += 8000;
      return [k, m];
    })
    .sort((a, b) => b[0] - a[0])
    .map((x) => x[1]);
}

let nodes = 0;
let deadline = 0;
let stopped = false;

function tick(): boolean {
  if ((++nodes & 1023) === 0 && Date.now() > deadline) stopped = true;
  return stopped;
}

function searchMoves(s: ChessState): Move[] {
  return legalMoves(s).filter((m) => !m.promo || m.promo === 'q' || m.promo === 'n');
}

function qsearch(s: ChessState, alpha: number, beta: number, ply: number, qd: number): number {
  if (tick()) return 0;
  if (s.half >= 100 || insufficient(s.b)) return 0;
  const all = searchMoves(s);
  const chk = inCheck(s.b, s.turn);
  if (!all.length) return chk ? -MATE + ply : 0;
  let best: number;
  let moves: Move[];
  if (chk && qd < 4) {
    best = -MATE + ply;
    moves = all;
  } else {
    const stand = evalSide(s);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (qd >= 8) return stand;
    best = stand;
    moves = all.filter((m) => s.b[m.r][m.c] || m.enpassant || m.promo === 'q');
  }
  for (const m of ordered(s, moves)) {
    const v = -qsearch(apply(s, m), -beta, -alpha, ply + 1, qd + 1);
    if (stopped) return 0;
    if (v > best) {
      best = v;
      if (v > alpha) alpha = v;
    }
    if (alpha >= beta) break;
  }
  return best;
}

function search(s: ChessState, depth: number, alpha: number, beta: number, ply: number): number {
  if (tick()) return 0;
  if (s.half >= 100 || insufficient(s.b)) return 0;
  if (depth <= 0) return qsearch(s, alpha, beta, ply, 0);
  const ms = searchMoves(s);
  if (!ms.length) return inCheck(s.b, s.turn) ? -MATE + ply : 0;
  let best = -Infinity;
  for (const m of ordered(s, ms)) {
    const v = -search(apply(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (stopped) return 0;
    if (v > best) {
      best = v;
      if (v > alpha) alpha = v;
    }
    if (alpha >= beta) break;
  }
  return best;
}

function shuffle<T>(a: T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function chooseAI(s: ChessState, diff: Difficulty): Move | null {
  const all = legalMoves(s);
  if (!all.length) return null;
  const ms = all.filter((m) => !m.promo || m.promo === 'q');
  if (ms.length === 1) return ms[0];
  if (diff === 'easy') {
    let best: Move | null = null;
    let bv = -Infinity;
    for (const m of ms) {
      const n = apply(s, m);
      let v: number;
      if (inCheck(n.b, n.turn) && !legalMoves(n).length) v = MATE;
      else v = -evalSide(n) + Math.random() * 260;
      if (v > bv) {
        bv = v;
        best = m;
      }
    }
    return best;
  }
  const cfg =
    diff === 'master'
      ? { depth: 7, time: 2400, noise: 0 }
      : diff === 'hard'
        ? { depth: 6, time: 1800, noise: 0 }
        : { depth: 3, time: 700, noise: 14 };
  nodes = 0;
  stopped = false;
  deadline = Date.now() + cfg.time;
  let moves = ordered(s, shuffle(ms));
  let result: { m: Move; v: number }[] | null = null;

  for (let d = 1; d <= cfg.depth; d++) {
    const out: { m: Move; v: number }[] = [];
    let alpha = -Infinity;
    let ok = true;
    for (const m of moves) {
      const v = -search(apply(s, m), d - 1, -Infinity, cfg.noise ? Infinity : -alpha, 1);
      if (stopped) {
        ok = false;
        break;
      }
      out.push({ m, v });
      if (!cfg.noise && v > alpha) alpha = v;
    }
    if (!ok) break;
    out.sort((a, b) => b.v - a.v);
    result = out;
    moves = out.map((x) => x.m);
    if (out[0].v > MATE - 100) break;
  }
  if (!result) return ms[Math.floor(Math.random() * ms.length)];
  if (cfg.noise) {
    let best = result[0];
    let bv = -Infinity;
    for (const x of result) {
      const v = x.v + Math.random() * cfg.noise;
      if (v > bv) {
        bv = v;
        best = x;
      }
    }
    return best.m;
  }
  return result[0].m;
}
