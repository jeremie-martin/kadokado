import './style.css';
import type { GameInstance } from './games/types';
import { GAMES, findGame } from './games/registry';

const rootEl = document.querySelector<HTMLDivElement>('#app');
if (!rootEl) {
  throw new Error('Missing #app mount point');
}
const root = rootEl;

let active: GameInstance | null = null;
let renderId = 0;

function clear(): void {
  renderId += 1;
  if (active) {
    active.destroy();
    active = null;
  }
  root.replaceChildren();
}

function renderLanding(): void {
  clear();
  const shell = document.createElement('div');
  shell.className = 'shell';

  const title = document.createElement('h1');
  title.textContent = 'MotionTwin Ports';
  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent = 'TypeScript / PixiJS ports of MotionTwin Flash games.';
  shell.append(title, lead);

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  for (const entry of GAMES) {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.type = 'button';
    const heading = document.createElement('h2');
    heading.textContent = entry.meta.title;
    const desc = document.createElement('p');
    desc.textContent = entry.meta.description;
    tile.append(heading, desc);
    tile.addEventListener('click', () => {
      window.location.hash = entry.meta.id;
    });
    tiles.appendChild(tile);
  }
  shell.appendChild(tiles);
  root.appendChild(shell);
}

async function renderGame(id: string): Promise<void> {
  const entry = findGame(id);
  if (!entry) {
    renderLanding();
    return;
  }

  clear();
  const myId = renderId;

  const player = document.createElement('div');
  player.className = 'player';

  const back = document.createElement('button');
  back.className = 'player-back';
  back.type = 'button';
  back.textContent = '← Back';
  back.addEventListener('click', () => {
    window.location.hash = '';
  });

  const stage = document.createElement('div');
  stage.className = 'player-stage';
  stage.style.width = `${entry.meta.width}px`;
  stage.style.height = `${entry.meta.height}px`;

  player.append(back, stage);
  root.appendChild(player);

  const mod = await entry.load();
  if (myId !== renderId) return;
  const instance = await mod.mount(stage);
  if (myId !== renderId) {
    instance.destroy();
    return;
  }
  active = instance;
}

function route(): void {
  const id = window.location.hash.replace(/^#/, '');
  if (id) {
    void renderGame(id);
  } else {
    renderLanding();
  }
}

window.addEventListener('hashchange', route);
route();
