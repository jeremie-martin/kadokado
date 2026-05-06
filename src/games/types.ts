export type GameMeta = {
  id: string;
  title: string;
  description: string;
  width: number;
  height: number;
};

export type GameInstance = {
  destroy(): void;
};

export type GameMetric = {
  key: string;
  label: string;
  value: number;
  unit?: string;
};

export type GameResult = {
  score: number;
  secondary?: GameMetric;
};

export type GameHost = {
  updateScore(score: number): void;
  updateMetric(metric: GameMetric): void;
  endRun(result?: Partial<GameResult>): void;
};

export type GameMountContext = {
  host?: GameHost;
  onReady?: (game: unknown) => void;
};

export const noopGameHost: GameHost = {
  updateScore() {},
  updateMetric() {},
  endRun() {},
};

export type GameModule = {
  mount(container: HTMLElement, context?: GameMountContext): Promise<GameInstance>;
};
