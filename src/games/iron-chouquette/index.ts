import { Application, Ticker } from 'pixi.js';
import type { GameInstance } from '../types';
import { STAGE_WIDTH, STAGE_HEIGHT, STEP_SECONDS } from './constants';
import { IronChouquetteGame, loadAssets } from './game';

// Multi-file Iron Chouquette port. This module is the only export surface;
// the registry imports it via `() => import('./iron-chouquette')`.

export async function mount(container: HTMLElement): Promise<GameInstance> {
  const app = new Application();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      background: '#000000',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    }),
    loadAssets(),
  ]);
  container.appendChild(app.canvas);

  const game = new IronChouquetteGame(app, assets);

  const onKeyDown = (event: KeyboardEvent) => {
    const key = mapKey(event);
    if (key === null) return;
    event.preventDefault();
    game.keys.add(key);
    // Sacrifice: CTRL or SHIFT triggers Hero.sacrifice ONCE per press (skip auto-repeat).
    if (
      !event.repeat
      && (event.code === 'ControlLeft' || event.code === 'ControlRight' || event.code === 'ShiftLeft' || event.code === 'ShiftRight')
      && game.hero
    ) {
      game.hero.sacrifice(null);
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const key = mapKey(event);
    if (key === null) return;
    event.preventDefault();
    game.keys.delete(key);
  };

  // Drop held keys when the window loses focus so held arrows / Space don't
  // latch when the player tabs away mid-press.
  const onBlur = () => {
    game.keys.clear();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  let acc = 0;
  const tickerCallback = (ticker: Ticker) => {
    acc += Math.min(ticker.deltaMS / 1000, 0.1);
    let guard = 0;
    while (acc >= STEP_SECONDS && guard < 5) {
      game.main();
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
      app.destroy(true, { children: true, texture: false });
    },
  };
}

function mapKey(event: KeyboardEvent): string | null {
  switch (event.code) {
    case 'ArrowLeft':
      return 'ArrowLeft';
    case 'ArrowRight':
      return 'ArrowRight';
    case 'ArrowUp':
      return 'ArrowUp';
    case 'ArrowDown':
      return 'ArrowDown';
    case 'Space':
      return 'Space';
    case 'Enter':
      return 'Enter';
    case 'AltLeft':
    case 'AltRight':
      return 'Alt';
    case 'ControlLeft':
    case 'ControlRight':
      return 'Control';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'Shift';
    default:
      return null;
  }
}
