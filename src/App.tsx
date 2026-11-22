import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  apply,
  chooseAI,
  color,
  files,
  inCheck,
  insufficient,
  kingPos,
  legalMoves,
  posKey,
  sanOf,
  startState,
  type,
  values,
  type ChessState,
  type Color,
  type Difficulty,
  type Move,
  type PieceCode,
  type PieceType,
  type PromoType,
} from './game/chessEngine';
import { PieceDefs, PieceSvg } from './components/ChessPiece';

type Screen = 'menu' | 'lobby' | 'game';
type GameMode = 'ai' | 'local' | 'online';
type SideChoice = 'w' | 'b' | 'random';

interface Snapshot {
  S: ChessState;
  lastMove: Move | null;
  reps: Record<string, number>;
  caps: { w: PieceType[]; b: PieceType[] };
}

interface ResultInfo {
  iconType: 'piece' | 'text';
  piece?: PieceCode;
  textIcon?: string;
  title: string;
  text: string;
}

interface GhostCapture {
  key: number;
  r: number;
  c: number;
  piece: PieceCode;
}

interface SlideAnim {
  key: number;
  moves: { fr: number; fc: number; r: number; c: number }[];
}

interface DragState {
  r: number;
  c: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  wasSelected: boolean;
  piece: PieceCode;
  size: number;
}

interface NetState {
  name: string;
  room: string | null;
  token: string | null;
  opp: string | null;
  ready: boolean;
  oppOnline: boolean;
  conn: 'ok' | 'retry' | 'failed';
  retry: number;
  drawIn: boolean;
  drawOut: boolean;
  rematchOut: boolean;
  rematchIn: boolean;
}

interface WireMove {
  fr: number;
  fc: number;
  r: number;
  c: number;
  promo?: PromoType | null;
}

const PROMO_NAMES: Record<PromoType, string> = {
  q: 'Queen',
  r: 'Rook',
  b: 'Bishop',
  n: 'Knight',
};

const MAX_RETRY = 8;

function getSameOriginWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3000/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, val: string): void {
    try {
      localStorage.setItem(key, val);
    } catch {
      // Ignore storage errors in private browsing
    }
  },
};

function createInitialNet(savedName: string): NetState {
  return {
    name: savedName,
    room: null,
    token: null,
    opp: null,
    ready: false,
    oppOnline: true,
    conn: 'ok',
    retry: 0,
    drawIn: false,
    drawOut: false,
    rematchOut: false,
    rematchIn: false,
  };
}

function createInitialReps(s: ChessState): Record<string, number> {
  return { [posKey(s)]: 1 };
}

export default function App() {
  // Navigation & menu preferences
  const [screen, setScreen] = useState<Screen>('menu');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [sideChoice, setSideChoice] = useState<SideChoice>('w');
  const [newColor, setNewColor] = useState<SideChoice>('random');
  const [playerNameInput, setPlayerNameInput] = useState<string>(() => storage.get('cm_name') || '');
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [lobbyMsg, setLobbyMsg] = useState<{ text: string; err: boolean }>({ text: '', err: false });

  // Core game state
  const [mode, setMode] = useState<GameMode>('ai');
  const [human, setHuman] = useState<Color>('w');
  const [flipped, setFlipped] = useState<boolean>(false);
  const [S, setS] = useState<ChessState>(() => startState());
  const [states, setStates] = useState<Snapshot[]>([]);
  const [sans, setSans] = useState<string[]>([]);
  const [caps, setCaps] = useState<{ w: PieceType[]; b: PieceType[] }>({ w: [], b: [] });
  const [lastMove, setLastMove] = useState<Move | null>(null);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [legal, setLegal] = useState<Move[]>([]);
  const [reps, setReps] = useState<Record<string, number>>(() => createInitialReps(startState()));
  const [gameOver, setGameOver] = useState<boolean>(false);
  const [thinking, setThinking] = useState<boolean>(false);
  const [animating, setAnimating] = useState<boolean>(false);

  // Dialogs, banners & ephemeral UI
  const [pendingPromo, setPendingPromo] = useState<{ fr: number; fc: number; r: number; c: number } | null>(null);
  const [resultModal, setResultModal] = useState<ResultInfo | null>(null);
  const [resultOpen, setResultOpen] = useState<boolean>(false);
  const [waitOpen, setWaitOpen] = useState<boolean>(false);
  const [resignArmed, setResignArmed] = useState<boolean>(false);
  const [toastMsg, setToastMsg] = useState<string>('');
  const [toastVisible, setToastVisible] = useState<boolean>(false);
  const [ghost, setGhost] = useState<GhostCapture | null>(null);
  const [slideAnim, setSlideAnim] = useState<SlideAnim | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Online multiplayer state
  const [net, setNet] = useState<NetState>(() => createInitialNet(storage.get('cm_name') || 'Player'));

  // Mutable refs to keep async callbacks (WebSocket, Web Worker, timers, drag) 100% consistent
  const modeRef = useRef<GameMode>(mode);
  const difficultyRef = useRef<Difficulty>(difficulty);
  const humanRef = useRef<Color>(human);
  const flippedRef = useRef<boolean>(flipped);
  const stateRef = useRef<ChessState>(S);
  const statesRef = useRef<Snapshot[]>(states);
  const sansRef = useRef<string[]>(sans);
  const capsRef = useRef<{ w: PieceType[]; b: PieceType[] }>(caps);
  const lastMoveRef = useRef<Move | null>(lastMove);
  const repsRef = useRef<Record<string, number>>(reps);
  const gameOverRef = useRef<boolean>(gameOver);
  const animatingRef = useRef<boolean>(animating);
  const thinkingRef = useRef<boolean>(thinking);
  const pendingPromoRef = useRef(pendingPromo);
  const netRef = useRef<NetState>(net);
  const dragRef = useRef<DragState | null>(drag);
  const selectedRef = useRef(selected);
  const legalRef = useRef(legal);

  modeRef.current = mode;
  difficultyRef.current = difficulty;
  humanRef.current = human;
  flippedRef.current = flipped;
  stateRef.current = S;
  statesRef.current = states;
  sansRef.current = sans;
  capsRef.current = caps;
  lastMoveRef.current = lastMove;
  repsRef.current = reps;
  gameOverRef.current = gameOver;
  animatingRef.current = animating;
  thinkingRef.current = thinking;
  pendingPromoRef.current = pendingPromo;
  netRef.current = net;
  dragRef.current = drag;
  selectedRef.current = selected;
  legalRef.current = legal;

  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const drawOutTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const resignTimerRef = useRef<number | null>(null);
  const aiTimerRef = useRef<number | null>(null);
  const animTimerRef = useRef<number | null>(null);
  const ghostTimerRef = useRef<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const aiIdRef = useRef<number>(0);
  const genRef = useRef<number>(0);

  const boardRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const promoFirstBtnRef = useRef<HTMLButtonElement | null>(null);
  const sqRefs = useRef<(HTMLDivElement | null)[][]>(
    Array.from({ length: 8 }, () => Array<HTMLDivElement | null>(8).fill(null))
  );

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastVisible(true);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastVisible(false), 2800);
  }, []);

  const copyText = useCallback(
    (txt: string) => {
      const ok = () => showToast('Copied to clipboard');
      const fallback = () => {
        const a = document.createElement('textarea');
        a.value = txt;
        a.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(a);
        a.select();
        try {
          document.execCommand('copy');
          ok();
        } catch {
          showToast(txt);
        }
        a.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok, fallback);
      } else {
        fallback();
      }
    },
    [showToast]
  );

  const disarmResign = useCallback(() => {
    if (resignTimerRef.current) {
      window.clearTimeout(resignTimerRef.current);
      resignTimerRef.current = null;
    }
    setResignArmed(false);
  }, []);

  const netOpen = useCallback(() => {
    return !!wsRef.current && wsRef.current.readyState === WebSocket.OPEN;
  }, []);

  const netSend = useCallback(
    (obj: Record<string, unknown>) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            room: netRef.current.room || undefined,
            ...obj,
          })
        );
      }
    },
    []
  );

  const cancelPending = useCallback(() => {
    genRef.current++;
    aiIdRef.current++;
    if (aiTimerRef.current) {
      window.clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }
    if (animTimerRef.current) {
      window.clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }
    if (ghostTimerRef.current) {
      window.clearTimeout(ghostTimerRef.current);
      ghostTimerRef.current = null;
    }
    if (thinkingRef.current && workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    thinkingRef.current = false;
    animatingRef.current = false;
    pendingPromoRef.current = null;
    dragRef.current = null;
    setThinking(false);
    setAnimating(false);
    setPendingPromo(null);
    setDrag(null);
    setSlideAnim(null);
    setGhost(null);
    disarmResign();
  }, [disarmResign]);

  const resetBoardState = useCallback(() => {
    const fresh = startState();
    const freshReps = createInitialReps(fresh);
    stateRef.current = fresh;
    statesRef.current = [];
    sansRef.current = [];
    capsRef.current = { w: [], b: [] };
    lastMoveRef.current = null;
    repsRef.current = freshReps;
    gameOverRef.current = false;
    selectedRef.current = null;
    legalRef.current = [];

    setS(fresh);
    setStates([]);
    setSans([]);
    setCaps({ w: [], b: [] });
    setLastMove(null);
    setSelected(null);
    setLegal([]);
    setReps(freshReps);
    setGameOver(false);
    setResultModal(null);
    setResultOpen(false);
  }, []);

  const endGame = useCallback(
    (info: ResultInfo) => {
      gameOverRef.current = true;
      setGameOver(true);
      setResultModal(info);
      setResultOpen(true);
      setSelected(null);
      setLegal([]);
      disarmResign();
    },
    [disarmResign]
  );

  // Forward declarations via refs for mutual recursion (play -> afterMove -> requestAI -> play)
  const playRef = useRef<(m: Move, opt?: { animate?: boolean; remote?: boolean }) => boolean>(() => false);
  const afterMoveRef = useRef<() => void>(() => {});

  const onAIResult = useCallback((id: number, m: Move | null) => {
    if (id !== aiIdRef.current || !thinkingRef.current) return;
    thinkingRef.current = false;
    setThinking(false);
    if (m && !gameOverRef.current) {
      playRef.current(m, { animate: true });
    }
  }, []);

  const makeWorker = useCallback((): Worker | null => {
    try {
      const w = new Worker(new URL('./game/ai.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; m: Move | null }>) => {
        onAIResult(e.data.id, e.data.m);
      };
      w.onerror = () => {
        if (workerRef.current === w) {
          workerRef.current = null;
          if (thinkingRef.current) {
            const id = aiIdRef.current;
            aiTimerRef.current = window.setTimeout(() => {
              onAIResult(id, chooseAI(stateRef.current, difficultyRef.current));
            }, 20);
          }
        }
      };
      return w;
    } catch {
      return null;
    }
  }, [onAIResult]);

  const requestAI = useCallback(() => {
    thinkingRef.current = true;
    setThinking(true);
    const id = ++aiIdRef.current;
    if (!workerRef.current) {
      workerRef.current = makeWorker();
    }
    if (workerRef.current) {
      workerRef.current.postMessage({ id, s: stateRef.current, diff: difficultyRef.current });
    } else {
      aiTimerRef.current = window.setTimeout(() => {
        if (id === aiIdRef.current) {
          onAIResult(id, chooseAI(stateRef.current, difficultyRef.current));
        }
      }, 40);
    }
  }, [makeWorker, onAIResult]);

  const checkEnd = useCallback((): boolean => {
    const cur = stateRef.current;
    const ms = legalMoves(cur);
    const chk = inCheck(cur.b, cur.turn);
    if (!ms.length) {
      if (chk) {
        const win: Color = cur.turn === 'w' ? 'b' : 'w';
        const m = modeRef.current;
        const who =
          m === 'local'
            ? `${win === 'w' ? 'White' : 'Black'} wins the game.`
            : win === humanRef.current
              ? 'You win!'
              : `${m === 'ai' ? 'Computer' : netRef.current.opp || 'Opponent'} wins.`;
        endGame({
          iconType: 'piece',
          piece: `${win}q` as PieceCode,
          title: 'Checkmate',
          text: who,
        });
      } else {
        endGame({
          iconType: 'text',
          textIcon: '½',
          title: 'Draw',
          text: 'Stalemate — neither player can move.',
        });
      }
      return true;
    }
    if (insufficient(cur.b)) {
      endGame({
        iconType: 'text',
        textIcon: '½',
        title: 'Draw',
        text: 'Insufficient material to checkmate.',
      });
      return true;
    }
    if (cur.half >= 100) {
      endGame({
        iconType: 'text',
        textIcon: '½',
        title: 'Draw',
        text: 'The 50-move rule applies.',
      });
      return true;
    }
    if ((repsRef.current[posKey(cur)] || 0) >= 3) {
      endGame({
        iconType: 'text',
        textIcon: '½',
        title: 'Draw',
        text: 'Threefold repetition.',
      });
      return true;
    }
    return false;
  }, [endGame]);

  const afterMove = useCallback(() => {
    if (gameOverRef.current) return;
    const ended = checkEnd();
    if (!ended && modeRef.current === 'ai' && stateRef.current.turn !== humanRef.current) {
      const g = genRef.current;
      aiTimerRef.current = window.setTimeout(() => {
        if (g === genRef.current) requestAI();
      }, 120);
    }
  }, [checkEnd, requestAI]);

  afterMoveRef.current = afterMove;

  const play = useCallback(
    (m: Move, opt: { animate?: boolean; remote?: boolean } = {}): boolean => {
      const cur = stateRef.current;
      const legalNow = legalMoves(cur);
      const real = legalNow.find(
        (x) =>
          x.fr === m.fr &&
          x.fc === m.fc &&
          x.r === m.r &&
          x.c === m.c &&
          (x.promo || '') === (m.promo || '')
      );
      if (!real) return false;

      const p = cur.b[real.fr][real.fc]!;
      const capP = real.enpassant ? cur.b[real.fr][real.c] : cur.b[real.r][real.c];

      const nextStates: Snapshot[] = [
        ...statesRef.current,
        {
          S: cur,
          lastMove: lastMoveRef.current,
          reps: { ...repsRef.current },
          caps: { w: capsRef.current.w.slice(), b: capsRef.current.b.slice() },
        },
      ];

      const san = sanOf(cur, real, legalNow);
      const nextSans = [...sansRef.current, san];
      const nextCaps = { w: capsRef.current.w.slice(), b: capsRef.current.b.slice() };
      if (capP) {
        nextCaps[color(p)!].push(type(capP)!);
      }

      const nextS = apply(cur, real);
      const k = posKey(nextS);
      const nextReps = { ...repsRef.current, [k]: (repsRef.current[k] || 0) + 1 };

      stateRef.current = nextS;
      statesRef.current = nextStates;
      sansRef.current = nextSans;
      capsRef.current = nextCaps;
      lastMoveRef.current = real;
      repsRef.current = nextReps;
      selectedRef.current = null;
      legalRef.current = [];

      setS(nextS);
      setStates(nextStates);
      setSans(nextSans);
      setCaps(nextCaps);
      setLastMove(real);
      setSelected(null);
      setLegal([]);
      setReps(nextReps);

      if (modeRef.current === 'online' && !opt.remote) {
        if (drawOutTimerRef.current) {
          window.clearTimeout(drawOutTimerRef.current);
          drawOutTimerRef.current = null;
        }
        setNet((prev) => ({ ...prev, drawOut: false, drawIn: false }));
        netSend({
          type: 'move',
          ply: nextSans.length,
          move: {
            fr: real.fr,
            fc: real.fc,
            r: real.r,
            c: real.c,
            promo: real.promo || null,
          },
          san,
        });
      }

      if (opt.animate !== false) {
        const slides: { fr: number; fc: number; r: number; c: number }[] = [
          { fr: real.fr, fc: real.fc, r: real.r, c: real.c },
        ];
        if (real.castle === 'K') slides.push({ fr: real.r, fc: 7, r: real.r, c: 5 });
        if (real.castle === 'Q') slides.push({ fr: real.r, fc: 0, r: real.r, c: 3 });

        const animKey = Date.now() + Math.random();
        animatingRef.current = true;
        setAnimating(true);
        setSlideAnim({ key: animKey, moves: slides });

        if (capP) {
          const cr = real.enpassant ? real.fr : real.r;
          setGhost({ key: animKey, r: cr, c: real.c, piece: capP });
          if (ghostTimerRef.current) window.clearTimeout(ghostTimerRef.current);
          ghostTimerRef.current = window.setTimeout(() => setGhost(null), 340);
        }

        const g = genRef.current;
        if (animTimerRef.current) window.clearTimeout(animTimerRef.current);
        animTimerRef.current = window.setTimeout(() => {
          if (g !== genRef.current) return;
          animatingRef.current = false;
          setAnimating(false);
          setSlideAnim(null);
          afterMoveRef.current();
        }, 300);
      } else {
        afterMoveRef.current();
      }
      return true;
    },
    [netSend]
  );

  playRef.current = play;

  // Apply GPU-accelerated slide transition right after DOM commits for animated moves
  useLayoutEffect(() => {
    if (!slideAnim) return;
    const sq0 = sqRefs.current[0]?.[0];
    if (!sq0) return;
    const sz = sq0.getBoundingClientRect().width;
    const sgn = flippedRef.current ? -1 : 1;

    const animatedEls: SVGSVGElement[] = [];
    for (const mv of slideAnim.moves) {
      const cell = sqRefs.current[mv.r]?.[mv.c];
      const pe = cell?.querySelector<SVGSVGElement>('.pc');
      if (!pe) continue;
      pe.style.transition = 'none';
      pe.style.transform = `translate(${(mv.fc - mv.c) * sz * sgn}px, ${(mv.fr - mv.r) * sz * sgn}px)`;
      pe.classList.add('moving');
      pe.getBoundingClientRect();
      pe.style.transition = '';
      pe.style.transform = 'translate(0, 0)';
      animatedEls.push(pe);
    }

    return () => {
      for (const pe of animatedEls) {
        pe.classList.remove('moving');
        pe.style.transform = '';
        pe.style.transition = '';
      }
    };
  }, [slideAnim]);

  // Auto-scroll move history to bottom when new moves arrive
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [sans.length]);

  const initialGame = useCallback(() => {
    cancelPending();
    resetBoardState();
    afterMoveRef.current();
  }, [cancelPending, resetBoardState]);

  const startLocalOrAI = useCallback(
    (m: 'ai' | 'local') => {
      const h: Color = sideChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : sideChoice;
      modeRef.current = m;
      humanRef.current = h;
      const shouldFlip = m === 'ai' && h === 'b';
      flippedRef.current = shouldFlip;

      setMode(m);
      setHuman(h);
      setFlipped(shouldFlip);
      setScreen('game');
      cancelPending();
      resetBoardState();
      // Trigger AI first move if playing as Black vs Computer
      window.setTimeout(() => afterMoveRef.current(), 0);
    },
    [cancelPending, resetBoardState, sideChoice]
  );

  // ---- Online WebSocket lifecycle ----
  const closeWsOnly = useCallback(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (pingTimerRef.current) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (drawOutTimerRef.current) {
      window.clearTimeout(drawOutTimerRef.current);
      drawOutTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
    }
  }, []);

  const leaveOnline = useCallback(() => {
    netSend({ type: 'leave' });
    closeWsOnly();
    const freshNet = createInitialNet(storage.get('cm_name') || 'Player');
    netRef.current = freshNet;
    setNet(freshNet);
    setWaitOpen(false);
    modeRef.current = 'local';
    setMode('local');
  }, [closeWsOnly, netSend]);

  const toMenu = useCallback(() => {
    if (modeRef.current === 'online') {
      leaveOnline();
    }
    cancelPending();
    setResultOpen(false);
    setWaitOpen(false);
    setScreen('menu');
  }, [cancelPending, leaveOnline]);

  const enterOnline = useCallback(
    (col: Color, keepFlip: boolean) => {
      modeRef.current = 'online';
      humanRef.current = col;
      setMode('online');
      setHuman(col);
      if (!keepFlip) {
        flippedRef.current = col === 'b';
        setFlipped(col === 'b');
      }
      setScreen('game');
      setNet((prev) => ({ ...prev, rematchOut: false, rematchIn: false }));
      cancelPending();
      resetBoardState();
    },
    [cancelPending, resetBoardState]
  );

  const loadMovesFromServer = useCallback(
    (
      list: WireMove[],
      meta?: { status?: string; outcome?: string | null; winner?: Color | null; draw_offer_by?: Color | null }
    ) => {
      cancelPending();
      resetBoardState();
      for (const mv of list) {
        playRef.current(
          { fr: mv.fr, fc: mv.fc, r: mv.r, c: mv.c, promo: mv.promo || undefined },
          { animate: false, remote: true }
        );
        if (gameOverRef.current) break;
      }
      // Restore server-recorded resignation / agreed draw if reconnecting to a finished game
      if (!gameOverRef.current && meta?.status === 'finished') {
        if (meta.outcome === 'resign' && meta.winner) {
          const iWon = meta.winner === humanRef.current;
          endGame({
            iconType: 'piece',
            piece: `${meta.winner}q` as PieceCode,
            title: iWon ? 'Opponent resigned' : 'Resigned',
            text: iWon
              ? 'You win by resignation.'
              : `${netRef.current.opp || 'Opponent'} wins by resignation.`,
          });
        } else if (meta.outcome === 'draw_agreed') {
          endGame({
            iconType: 'text',
            textIcon: '½',
            title: 'Draw',
            text: 'Draw agreed.',
          });
        }
      }
      // Restore pending draw offer state on reconnect
      if (meta && 'draw_offer_by' in meta) {
        const offerBy = meta.draw_offer_by;
        setNet((prev) => ({
          ...prev,
          drawIn: !!offerBy && offerBy !== humanRef.current,
          drawOut: !!offerBy && offerBy === humanRef.current,
        }));
      }
    },
    [cancelPending, endGame, resetBoardState]
  );

  const handleRemoteMove = useCallback(
    (mv: WireMove | undefined, expectedGen: number) => {
      if (!mv || gameOverRef.current || expectedGen !== genRef.current) return;
      if (animatingRef.current) {
        window.setTimeout(() => handleRemoteMove(mv, expectedGen), 120);
        return;
      }
      if (stateRef.current.turn === humanRef.current) {
        netSend({ type: 'sync' });
        return;
      }
      const before = sansRef.current.length;
      playRef.current(
        { fr: mv.fr, fc: mv.fc, r: mv.r, c: mv.c, promo: mv.promo || undefined },
        { animate: true, remote: true }
      );
      if (sansRef.current.length === before) {
        netSend({ type: 'sync' });
      }
    },
    [netSend]
  );

  const onNetMessage = useCallback(
    (m: Record<string, unknown>) => {
      switch (m.type) {
        case 'created': {
          const room = String(m.room);
          const token = String(m.token);
          const col = m.color as Color;
          const updated: NetState = {
            ...netRef.current,
            room,
            token,
            opp: null,
            ready: false,
            oppOnline: false,
            conn: 'ok',
            retry: 0,
            drawIn: false,
            drawOut: false,
            rematchOut: false,
            rematchIn: false,
          };
          netRef.current = updated;
          setNet(updated);
          enterOnline(col, false);
          setWaitOpen(true);
          break;
        }
        case 'joined': {
          const wasOnline = modeRef.current === 'online' && !!netRef.current.room;
          const col = m.color as Color;
          const opp = (m.opponent as string) || null;
          const ready = !!opp;
          const updated: NetState = {
            ...netRef.current,
            room: String(m.room || netRef.current.room || ''),
            token: String(m.token || netRef.current.token || ''),
            opp,
            ready,
            oppOnline: m.opponent_online !== false,
            conn: 'ok',
            retry: 0,
          };
          netRef.current = updated;
          setNet(updated);
          enterOnline(col, wasOnline);
          loadMovesFromServer((m.moves as WireMove[]) || [], {
            status: m.status as string | undefined,
            outcome: (m.outcome as string | null | undefined) ?? null,
            winner: (m.winner as Color | null | undefined) ?? null,
            draw_offer_by: (m.draw_offer_by as Color | null | undefined) ?? null,
          });
          setWaitOpen(!ready);
          if (wasOnline) showToast('Reconnected');
          break;
        }
        case 'sync': {
          loadMovesFromServer((m.moves as WireMove[]) || [], {
            status: m.status as string | undefined,
            outcome: (m.outcome as string | null | undefined) ?? null,
            winner: (m.winner as Color | null | undefined) ?? null,
            draw_offer_by: (m.draw_offer_by as Color | null | undefined) ?? null,
          });
          break;
        }
        case 'opponent_joined': {
          const oppName = String(m.name || 'Opponent');
          setNet((prev) => ({ ...prev, opp: oppName, ready: true, oppOnline: true }));
          setWaitOpen(false);
          showToast(`${oppName} joined`);
          break;
        }
        case 'opponent_left': {
          setNet((prev) => ({ ...prev, oppOnline: false }));
          break;
        }
        case 'opponent_back': {
          setNet((prev) => ({ ...prev, oppOnline: true }));
          showToast(`${netRef.current.opp || 'Opponent'} is back`);
          break;
        }
        case 'move': {
          handleRemoteMove(m.move as WireMove | undefined, genRef.current);
          break;
        }
        case 'resign': {
          if (!gameOverRef.current) {
            endGame({
              iconType: 'piece',
              piece: `${humanRef.current}q` as PieceCode,
              title: 'Opponent resigned',
              text: 'You win by resignation.',
            });
          }
          break;
        }
        case 'draw_offer': {
          if (!gameOverRef.current) {
            setNet((prev) => ({ ...prev, drawIn: true }));
            showToast('Draw offered');
          }
          break;
        }
        case 'draw_accept': {
          if (!gameOverRef.current) {
            setNet((prev) => ({ ...prev, drawIn: false, drawOut: false }));
            endGame({
              iconType: 'text',
              textIcon: '½',
              title: 'Draw',
              text: 'Draw agreed.',
            });
          }
          break;
        }
        case 'draw_decline': {
          setNet((prev) => ({ ...prev, drawOut: false }));
          showToast('Draw offer declined');
          break;
        }
        case 'rematch_request': {
          setNet((prev) => ({ ...prev, rematchIn: true }));
          showToast(`${netRef.current.opp || 'Opponent'} wants a rematch`);
          break;
        }
        case 'rematch': {
          const newCol = m.color as Color;
          humanRef.current = newCol;
          flippedRef.current = newCol === 'b';
          setHuman(newCol);
          setFlipped(newCol === 'b');
          setNet((prev) => ({
            ...prev,
            drawIn: false,
            drawOut: false,
            rematchOut: false,
            rematchIn: false,
          }));
          initialGame();
          break;
        }
        case 'error': {
          const message = String(m.message || 'Server error');
          if (m.fatal) {
            toMenu();
            showToast(message || 'Room is no longer available');
          } else if (modeRef.current === 'online' && netRef.current.room) {
            showToast(message);
          } else {
            setLobbyMsg({ text: message, err: true });
          }
          break;
        }
      }
    },
    [endGame, enterOnline, handleRemoteMove, initialGame, loadMovesFromServer, showToast, toMenu]
  );

  const connectOnline = useCallback(
    (firstMessage?: Record<string, unknown>) => {
      closeWsOnly();
      let ws: WebSocket;
      try {
        ws = new WebSocket(getSameOriginWsUrl());
      } catch {
        setLobbyMsg({ text: 'Could not open connection to server.', err: true });
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setNet((prev) => ({ ...prev, conn: 'ok', retry: 0 }));
        if (firstMessage) {
          ws.send(JSON.stringify(firstMessage));
        } else if (netRef.current.room && netRef.current.token) {
          ws.send(
            JSON.stringify({
              type: 'rejoin',
              room: netRef.current.room,
              token: netRef.current.token,
              name: netRef.current.name,
            })
          );
        }
        if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (evt) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        onNetMessage(parsed);
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (pingTimerRef.current) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (modeRef.current === 'online' && netRef.current.room) {
          const nextRetry = netRef.current.retry + 1;
          if (nextRetry <= MAX_RETRY) {
            setNet((prev) => ({ ...prev, conn: 'retry', retry: nextRetry }));
            retryTimerRef.current = window.setTimeout(
              () => connectOnline(),
              Math.min(1000 * nextRetry, 6000)
            );
          } else {
            setNet((prev) => ({ ...prev, conn: 'failed' }));
          }
        } else {
          setLobbyMsg({
            text: 'Could not reach the game server. Please try again.',
            err: true,
          });
        }
      };
    },
    [closeWsOnly, onNetMessage]
  );

  // Support invite links (?room=ABCDE) on initial load
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const roomParam = q.get('room');
    if (roomParam) {
      setJoinCodeInput(roomParam.toUpperCase().slice(0, 8));
      setLobbyMsg({ text: 'Enter your name and press “Join room”.', err: false });
      setScreen('lobby');
    }
  }, []);

  // Cleanup everything on unmount
  useEffect(() => {
    return () => {
      cancelPending();
      closeWsOnly();
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [cancelPending, closeWsOnly]);

  // ---- Interaction: click and drag-and-drop ----
  const canInteract = useCallback(() => {
    return (
      !gameOverRef.current &&
      !animatingRef.current &&
      !pendingPromoRef.current &&
      !thinkingRef.current &&
      (modeRef.current === 'local' || stateRef.current.turn === humanRef.current) &&
      (modeRef.current !== 'online' || (netRef.current.ready && netOpen()))
    );
  }, [netOpen]);

  const tryMove = useCallback(
    (cand: Move[], viaDrag: boolean) => {
      if (cand[0].promo) {
        const p = { fr: cand[0].fr, fc: cand[0].fc, r: cand[0].r, c: cand[0].c };
        pendingPromoRef.current = p;
        setPendingPromo(p);
        return;
      }
      play(cand[0], { animate: !viaDrag });
    },
    [play]
  );

  const handleSquarePointerDown = (e: React.PointerEvent<HTMLDivElement>, r: number, c: number) => {
    if (e.button > 0 || !canInteract()) return;
    const p = stateRef.current.b[r][c];

    if (selectedRef.current) {
      const cand = legalRef.current.filter((x) => x.r === r && x.c === c);
      if (cand.length) {
        tryMove(cand, false);
        return;
      }
    }

    if (color(p) === stateRef.current.turn && p) {
      const wasSelected = !!selectedRef.current && selectedRef.current.r === r && selectedRef.current.c === c;
      const nextLegal = legalMoves(stateRef.current).filter((x) => x.fr === r && x.fc === c);
      selectedRef.current = { r, c };
      legalRef.current = nextLegal;
      setSelected({ r, c });
      setLegal(nextLegal);

      const sz = sqRefs.current[r]?.[c]?.getBoundingClientRect().width || 64;
      const nextDrag: DragState = {
        r,
        c,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        wasSelected,
        piece: p,
        size: sz,
      };
      dragRef.current = nextDrag;
      setDrag(nextDrag);
    } else {
      selectedRef.current = null;
      legalRef.current = [];
      setSelected(null);
      setLegal([]);
    }
  };

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 7) return;
      }
      const next: DragState = { ...d, moved: true, x: e.clientX, y: e.clientY };
      dragRef.current = next;
      setDrag(next);
    };

    const endDrag = (e: PointerEvent, cancelled: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDrag(null);
      if (d.moved) {
        if (!cancelled) {
          const target = document.elementFromPoint(e.clientX, e.clientY);
          const sq = target?.closest?.('#board .sq') as HTMLElement | null;
          if (sq && sq.dataset.r !== undefined && sq.dataset.c !== undefined) {
            const tr = Number(sq.dataset.r);
            const tc = Number(sq.dataset.c);
            const cand = legalRef.current.filter((x) => x.r === tr && x.c === tc);
            if (cand.length) {
              tryMove(cand, true);
              return;
            }
          }
        }
      } else if (d.wasSelected && !cancelled) {
        selectedRef.current = null;
        legalRef.current = [];
        setSelected(null);
        setLegal([]);
      }
    };

    const onUp = (e: PointerEvent) => endDrag(e, false);
    const onCancel = (e: PointerEvent) => endDrag(e, true);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [tryMove]);

  // Promotion keyboard shortcuts (Q / R / B / N / Escape) + auto-focus first button
  const choosePromo = useCallback(
    (t: PromoType) => {
      const pm = pendingPromoRef.current;
      if (!pm) return;
      pendingPromoRef.current = null;
      setPendingPromo(null);
      play({ ...pm, promo: t }, { animate: true });
    },
    [play]
  );

  const cancelPromo = useCallback(() => {
    pendingPromoRef.current = null;
    setPendingPromo(null);
  }, []);

  useEffect(() => {
    if (!pendingPromo) return;
    promoFirstBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k.length === 1 && 'qrbn'.includes(k) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        choosePromo(k as PromoType);
      } else if (e.key === 'Escape') {
        cancelPromo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingPromo, choosePromo, cancelPromo]);

  // ---- Topbar & lobby actions ----
  const handleCreateRoom = () => {
    const cleanName = playerNameInput.trim().slice(0, 16) || 'Player';
    storage.set('cm_name', cleanName);
    setNet((prev) => ({ ...prev, name: cleanName }));
    netRef.current = { ...netRef.current, name: cleanName };
    setLobbyMsg({ text: 'Connecting…', err: false });
    connectOnline({ type: 'create', name: cleanName, color: newColor });
  };

  const handleJoinRoom = () => {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) {
      setLobbyMsg({ text: 'Enter a room code.', err: true });
      return;
    }
    const cleanName = playerNameInput.trim().slice(0, 16) || 'Player';
    storage.set('cm_name', cleanName);
    setNet((prev) => ({ ...prev, name: cleanName }));
    netRef.current = { ...netRef.current, name: cleanName };
    setLobbyMsg({ text: 'Connecting…', err: false });
    connectOnline({ type: 'join', room: code, name: cleanName });
  };

  const canUndo =
    mode === 'local' ? states.length > 0 : mode === 'ai' ? states.some((x) => x.S.turn === human) : false;

  const handleUndo = () => {
    if (!canUndo) return;
    cancelPending();
    let idx = -1;
    if (mode === 'local') {
      idx = statesRef.current.length - 1;
    } else {
      for (let i = statesRef.current.length - 1; i >= 0; i--) {
        if (statesRef.current[i].S.turn === humanRef.current) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) return;

    const st = statesRef.current[idx];
    const nextStates = statesRef.current.slice(0, idx);
    const nextSans = sansRef.current.slice(0, idx);

    stateRef.current = st.S;
    statesRef.current = nextStates;
    sansRef.current = nextSans;
    lastMoveRef.current = st.lastMove;
    repsRef.current = st.reps;
    capsRef.current = st.caps;
    gameOverRef.current = false;
    selectedRef.current = null;
    legalRef.current = [];

    setS(st.S);
    setStates(nextStates);
    setSans(nextSans);
    setLastMove(st.lastMove);
    setReps(st.reps);
    setCaps(st.caps);
    setSelected(null);
    setLegal([]);
    setGameOver(false);
    setResultOpen(false);
    setResultModal(null);

    if (mode === 'ai' && st.S.turn !== humanRef.current) {
      afterMoveRef.current();
    }
  };

  const handleResign = () => {
    if (gameOverRef.current) return;
    if (!resignArmed) {
      setResignArmed(true);
      resignTimerRef.current = window.setTimeout(disarmResign, 3000);
      return;
    }
    disarmResign();
    cancelPending();
    const loser: Color = modeRef.current !== 'local' ? humanRef.current : stateRef.current.turn;
    const win: Color = loser === 'w' ? 'b' : 'w';
    if (modeRef.current === 'online') {
      netSend({ type: 'resign' });
    }
    const who =
      modeRef.current === 'ai'
        ? 'Computer wins by resignation.'
        : modeRef.current === 'online'
          ? `${netRef.current.opp || 'Opponent'} wins by resignation.`
          : `${win === 'w' ? 'White' : 'Black'} wins by resignation.`;
    endGame({
      iconType: 'piece',
      piece: `${win}q` as PieceCode,
      title: 'Resigned',
      text: who,
    });
  };

  const handleOfferDraw = () => {
    if (gameOver || !net.ready || net.drawOut) return;
    setNet((prev) => ({ ...prev, drawOut: true }));
    netSend({ type: 'draw_offer' });
    showToast('Draw offer sent');
    if (drawOutTimerRef.current) window.clearTimeout(drawOutTimerRef.current);
    drawOutTimerRef.current = window.setTimeout(() => {
      setNet((prev) => ({ ...prev, drawOut: false }));
    }, 20000);
  };

  const handlePlayAgain = () => {
    if (mode === 'online') {
      netSend({ type: 'rematch' });
      setNet((prev) => ({ ...prev, rematchOut: true }));
    } else {
      initialGame();
    }
  };

  const inviteLink = () => {
    const base =
      window.location.origin && window.location.origin !== 'null'
        ? `${window.location.origin}${window.location.pathname}`
        : window.location.href.split(/[?#]/)[0];
    return `${base}?room=${encodeURIComponent(net.room || '')}`;
  };

  // ---- Derived display helpers ----
  const playerLabel = (col: Color) => {
    if (mode === 'local') return col === 'w' ? 'White' : 'Black';
    if (mode === 'online') {
      return `${col === human ? 'You' : net.opp || 'Opponent'} (${col === 'w' ? 'White' : 'Black'})`;
    }
    return col === human
      ? `You (${col === 'w' ? 'White' : 'Black'})`
      : `Computer · ${difficulty[0].toUpperCase() + difficulty.slice(1)}`;
  };

  const material = (col: Color) => {
    let t = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = S.b[r][c];
        if (p && color(p) === col && type(p) !== 'k') {
          t += values[type(p)!];
        }
      }
    }
    return t;
  };

  const renderPlayerBar = (col: Color) => {
    const opp: Color = col === 'w' ? 'b' : 'w';
    const sortedCaps = caps[col].slice().sort((a, b) => values[b] - values[a]);
    const diff = Math.round((material(col) - material(opp)) / 100);
    const active = !gameOver && S.turn === col;

    return (
      <div className={`player${active ? ' active' : ''}`}>
        <span className="pdot" />
        <span>{playerLabel(col)}</span>
        <span className="caps">
          {sortedCaps.map((pt, idx) => (
            <PieceSvg key={`${col}-${pt}-${idx}`} code={`${opp}${pt}` as PieceCode} />
          ))}
        </span>
        <span className="adv">{diff > 0 ? `+${diff}` : ''}</span>
      </div>
    );
  };

  let turnText: string;
  if (gameOver) {
    turnText = 'Game over';
  } else if (mode === 'online' && !net.ready) {
    turnText = 'Waiting for opponent…';
  } else if (thinking) {
    turnText = 'Computer is thinking…';
  } else {
    turnText = `${S.turn === 'w' ? 'White' : 'Black'} to move`;
    if (mode !== 'local' && S.turn === human) turnText += ' — your turn';
    if (inCheck(S.b, S.turn)) turnText += ' — check!';
  }

  const modeText =
    mode === 'local'
      ? 'Local 2 Player'
      : mode === 'online'
        ? `Online · Room ${net.room || '…'}`
        : 'vs Computer';

  const chkPos = !gameOver && inCheck(S.b, S.turn) ? kingPos(S.b, S.turn) : null;
  const topCol: Color = flipped ? 'w' : 'b';
  const botCol: Color = flipped ? 'b' : 'w';

  // Netbar content
  let netBarText = '';
  let netBarActions: { label: string; onClick: () => void }[] = [];
  if (mode === 'online') {
    if (net.conn === 'retry') {
      netBarText = `Connection lost — reconnecting (${net.retry}/${MAX_RETRY})…`;
    } else if (net.conn === 'failed') {
      netBarText = 'Disconnected from the server.';
      netBarActions = [
        {
          label: 'Retry',
          onClick: () => {
            setNet((prev) => ({ ...prev, retry: 0, conn: 'retry' }));
            connectOnline();
          },
        },
      ];
    } else if (net.drawIn && !gameOver) {
      netBarText = `${net.opp || 'Opponent'} offers a draw.`;
      netBarActions = [
        {
          label: 'Accept',
          onClick: () => {
            setNet((prev) => ({ ...prev, drawIn: false }));
            netSend({ type: 'draw_accept' });
            endGame({ iconType: 'text', textIcon: '½', title: 'Draw', text: 'Draw agreed.' });
          },
        },
        {
          label: 'Decline',
          onClick: () => {
            setNet((prev) => ({ ...prev, drawIn: false }));
            netSend({ type: 'draw_decline' });
          },
        },
      ];
    } else if (!net.oppOnline && net.ready && !gameOver) {
      netBarText = `${net.opp || 'Opponent'} disconnected — waiting for them to come back…`;
    }
  }

  // Move history pairs
  const moveRows: { num: number; w: string; b: string; lastW: boolean; lastB: boolean }[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    moveRows.push({
      num: i / 2 + 1,
      w: sans[i],
      b: sans[i + 1] || '',
      lastW: i === sans.length - 1,
      lastB: i + 1 === sans.length - 1,
    });
  }

  return (
    <>
      <PieceDefs />

      {/* MAIN MENU */}
      {screen === 'menu' && (
        <main className="menu">
          <section className="menu-card">
            <div className="logo">
              <PieceSvg code="wn" />
              <span style={{ color: 'inherit' }}>
                Chess<span>Master</span>
              </span>
            </div>
            <p className="tag">Think ahead. Play beautifully.</p>
            <div className="menu-actions">
              <button type="button" className="action" onClick={() => startLocalOrAI('ai')}>
                <PieceSvg code="wp" />
                <span>
                  <strong>Play vs Computer</strong>
                  <small>Challenge the engine</small>
                </span>
              </button>
              <button
                type="button"
                className="action"
                onClick={() => {
                  setLobbyMsg({ text: '', err: false });
                  setScreen('lobby');
                }}
              >
                <PieceSvg code="wq" />
                <span>
                  <strong>Online Multiplayer</strong>
                  <small>Play a friend on another device</small>
                </span>
              </button>
              <button type="button" className="action" onClick={() => startLocalOrAI('local')}>
                <PieceSvg code="bk" />
                <span>
                  <strong>Local 2 Player</strong>
                  <small>Pass and play on one device</small>
                </span>
              </button>
            </div>
            <div className="settings">
              <label>
                Difficulty
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
              <label>
                Play as
                <select
                  value={sideChoice}
                  onChange={(e) => setSideChoice(e.target.value as SideChoice)}
                >
                  <option value="w">White</option>
                  <option value="b">Black</option>
                  <option value="random">Random</option>
                </select>
              </label>
            </div>
          </section>
        </main>
      )}

      {/* ONLINE LOBBY */}
      {screen === 'lobby' && (
        <main className="menu">
          <section className="menu-card">
            <div className="logo" style={{ fontSize: 'clamp(30px, 8vw, 42px)' }}>
              Online<span>Play</span>
            </div>
            <p className="tag">Create a room and share the code, or join a friend&apos;s room.</p>
            <div className="settings">
              <label>
                Your name
                <input
                  value={playerNameInput}
                  onChange={(e) => setPlayerNameInput(e.target.value)}
                  maxLength={16}
                  autoComplete="off"
                  placeholder="Player"
                />
              </label>
            </div>
            <div className="settings">
              <div className="lobby-row">
                <select
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value as SideChoice)}
                >
                  <option value="random">Random</option>
                  <option value="w">White</option>
                  <option value="b">Black</option>
                </select>
                <button type="button" className="primary" onClick={handleCreateRoom}>
                  Create room
                </button>
              </div>
            </div>
            <div className="settings">
              <div className="lobby-row">
                <input
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleJoinRoom();
                  }}
                  maxLength={8}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="ROOM CODE"
                />
                <button type="button" className="primary" onClick={handleJoinRoom}>
                  Join room
                </button>
              </div>
            </div>
            <div className={`lobby-msg${lobbyMsg.err ? ' err' : ''}`}>{lobbyMsg.text}</div>
            <button
              type="button"
              className="btn back"
              onClick={() => {
                closeWsOnly();
                setScreen('menu');
              }}
            >
              ← Back
            </button>
          </section>
        </main>
      )}

      {/* GAME SCREEN */}
      {screen === 'game' && (
        <main className="shell">
          <header className="topbar">
            <div className="brand">
              <PieceSvg code="wn" />
              <span>
                Chess<b>Master</b>
              </span>
            </div>
            <div className="top-actions">
              {mode !== 'online' && (
                <button type="button" className="btn" disabled={!canUndo} onClick={handleUndo}>
                  ↶ Undo
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => setFlipped((f) => !f)}
              >
                ⇅ Flip
              </button>
              {mode === 'online' && (
                <button
                  type="button"
                  className="btn"
                  disabled={gameOver || !net.ready || net.drawOut}
                  onClick={handleOfferDraw}
                >
                  ½ Draw
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={gameOver}
                onClick={handleResign}
              >
                {resignArmed ? 'Sure?' : 'Resign'}
              </button>
              {mode !== 'online' && (
                <button type="button" className="btn" onClick={initialGame}>
                  Restart
                </button>
              )}
              {gameOver && !resultOpen && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => setResultOpen(true)}
                >
                  {mode === 'online' ? 'Rematch' : 'Result'}
                </button>
              )}
              <button type="button" className="btn" onClick={toMenu}>
                Menu
              </button>
            </div>
          </header>

          <div className="layout">
            <section className="board-col">
              <div className="status">
                <div className="turn">
                  <span
                    className={`dot${thinking ? ' thinking' : ''}`}
                    style={{ background: S.turn === 'w' ? '#f5f7fb' : '#65e6b0' }}
                  />
                  <span>{turnText}</span>
                </div>
                <span className="tip">{modeText}</span>
              </div>

              {netBarText && (
                <div className="netbar">
                  <span>{netBarText}</span>
                  {netBarActions.length > 0 && (
                    <span className="acts">
                      {netBarActions.map((act) => (
                        <button key={act.label} type="button" onClick={act.onClick}>
                          {act.label}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              )}

              {renderPlayerBar(topCol)}

              <div className="board-wrap">
                <div
                  id="board"
                  ref={boardRef}
                  className="board"
                  role="application"
                  aria-label="Chess board"
                >
                  {Array.from({ length: 64 }).map((_, idx) => {
                    const i = Math.floor(idx / 8);
                    const j = idx % 8;
                    const r = flipped ? 7 - i : i;
                    const c = flipped ? 7 - j : j;
                    const p = S.b[r][c];
                    const isLast =
                      lastMove &&
                      ((lastMove.fr === r && lastMove.fc === c) ||
                        (lastMove.r === r && lastMove.c === c));
                    const isSel = selected && selected.r === r && selected.c === c;
                    const isChk = chkPos && chkPos[0] === r && chkPos[1] === c;
                    const lm = legal.find((x) => x.r === r && x.c === c);
                    const isDragSource = drag?.moved && drag.r === r && drag.c === c;

                    let cls = `sq ${(r + c) % 2 ? 'dark' : 'light'}`;
                    if (isLast) cls += ' last';
                    if (isSel) cls += ' selected';
                    if (isChk) cls += ' check';
                    if (lm) cls += p || lm.enpassant ? ' legal capture' : ' legal';

                    return (
                      <div
                        key={`${r}-${c}`}
                        ref={(el) => {
                          sqRefs.current[r][c] = el;
                        }}
                        className={cls}
                        data-r={r}
                        data-c={c}
                        onPointerDown={(e) => handleSquarePointerDown(e, r, c)}
                      >
                        {j === 0 && <span className="notation rank">{8 - r}</span>}
                        {i === 7 && <span className="notation file">{files[c]}</span>}
                        {ghost && ghost.r === r && ghost.c === c && (
                          <span key={ghost.key} className="ghost-piece">
                            <PieceSvg code={ghost.piece} />
                          </span>
                        )}
                        {p && (
                          <PieceSvg
                            code={p}
                            style={isDragSource ? { opacity: 0.25 } : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {renderPlayerBar(botCol)}
            </section>

            <aside className="side">
              <section className="panel">
                <h2>Move history</h2>
                <div ref={historyRef} className="history">
                  {moveRows.map((row) => (
                    <div key={row.num} className="move">
                      <span className="num">{row.num}.</span>
                      <span className={row.lastW ? 'cur' : ''}>{row.w}</span>
                      <span className={row.lastB ? 'cur' : ''}>{row.b}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="panel tip">
                <strong>How to play</strong>
                <p>
                  Click a piece, then a highlighted square — or drag and drop. Captures are ringed.
                  When a pawn reaches the last rank you choose what it becomes (or press Q / R / B /
                  N).
                </p>
              </section>
            </aside>
          </div>
        </main>
      )}

      {/* FLOATING DRAG PIECE */}
      {drag?.moved && (
        <div
          className="drag-float"
          style={{
            width: drag.size,
            height: drag.size,
            left: drag.x,
            top: drag.y,
          }}
        >
          <PieceSvg code={drag.piece} />
        </div>
      )}

      {/* RESULT MODAL */}
      <div className={`modal${resultOpen && resultModal ? ' open' : ''}`}>
        {resultModal && (
          <div className="result">
            <div className="big">
              {resultModal.iconType === 'piece' && resultModal.piece ? (
                <PieceSvg code={resultModal.piece} />
              ) : (
                resultModal.textIcon
              )}
            </div>
            <h2>{resultModal.title}</h2>
            <p>{resultModal.text}</p>
            <button
              type="button"
              className="primary"
              disabled={mode === 'online' && net.rematchOut}
              onClick={handlePlayAgain}
            >
              {mode === 'online'
                ? net.rematchOut
                  ? 'Waiting for opponent…'
                  : net.rematchIn
                    ? 'Accept rematch'
                    : 'Play again'
                : 'Play again'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setResultOpen(false)}
            >
              View board
            </button>
            <button type="button" className="secondary" onClick={toMenu}>
              Main menu
            </button>
          </div>
        )}
      </div>

      {/* WAITING FOR OPPONENT MODAL */}
      <div className={`modal${waitOpen ? ' open' : ''}`}>
        <div className="result">
          <div className="tip">Room code</div>
          <div className="code">{net.room || '----'}</div>
          <p>
            Share this code or the invite link with your friend. The game starts as soon as they
            join.
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => copyText(inviteLink())}
          >
            Copy invite link
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => copyText(net.room || '')}
          >
            Copy code
          </button>
          <button type="button" className="secondary" onClick={toMenu}>
            Cancel
          </button>
        </div>
      </div>

      {/* PAWN PROMOTION DIALOG */}
      <div
        className={`promo${pendingPromo ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="promoTitle"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) cancelPromo();
        }}
      >
        <div className="promo-box">
          <h3 id="promoTitle">Promote your pawn</h3>
          <p className="sub">Choose a piece</p>
          <div className="promo-grid">
            {(['q', 'r', 'b', 'n'] as PromoType[]).map((pt, idx) => (
              <button
                key={pt}
                ref={idx === 0 ? promoFirstBtnRef : undefined}
                type="button"
                aria-label={PROMO_NAMES[pt]}
                onClick={() => choosePromo(pt)}
              >
                <PieceSvg code={`${S.turn}${pt}` as PieceCode} />
                <span>{PROMO_NAMES[pt]}</span>
                <kbd>{pt.toUpperCase()}</kbd>
              </button>
            ))}
          </div>
          <button type="button" className="promo-cancel" onClick={cancelPromo}>
            Cancel move
          </button>
        </div>
      </div>

      {/* TOAST */}
      <div className={`toast${toastVisible ? ' show' : ''}`} role="status">
        {toastMsg}
      </div>
    </>
  );
}
