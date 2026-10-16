import { formatPrice } from '../format';
import type { Floor, FloorPlan, PlanPoint, PlanPolygon, Point2D, Unit, UnitStatus, UnitStatusUpdate } from '../types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FLASH_MS = 1200; // how long a unit glows after a live status change

export const STATUS_COLORS: Record<UnitStatus, string> = {
  available: '#3fae6a',
  reserved: '#e0a030',
  sold: '#d64545',
};

export interface FloorSceneOptions {
  onBack?: () => void;
  /** A unit was clicked or tapped (opens the buyer's unit panel). */
  onUnitSelect?: (unit: Unit) => void;
  /** Fetches a floor's engineered plan (only called when floor.has_plan). */
  loadPlan?: (floor: Floor) => Promise<FloorPlan>;
}

/** Polygon with holes → SVG path data (draw with fill-rule evenodd). */
const polygonPath = (poly: PlanPolygon) => poly.map(ring => `M${ring.map(p => `${p[0]},${p[1]}`).join('L')}Z`).join('');
const linePath = (line: PlanPoint[]) => `M${line.map(p => `${p[0]},${p[1]}`).join('L')}`;

/** One <path> per layer keeps the DOM small even for big floors. */
function planLayers(plan: FloorPlan): { below: SVGGElement; above: SVGGElement } {
  const layer = (cls: string, d: string) => svgEl('path', { d, class: cls, 'fill-rule': 'evenodd' });
  const below = svgEl('g', { class: 'fp-arch' });
  below.append(layer('fp-furniture', plan.furniture.map(polygonPath).join('')));
  const above = svgEl('g', { class: 'fp-arch' });
  above.append(
    layer('fp-walls', plan.walls.map(polygonPath).join('')),
    layer('fp-windows', plan.windows.map(polygonPath).join('')),
    layer('fp-doors', plan.doors.map(polygonPath).join('')),
    layer('fp-swings', plan.swings.map(linePath).join('')),
  );
  return { below, above };
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const pointsAttr = (poly: Point2D[]) => poly.map(p => `${p.x},${p.y}`).join(' ');

/** Area-weighted centroid; falls back to the vertex average for degenerate polygons. */
function centroid(poly: Point2D[]): Point2D {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * 2D floor plan as an SVG overlay. Geometry is drawn in data coordinates (metres) inside a group
 * flipped with scale(1,-1), so data +y (plan north) points up. Labels sit in an unflipped layer at
 * (x, -y) so text isn't mirrored.
 */
export class FloorScene {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly tooltip: HTMLDivElement;
  private readonly unitShapes = new Map<string, SVGPolygonElement>(); // unit id → polygon
  private floor: Floor | null = null;
  private hovered: Unit | null = null;
  private readonly plans = new Map<string, Promise<FloorPlan>>(); // floor id → engineered plan

  constructor(private readonly container: HTMLElement, private readonly opts: FloorSceneOptions = {}) {
    this.root = document.createElement('div');
    this.root.id = 'floor-plan';
    this.root.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'fp-bar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'fp-back';
    back.textContent = '← Back to building';
    back.addEventListener('click', () => this.opts.onBack?.());
    this.title = document.createElement('div');
    this.title.className = 'fp-title';
    bar.append(back, this.title);

    const legend = document.createElement('div');
    legend.className = 'fp-legend';
    for (const [status, color] of Object.entries(STATUS_COLORS)) {
      const item = document.createElement('span');
      item.innerHTML = `<i style="background:${color}"></i>${status}`;
      legend.append(item);
    }

    this.svg = svgEl('svg', { class: 'fp-svg', preserveAspectRatio: 'xMidYMid meet' });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'fp-tooltip';
    this.tooltip.hidden = true;

    this.root.append(this.svg, bar, legend, this.tooltip);
    this.container.append(this.root);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean { return !this.root.hidden; }
  get currentFloor(): Floor | null { return this.floor; }

  open(floor: Floor): void {
    this.root.classList.remove('has-arch');
    this.floor = floor;
    this.root.hidden = false; // must be visible before getBBox()
    this.render();
  }

  close(): void {
    this.root.hidden = true;
    this.root.classList.remove('has-arch');
    this.floor = null;
    this.setHovered(null);
    this.svg.replaceChildren();
    this.unitShapes.clear();
  }

  /** Recolour a unit after a live change. The Floor object is shared with BuildingScene, which already updated it. */
  updateUnitStatus(update: UnitStatusUpdate): void {
    const unit = this.floor?.units.find(u => u.id === update.unit_id);
    const shape = this.unitShapes.get(update.unit_id);
    if (!unit || !shape) return;
    shape.setAttribute('fill', STATUS_COLORS[unit.status]);
    shape.animate([{ fillOpacity: 1 }, { fillOpacity: 0.55 }], { duration: FLASH_MS, easing: 'ease-out' });
    if (this.hovered === unit) this.renderTooltip(unit);
  }

  /** Recolour every unit from the floor data, e.g. after a reconnect resync. */
  refresh(): void {
    for (const unit of this.floor?.units ?? []) this.unitShapes.get(unit.id)?.setAttribute('fill', STATUS_COLORS[unit.status]);
    if (this.hovered) this.renderTooltip(this.hovered);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  private render(): void {
    const floor = this.floor!;
    this.unitShapes.clear();
    this.title.innerHTML = `<strong>${escapeHtml(floor.label)}</strong> <span class="muted">· ${floor.units.length} units</span>`;

    const plan = svgEl('g', { transform: 'scale(1,-1)' });
    plan.append(svgEl('path', { d: floor.svg_outline, 'fill-rule': 'evenodd', class: 'fp-outline' }));

    const units = svgEl('g');
    const rooms = svgEl('g', { class: 'fp-rooms' });
    for (const unit of floor.units) {
      const shape = svgEl('polygon', { points: pointsAttr(unit.polygon), fill: STATUS_COLORS[unit.status], class: 'fp-unit' });
      shape.addEventListener('pointerenter', e => { this.setHovered(unit); this.moveTooltip(e); });
      shape.addEventListener('click', () => { this.setHovered(null); this.opts.onUnitSelect?.(unit); });
      shape.addEventListener('pointerleave', () => this.setHovered(null));
      shape.addEventListener('pointermove', this.moveTooltip);
      units.append(shape);
      this.unitShapes.set(unit.id, shape);
      for (const room of unit.rooms) rooms.append(svgEl('polygon', { points: pointsAttr(room.polygon) }));
    }
    plan.append(units, rooms);
    this.svg.replaceChildren(plan);

    // Size text and the viewBox from the drawn plan, so any building scale reads the same.
    const box = plan.getBBox();
    const span = Math.max(box.width, box.height) || 1;
    const pad = span * 0.04;
    this.svg.setAttribute('viewBox', `${box.x - pad} ${-(box.y + box.height) - pad} ${box.width + 2 * pad} ${box.height + 2 * pad}`);
    const roomSize = span / 85, unitSize = span / 40;

    const labels = svgEl('g', { class: 'fp-labels' });
    this.renderUnitLabels(labels, unitSize, roomSize, !floor.has_plan);
    this.svg.append(labels);

    if (floor.has_plan && this.opts.loadPlan) {
      // The plan arrives after the units, so the view is usable at once.
      if (!this.plans.has(floor.id)) this.plans.set(floor.id, this.opts.loadPlan(floor));
      this.plans.get(floor.id)!
        .then(arch => {
          if (this.floor !== floor) return; // closed or switched floors meanwhile
          this.root.classList.add('has-arch');
          const { below, above } = planLayers(arch);
          units.before(below);   // furniture under the unit colours
          rooms.after(above);    // walls, windows and doors over them
          for (const l of arch.labels) {
            const name = svgEl('text', { x: l.x, y: -l.y, 'font-size': roomSize, class: 'fp-room-label' });
            name.textContent = l.text;
            labels.append(name);
            if (l.sub) {
              const sub = svgEl('text', { x: l.x, y: -l.y + roomSize * 1.25, 'font-size': roomSize * 0.85, class: 'fp-room-sub' });
              sub.textContent = l.sub;
              labels.append(sub);
            }
          }
        })
        .catch(err => {
          this.plans.delete(floor.id);
          console.warn('Engineered plan failed to load; showing units only', err);
          if (this.floor === floor) this.renderUnitLabels(labels, unitSize, roomSize, true, false);
        });
    }
  }

  /** Unit codes, plus room names from the unit data unless the engineered plan supplies them. */
  private renderUnitLabels(labels: SVGGElement, unitSize: number, roomSize: number, roomNames: boolean, unitCodes = true): void {
    for (const unit of this.floor!.units) {
      if (roomNames) {
        for (const room of unit.rooms) {
          const c = centroid(room.polygon);
          const text = svgEl('text', { x: c.x, y: -c.y, 'font-size': roomSize, class: 'fp-room-label' });
          text.textContent = room.label ?? room.type;
          labels.append(text);
        }
      }
      if (!unitCodes) continue;
      let at: Point2D;
      if (this.floor!.has_plan && unit.rooms.length) {
        // Real walls run through the unit's centre; sit the code above the largest room's name instead.
        const largest = unit.rooms.reduce((a, b) => (b.area_sqm > a.area_sqm ? b : a));
        const c = centroid(largest.polygon);
        at = { x: c.x, y: c.y + roomSize * 2.2 };
      } else {
        // With rooms drawn, put the code near the unit's top edge so it doesn't sit on a room label.
        const c = centroid(unit.polygon);
        const top = Math.max(...unit.polygon.map(p => p.y));
        at = { x: c.x, y: unit.rooms.length ? Math.min(top - unitSize * 0.9, c.y + unitSize * 1.2) : c.y };
      }
      const code = svgEl('text', { x: at.x, y: -at.y, 'font-size': unitSize, class: 'fp-unit-label' });
      code.textContent = unit.unit_code;
      labels.append(code);
    }
  }

  private setHovered(unit: Unit | null): void {
    if (this.hovered) this.unitShapes.get(this.hovered.id)?.classList.remove('hover');
    this.hovered = unit;
    if (unit) {
      this.unitShapes.get(unit.id)?.classList.add('hover');
      this.renderTooltip(unit);
    }
    this.tooltip.hidden = !unit;
  }

  private renderTooltip(unit: Unit): void {
    const reserved = unit.status === 'reserved' && unit.reserved_until
      ? ` until ${new Date(unit.reserved_until).toLocaleDateString()}` : '';
    this.tooltip.innerHTML =
      `<strong>${escapeHtml(unit.unit_code)}</strong> ` +
      `<span class="fp-status" style="color:${STATUS_COLORS[unit.status]}">${unit.status}${reserved}</span><br>` +
      `${unit.area_sqm} m² · ${unit.bedrooms} bed · ${unit.bathrooms} bath · faces ${unit.facing}<br>` +
      (unit.price > 0 ? formatPrice(unit.price) : '<span class="muted">Price not set</span>');
  }

  private moveTooltip = (e: PointerEvent): void => {
    const { innerWidth: w, innerHeight: h } = window;
    const r = this.tooltip.getBoundingClientRect();
    const x = e.clientX + 16 + r.width > w ? e.clientX - 16 - r.width : e.clientX + 16;
    const y = e.clientY + 16 + r.height > h ? e.clientY - 16 - r.height : e.clientY + 16;
    this.tooltip.style.transform = `translate(${x}px, ${y}px)`;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.opts.onBack?.();
  };
}
