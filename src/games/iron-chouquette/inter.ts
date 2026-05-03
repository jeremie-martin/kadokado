import type { Container } from 'pixi.js';
import type { IronChouquetteGame } from './game';

// Inter.mt is effectively unused by the shipped source: Game.mt never
// instantiates it. Keep a no-op shim so the port orchestrator can call
// update()/setGameOver() without drawing non-source HUD elements.

export class Inter {
  constructor(_game: IronChouquetteGame, _layer: Container) {}

  update(): void {}

  setGameOver(): void {}
}
