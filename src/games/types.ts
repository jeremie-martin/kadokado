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

export type GameModule = {
  mount(container: HTMLElement): Promise<GameInstance>;
};
