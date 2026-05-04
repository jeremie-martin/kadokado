// K-Slash entry point. Mirrors the launcher conventions used by the other
// games (interwheel, manda): create a Pixi Application, load assets, build
// the Game, drive a fixed-step accumulator, return a destroy() that
// exhaustively cleans up listeners and Pixi resources.

import { Application, Ticker } from 'pixi.js';
import { noopGameHost } from '../types';
import type { GameInstance, GameMountContext } from '../types';
import { STAGE_HEIGHT, STAGE_WIDTH, STEP_SECONDS } from './constants';
import { KSlashGame, loadAssets } from './game';

export async function mount(container: HTMLElement, context?: GameMountContext): Promise<GameInstance> {
  const app = new Application();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      background: '#000000',
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    }),
    loadAssets(),
  ]);
  container.appendChild(app.canvas);

  const game = new KSlashGame(app, assets, context?.host ?? noopGameHost);

  // Input: arrow keys + SPACE/CTRL for slash/throw, plus NIGHT_CODE sequence.
  const onKeyDown = (event: KeyboardEvent) => {
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        game.hero.input.left = true;
        break;
      case 'ArrowRight':
        game.hero.input.right = true;
        break;
      case 'ArrowUp':
        game.hero.input.up = true;
        break;
      case 'ArrowDown':
        game.hero.input.down = true;
        break;
      case ' ':
      case 'Spacebar':
      case 'Control':
        game.hero.input.shoot = true;
        break;
      default:
        handled = false;
    }
    // NIGHT_CODE = [78,73,71,72,84] = N,I,G,H,T. Drive the in-game state
    // machine that unlocks night mode, matching Game.pushKey in the source.
    if (event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0);
      game.pushKeyCode(code);
    }
    if (handled) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        game.hero.input.left = false;
        break;
      case 'ArrowRight':
        game.hero.input.right = false;
        break;
      case 'ArrowUp':
        game.hero.input.up = false;
        break;
      case 'ArrowDown':
        game.hero.input.down = false;
        break;
      case ' ':
      case 'Spacebar':
      case 'Control':
        game.hero.input.shoot = false;
        // Reset shoot-ready latch so a re-press triggers another attack.
        game.hero.flShootReady = true;
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  // Drop held inputs on focus loss — otherwise the hero keeps walking after
  // the tab loses focus mid-press.
  const onBlur = () => {
    game.hero.input.left = false;
    game.hero.input.right = false;
    game.hero.input.up = false;
    game.hero.input.down = false;
    game.hero.input.shoot = false;
    game.hero.flShootReady = true;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // Fixed-step accumulator. STEP_SECONDS = 1/40 (tentative — see FIDELITY).
  let acc = 0;
  const tickerCallback = (ticker: Ticker) => {
    acc += Math.min(ticker.deltaMS / 1000, 0.1);
    let guard = 0;
    while (acc >= STEP_SECONDS && guard < 5) {
      game.step();
      acc -= STEP_SECONDS;
      guard += 1;
    }
  };
  app.ticker.add(tickerCallback);

  return {
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      app.ticker.remove(tickerCallback);
      game.destroy();
      // texture:false — textures are owned by the global Assets cache. With
      // texture:true, every mount/destroy cycle would warn and force the next
      // mount to re-decode every PNG.
      app.destroy(true, { children: true, texture: false });
    },
  };
}
