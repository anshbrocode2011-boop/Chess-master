import { chooseAI, type ChessState, type Difficulty } from './chessEngine';

self.onmessage = (e: MessageEvent<{ id: number; s: ChessState; diff: Difficulty }>) => {
  const { id, s, diff } = e.data;
  const m = chooseAI(s, diff);
  self.postMessage({ id, m });
};
