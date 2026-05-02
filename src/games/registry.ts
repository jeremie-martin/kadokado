import type { GameMeta, GameModule } from './types';

type RegistryEntry = {
  meta: GameMeta;
  load: () => Promise<GameModule>;
};

export const GAMES: RegistryEntry[] = [
  {
    meta: {
      id: 'interwheel',
      title: 'Interwheel',
      description: 'One-button blob jumping between spinning mine-studded wheels.',
      width: 300,
      height: 300,
    },
    load: () => import('./interwheel'),
  },
];

export function findGame(id: string): RegistryEntry | undefined {
  return GAMES.find((entry) => entry.meta.id === id);
}
