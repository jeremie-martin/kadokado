import { Container, Graphics } from 'pixi.js';
import type { Segment } from './interwheel-planner';

export class TrajectoryOverlay {
  private readonly graphics = new Graphics();
  private visible = true;

  constructor(parent: Container) {
    parent.addChild(this.graphics);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.graphics.visible = v;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  isVisible(): boolean {
    return this.visible;
  }

  draw(segments: Segment[]): void {
    const g = this.graphics;
    g.clear();
    if (!this.visible || segments.length === 0) return;

    // Dim, depth-faded branches first so the bright best path overlays them.
    for (const s of segments) {
      if (s.kind !== 'branch') continue;
      const alpha = Math.max(0.18, 0.75 - s.depth * 0.006);
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: 0x9be8ff, width: 1.0, alpha });
    }
    for (const s of segments) {
      if (s.kind !== 'dead') continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: 0xff6e5c, width: 1.0, alpha: 0.6 });
    }
    for (const s of segments) {
      if (s.kind !== 'best') continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: 0xfff1a8, width: 2.4, alpha: 1.0 });
    }
  }
}
