// Alphabounce entry point. Mirrors the launcher conventions used by Linea and
// the other ports: create a Pixi Application, load assets, build the Game,
// drive a fixed-step accumulator at 90 Hz, return a destroy() that
// exhaustively cleans up listeners and Pixi resources.

import { Application, Ticker } from 'pixi.js';
import { noopGameHost } from '../types';
import type { GameInstance, GameMountContext } from '../types';
import { STAGE_HEIGHT, STAGE_WIDTH, STEP_SECONDS } from './constants';
import { AlphabounceGame, loadAssets } from './game';

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

  const game = new AlphabounceGame(app, assets, context?.host ?? noopGameHost);

  // Keyboard: Left/Right move pad; Space = action (mouse-down equivalent).
  let spaceHeld = false;
  const onKeyDown = (event: KeyboardEvent) => {
    let handled = true;
    switch (event.code) {
      case 'ArrowLeft':
        game.setLeft(true);
        break;
      case 'ArrowRight':
        game.setRight(true);
        break;
      case 'Space':
        if (!spaceHeld) {
          spaceHeld = true;
          game.setMouseDown();
        }
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    let handled = true;
    switch (event.code) {
      case 'ArrowLeft':
        game.setLeft(false);
        break;
      case 'ArrowRight':
        game.setRight(false);
        break;
      case 'Space':
        spaceHeld = false;
        game.setMouseUp();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  // Mouse: movement controls pad; click triggers pad.action.
  const onPointerMove = (event: PointerEvent) => {
    const rect = app.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * STAGE_WIDTH;
    game.setMouseMove(x);
  };
  const onPointerDown = (event: PointerEvent) => {
    // Only react to the primary button; right-click would otherwise latch
    // flPress=true and the contextmenu would swallow the pointerup.
    if (event.button !== 0) return;
    event.preventDefault();
    game.setMouseDown();
  };
  // pointerup / pointercancel must live on window: if the user presses on the
  // canvas and drags off before releasing, the canvas-only listener never
  // fires and pad.salve() keeps shooting forever.
  const onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0 && event.type === 'pointerup') return;
    event.preventDefault();
    game.setMouseUp();
  };
  // Suppress the browser context menu over the canvas so right-click doesn't
  // pop a native menu over the game.
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  // Release held inputs on focus loss — without this, the pad keeps moving
  // after the player tabs away mid-press.
  const onBlur = () => {
    game.setLeft(false);
    game.setRight(false);
    if (spaceHeld) {
      spaceHeld = false;
      game.setMouseUp();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  app.canvas.addEventListener('pointermove', onPointerMove);
  app.canvas.addEventListener('pointerdown', onPointerDown);
  app.canvas.addEventListener('contextmenu', onContextMenu);

  // Fixed-step accumulator. STEP_SECONDS = 1/40 (SWF header confirmed 40 FPS).
  let acc = 0;
  const tickerCallback = (ticker: Ticker) => {
    acc += Math.min(ticker.deltaMS / 1000, 0.1);
    let guard = 0;
    while (acc >= STEP_SECONDS && guard < 8) {
      game.step_();
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
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      app.canvas.removeEventListener('pointermove', onPointerMove);
      app.canvas.removeEventListener('pointerdown', onPointerDown);
      app.canvas.removeEventListener('contextmenu', onContextMenu);
      app.ticker.remove(tickerCallback);
      game.destroy();
      // texture:false — textures live in the global Assets cache. Destroying
      // them emits "Texture managed by Assets was destroyed" warnings every
      // mount/destroy cycle and forces a re-fetch on the next mount. Filters
      // and the plasma RenderTexture are released explicitly by game.destroy().
      app.destroy(true, { children: true, texture: false });
    },
  };
}
