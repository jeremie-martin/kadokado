import { Assets, Sprite, Texture } from 'pixi.js';

export type Frame = {
  texture: Texture;
  pivotX: number;
  pivotY: number;
};

export async function loadFrame(path: string, pivotX: number, pivotY: number): Promise<Frame> {
  const texture = await Assets.load<Texture>(path);
  return { texture, pivotX, pivotY };
}

export async function loadSeries(
  folder: string,
  count: number,
  pivotX: number,
  pivotY: number,
): Promise<Frame[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) => loadFrame(`${folder}/${i + 1}.png`, pivotX, pivotY)),
  );
}

export function makeSprite(frame: Frame): Sprite {
  const sprite = new Sprite(frame.texture);
  sprite.pivot.set(frame.pivotX, frame.pivotY);
  return sprite;
}

export function setFrame(sprite: Sprite, frame: Frame): void {
  sprite.texture = frame.texture;
  sprite.pivot.set(frame.pivotX, frame.pivotY);
}
