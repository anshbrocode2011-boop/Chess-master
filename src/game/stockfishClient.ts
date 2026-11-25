import {
  chooseAI,
  stateToFen,
  uciToMove,
  type ChessState,
  type Difficulty,
  type Move,
} from './chessEngine';

interface DifficultyProfile {
  skill: number;
  depth: number;
  movetime: number;
  contempt: number;
}

const PROFILES: Record<Difficulty, DifficultyProfile> = {
  // Beginner friendly (~950 Elo): quick replies, human-like mistakes
  easy: { skill: 1, depth: 5, movetime: 250, contempt: 0 },
  // Strong club player (~1700 Elo): solid tactics and positional play
  medium: { skill: 9, depth: 10, movetime: 650, contempt: 10 },
  // Expert / Candidate Master (~2450 Elo): very accurate tactical & strategic moves
  hard: { skill: 16, depth: 14, movetime: 1250, contempt: 15 },
  // Full-strength Stockfish (~3100+ Elo): maximum accuracy, deep search
  master: { skill: 20, depth: 18, movetime: 2200, contempt: 24 },
};

interface ActiveJob {
  id: number;
  state: ChessState;
  uciMoves: string[];
  diff: Difficulty;
  newGame: boolean;
  phase: 'init' | 'ready' | 'searching';
  resolve: (move: Move | null) => void;
  timer: number | null;
}

function supportsWasm(): boolean {
  try {
    return (
      typeof WebAssembly === 'object' &&
      typeof WebAssembly.validate === 'function' &&
      WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00))
    );
  } catch {
    return false;
  }
}

/**
 * Race-free Stockfish UCI Web Worker manager.
 *
 * Uses official Stockfish compiled to WebAssembly (with automatic asm.js fallback
 * for older browsers such as Android 8.1 Chrome on low-end devices).
 * Falls back transparently to the local JS search worker if the engine cannot load.
 */
export class StockfishClient {
  private worker: Worker | null = null;
  private fallbackWorker: Worker | null = null;
  private uciReady = false;
  private failed = false;
  private lastSkill: number | null = null;
  private lastContempt: number | null = null;
  private jobSeq = 0;
  private activeJob: ActiveJob | null = null;
  private fallbackCallbacks = new Map<number, (m: Move | null) => void>();

  public warmUp(): void {
    if (this.failed || this.worker) return;
    this.ensureWorker();
  }

  public cancel(): void {
    this.jobSeq++;
    const job = this.activeJob;
    this.activeJob = null;
    if (job) {
      if (job.timer !== null) window.clearTimeout(job.timer);
      if (this.worker && job.phase === 'searching') {
        try {
          this.worker.postMessage('stop');
        } catch {
          // Ignore worker post errors
        }
      }
      job.resolve(null);
    }
    this.fallbackCallbacks.clear();
  }

  public newGame(): void {
    if (this.worker && this.uciReady) {
      try {
        this.worker.postMessage('ucinewgame');
      } catch {
        // Ignore
      }
    }
  }

  public destroy(): void {
    this.cancel();
    if (this.worker) {
      try {
        this.worker.postMessage('quit');
        this.worker.terminate();
      } catch {
        // Ignore
      }
      this.worker = null;
    }
    if (this.fallbackWorker) {
      try {
        this.fallbackWorker.terminate();
      } catch {
        // Ignore
      }
      this.fallbackWorker = null;
    }
    this.uciReady = false;
  }

  public requestMove(
    state: ChessState,
    uciMoves: string[],
    diff: Difficulty,
    newGame = false
  ): Promise<Move | null> {
    this.cancel();
    const id = ++this.jobSeq;

    if (this.failed || !this.ensureWorker()) {
      return this.runFallback(id, state, diff);
    }

    return new Promise<Move | null>((resolve) => {
      const profile = PROFILES[diff] || PROFILES.hard;
      const timeoutMs = profile.movetime + 5500;

      const job: ActiveJob = {
        id,
        state,
        uciMoves,
        diff,
        newGame,
        phase: this.uciReady ? 'ready' : 'init',
        resolve,
        timer: window.setTimeout(() => {
          if (this.activeJob?.id !== id) return;
          // If Stockfish timed out (e.g. failed to fetch wasm), stop & use fallback
          this.activeJob = null;
          if (!this.uciReady) {
            this.markFailed();
          } else {
            try {
              this.worker?.postMessage('stop');
            } catch {
              // Ignore
            }
          }
          this.runFallback(id, state, diff).then(resolve);
        }, timeoutMs),
      };

      this.activeJob = job;

      if (this.uciReady) {
        this.dispatchPositionAndReady(job);
      }
    });
  }

  private ensureWorker(): boolean {
    if (this.failed) return false;
    if (this.worker) return true;
    try {
      const scriptUrl = supportsWasm() ? '/engine/stockfish.wasm.js' : '/engine/stockfish.js';
      const w = new Worker(scriptUrl);
      w.onmessage = (e: MessageEvent<unknown>) => this.onEngineLine(String(e.data || ''));
      w.onerror = () => {
        if (this.worker === w) {
          this.markFailed();
        }
      };
      this.worker = w;
      this.uciReady = false;
      this.lastSkill = null;
      this.lastContempt = null;
      w.postMessage('uci');
      return true;
    } catch {
      this.markFailed();
      return false;
    }
  }

  private markFailed(): void {
    this.failed = true;
    this.uciReady = false;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore
      }
      this.worker = null;
    }
    const job = this.activeJob;
    if (job) {
      this.activeJob = null;
      if (job.timer !== null) window.clearTimeout(job.timer);
      this.runFallback(job.id, job.state, job.diff).then(job.resolve);
    }
  }

  private dispatchPositionAndReady(job: ActiveJob): void {
    const w = this.worker;
    if (!w) return;
    const profile = PROFILES[job.diff] || PROFILES.hard;

    try {
      w.postMessage('stop');
      if (job.newGame) {
        w.postMessage('ucinewgame');
      }
      if (this.lastSkill !== profile.skill) {
        w.postMessage(`setoption name Skill Level value ${profile.skill}`);
        this.lastSkill = profile.skill;
      }
      if (this.lastContempt !== profile.contempt) {
        w.postMessage(`setoption name Contempt value ${profile.contempt}`);
        this.lastContempt = profile.contempt;
      }

      if (job.uciMoves.length > 0) {
        w.postMessage(`position startpos moves ${job.uciMoves.join(' ')}`);
      } else {
        // Verify startpos vs custom FEN
        const fen = stateToFen(job.state, 1);
        if (fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0')) {
          w.postMessage('position startpos');
        } else {
          w.postMessage(`position fen ${fen}`);
        }
      }

      job.phase = 'ready';
      w.postMessage('isready');
    } catch {
      this.markFailed();
    }
  }

  private onEngineLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    if (line === 'uciok') {
      this.uciReady = true;
      try {
        // Keep hash table modest (16 MB) so low-RAM phones like Galaxy J2 Core stay fast
        this.worker?.postMessage('setoption name Hash value 16');
        this.worker?.postMessage('setoption name Ponder value false');
      } catch {
        // Ignore
      }
      if (this.activeJob && this.activeJob.phase === 'init') {
        this.dispatchPositionAndReady(this.activeJob);
      }
      return;
    }

    const job = this.activeJob;
    if (!job) return;

    if (line === 'readyok' && job.phase === 'ready') {
      const profile = PROFILES[job.diff] || PROFILES.hard;
      job.phase = 'searching';
      try {
        this.worker?.postMessage(`go depth ${profile.depth} movetime ${profile.movetime}`);
      } catch {
        this.markFailed();
      }
      return;
    }

    if (line.startsWith('bestmove ') && job.phase === 'searching') {
      const token = line.split(/\s+/)[1] || '';
      this.activeJob = null;
      if (job.timer !== null) window.clearTimeout(job.timer);

      const move = uciToMove(job.state, token);
      if (move) {
        job.resolve(move);
      } else {
        // Guard against any unexpected desync: fall back to legal local move
        this.runFallback(job.id, job.state, job.diff).then(job.resolve);
      }
    }
  }

  private runFallback(id: number, state: ChessState, diff: Difficulty): Promise<Move | null> {
    return new Promise<Move | null>((resolve) => {
      if (id !== this.jobSeq) {
        resolve(null);
        return;
      }
      if (!this.fallbackWorker) {
        try {
          const fw = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
          fw.onmessage = (e: MessageEvent<{ id: number; m: Move | null }>) => {
            const cb = this.fallbackCallbacks.get(e.data.id);
            if (cb) {
              this.fallbackCallbacks.delete(e.data.id);
              cb(e.data.id === this.jobSeq ? e.data.m : null);
            }
          };
          fw.onerror = () => {
            if (this.fallbackWorker === fw) {
              this.fallbackWorker = null;
            }
          };
          this.fallbackWorker = fw;
        } catch {
          this.fallbackWorker = null;
        }
      }

      if (this.fallbackWorker) {
        this.fallbackCallbacks.set(id, resolve);
        this.fallbackWorker.postMessage({ id, s: state, diff });
      } else {
        window.setTimeout(() => {
          resolve(id === this.jobSeq ? chooseAI(state, diff) : null);
        }, 20);
      }
    });
  }
}
