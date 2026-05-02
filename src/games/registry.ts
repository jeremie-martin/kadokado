import type { GameMeta, GameModule } from './types';

type RegistryEntry = {
  meta: GameMeta;
  load: () => Promise<GameModule>;
};

export const GAMES: RegistryEntry[] = [];

export function findGame(id: string): RegistryEntry | undefined {
  return GAMES.find((entry) => entry.meta.id === id);
}
