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
  {
    meta: {
      id: 'pioupiou',
      title: 'Pioupiou',
      description: 'Climb falling blocks with arrow keys, dodge being crushed.',
      width: 300,
      height: 320,
    },
    load: () => import('./pioupiou'),
  },
  {
    meta: {
      id: 'manda',
      title: 'Manda',
      description: 'Angular snake with continuous rotation, fruits, and a slot-machine jackpot.',
      width: 300,
      height: 320,
    },
    load: () => import('./manda'),
  },
  {
    meta: {
      id: 'killbulle',
      title: 'Kill-Bulle',
      description: 'Single-screen grapple-and-blob arena. Aim up, fire, retract.',
      width: 300,
      height: 320,
    },
    load: () => import('./killbulle'),
  },
  {
    meta: {
      id: 'linea',
      title: 'Linea',
      description: 'Trace paths through dot grids; build x2/x3/x4 score multipliers.',
      width: 300,
      height: 300,
    },
    load: () => import('./linea'),
  },
  {
    meta: {
      id: 'alphabounce',
      title: 'Alphabounce',
      description: 'Breakout with letter power-ups and event-driven enemy waves.',
      width: 300,
      height: 320,
    },
    load: () => import('./alphabounce'),
  },
  {
    meta: {
      id: 'kslash',
      title: 'K-Slash',
      description: 'Side-scrolling slash + kunai action with multiple enemy types.',
      width: 300,
      height: 300,
    },
    load: () => import('./kslash'),
  },
  {
    meta: {
      id: 'iron-chouquette',
      title: 'Iron Chouquette',
      description: 'Vertical bullet-hell boss-rush with weapon types and parallax decor.',
      width: 300,
      height: 300,
    },
    load: () => import('./iron-chouquette'),
  },
];

export function findGame(id: string): RegistryEntry | undefined {
  return GAMES.find((entry) => entry.meta.id === id);
}
