import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { projectCache } from '../db/redis';
import { floors, projects, rooms, units } from '../db/schema';
import type { ParsedIfc, ParsedPlan } from './parser';
import type { Facing, ImportFloor, ImportResult, ImportUnit, PlanPoint, PlanPolygon, Point2D, ProjectImport, RoomType } from '../types';

/** A problem with the import data itself (bad input or a conflict), as opposed to a server failure. */
export class ImportError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export interface PlanAssignment {
  plan: ParsedPlan;
  floors: number[];            // floor numbers this plan applies to (a typical floor covers many)
}

export interface AssembleOptions {
  name: string;
  floorHeight?: number;        // metres, default 3
  location?: ProjectImport['location'];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const signedArea = (pts: Point2D[]) =>
  pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;

/** SVG path for a footprint: outer ring counter-clockwise, holes clockwise, so SVGLoader cuts the holes. */
export function toSvgPath(outline: Point2D[], holes: Point2D[][] = []): string {
  const ring = (pts: Point2D[], ccw: boolean) => {
    const ordered = (signedArea(pts) > 0) === ccw ? pts : [...pts].reverse();
    return `M${ordered.map(p => `${p.x} ${p.y}`).join(' L')} Z`;
  };
  return [ring(outline, true), ...holes.map(h => ring(h, false))].join(' ');
}

/** Combine parsed floor plans into one project import: shared origin, floor numbers, real unit codes. */
export function assembleProject(assignments: PlanAssignment[], opts: AssembleOptions): ProjectImport {
  // Shift every plan by the same offset so floors drawn in the same CAD coordinates stay stacked.
  const all = assignments.flatMap(a => a.plan.outline);
  const minX = Math.min(...all.map(p => p.x));
  const minY = Math.min(...all.map(p => p.y));
  const shift = (pts: Point2D[]) => pts.map(p => ({ x: round3(p.x - minX), y: round3(p.y - minY) }));

  const byFloor = new Map<number, ImportFloor>();
  for (const { plan, floors: numbers } of assignments) {
    const templated = plan.units.filter(u => u.unit_code.includes('#'));
    if (numbers.length > 1 && templated.length < plan.units.length) {
      const fixed = plan.units.filter(u => !u.unit_code.includes('#')).map(u => u.unit_code);
      throw new ImportError(`${plan.source} is used for ${numbers.length} floors, but unit codes ${fixed.slice(0, 5).join(', ')} have no '#' for the floor number, so they would repeat.`);
    }
    const outline = shift(plan.outline);
    const holes = plan.holes.map(shift);

    for (const n of numbers) {
      if (byFloor.has(n)) throw new ImportError(`Floor ${n} is assigned to more than one DXF file.`);
      byFloor.set(n, {
        floor_number: n,
        label: n === 1 ? 'Ground' : `Level ${n}`,
        floor_height: opts.floorHeight ?? 3,
        svg_outline: toSvgPath(outline, holes),
        units: plan.units.map(u => ({
          ...u,
          unit_code: u.unit_code.replaceAll('#', String(n)),
          polygon: shift(u.polygon),
          rooms: u.rooms.map(r => ({ ...r, polygon: shift(r.polygon) })),
        })),
      });
    }
  }

  return {
    name: opts.name,
    location: opts.location,
    floors: [...byFloor.values()].sort((a, b) => a.floor_number - b.floor_number),
  };
}

/**
 * Turn a parsed IFC model into a project import. The IFC already knows its storeys, heights and
 * unit codes, so there's no file→floor mapping: storeys become floors 1..n, bottom up.
 */
export function assembleIfcProject(model: ParsedIfc, opts: Omit<AssembleOptions, 'floorHeight'>): ProjectImport {
  if (!model.storeys.length) throw new ImportError(`${model.source} has no usable storeys.`);
  const all = model.storeys.flatMap(s => s.outline);
  const minX = Math.min(...all.map(p => p.x));
  const minY = Math.min(...all.map(p => p.y));
  const shift = (pts: Point2D[]) => pts.map(p => ({ x: round3(p.x - minX), y: round3(p.y - minY) }));
  const shiftPt = ([x, y]: PlanPoint): PlanPoint => [round3(x - minX), round3(y - minY)];
  const shiftPoly = (poly: PlanPolygon): PlanPolygon => poly.map(ring => ring.map(shiftPt));

  const seen = new Set<string>();
  const floors = model.storeys.map((s, i): ImportFloor => {
    for (const u of s.units) {
      if (seen.has(u.unit_code)) throw new ImportError(`Unit ${u.unit_code} appears on more than one storey. Check the PV_Unit values in the model.`);
      seen.add(u.unit_code);
    }
    return {
      floor_number: i + 1,
      label: s.name,
      floor_height: Math.min(Math.max(round3(s.height), 0.5), 99),
      svg_outline: toSvgPath(shift(s.outline), s.holes.map(shift)),
      units: s.units.map(u => ({ ...u, polygon: shift(u.polygon), rooms: u.rooms.map(r => ({ ...r, polygon: shift(r.polygon) })) })),
      plan: {
        walls: s.plan.walls.map(shiftPoly),
        windows: s.plan.windows.map(shiftPoly),
        doors: s.plan.doors.map(shiftPoly),
        swings: s.plan.swings.map(line => line.map(shiftPt)),
        furniture: s.plan.furniture.map(shiftPoly),
        labels: s.plan.labels.map(l => ({ ...l, x: round3(l.x - minX), y: round3(l.y - minY) })),
      },
    };
  });
  return { name: opts.name, location: opts.location, floors };
}

const ROOM_TYPES: readonly RoomType[] = ['bedroom', 'living', 'kitchen', 'bathroom', 'balcony', 'storage'];
const FACINGS: readonly Facing[] = ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'];

const isPolygon = (v: unknown): v is Point2D[] =>
  Array.isArray(v) && v.length >= 3 && v.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));

/** Shape check for imports arriving over HTTP. Returns an error message, or null if valid. */
export function validateProjectImport(body: unknown): string | null {
  const data = body as Partial<ProjectImport> | null;
  if (!data || typeof data.name !== 'string' || !data.name.trim()) return 'name is required';
  if (data.name.length > 200) return 'name must be at most 200 characters';
  if (!Array.isArray(data.floors) || data.floors.length === 0) return 'floors must be a non-empty array';

  const floorNumbers = new Set<number>();
  const codes = new Set<string>();
  for (const f of data.floors) {
    if (!Number.isInteger(f?.floor_number)) return 'every floor needs an integer floor_number';
    if (floorNumbers.has(f.floor_number)) return `floor ${f.floor_number} appears twice`;
    floorNumbers.add(f.floor_number);
    if (!(f.floor_height > 0 && f.floor_height < 100)) return `floor ${f.floor_number}: floor_height must be between 0 and 100 m`;
    if (typeof f.svg_outline !== 'string' || !f.svg_outline.startsWith('M')) return `floor ${f.floor_number}: svg_outline must be an SVG path`;
    if (!Array.isArray(f.units)) return `floor ${f.floor_number}: units must be an array`;
    if (f.plan !== undefined) {
      const p = f.plan as unknown as Record<string, unknown>;
      if (!p || typeof p !== 'object' || !['walls', 'windows', 'doors', 'swings', 'furniture', 'labels'].every(k => Array.isArray(p[k]))) {
        return `floor ${f.floor_number}: plan needs walls, windows, doors, swings, furniture and labels arrays`;
      }
    }
    for (const u of f.units as ImportUnit[]) {
      if (typeof u?.unit_code !== 'string' || !u.unit_code || u.unit_code.length > 20) return `floor ${f.floor_number}: unit_code must be 1-20 characters`;
      if (codes.has(u.unit_code)) return `unit code ${u.unit_code} appears more than once`;
      codes.add(u.unit_code);
      if (!isPolygon(u.polygon)) return `${u.unit_code}: polygon needs at least 3 {x, y} points`;
      if (!(u.area_sqm > 0)) return `${u.unit_code}: area_sqm must be positive`;
      if (!FACINGS.includes(u.facing)) return `${u.unit_code}: facing must be one of ${FACINGS.join(', ')}`;
      if (!Number.isInteger(u.bedrooms) || !Number.isInteger(u.bathrooms)) return `${u.unit_code}: bedrooms and bathrooms must be integers`;
      if (!Array.isArray(u.rooms)) return `${u.unit_code}: rooms must be an array`;
      for (const r of u.rooms) {
        if (!ROOM_TYPES.includes(r?.type)) return `${u.unit_code}: room type must be one of ${ROOM_TYPES.join(', ')}`;
        if (!isPolygon(r.polygon)) return `${u.unit_code}: every room polygon needs at least 3 {x, y} points`;
      }
    }
  }
  return null;
}

export interface ImportOptions {
  /** Update this project instead of creating a new one. */
  projectId?: string;
  /** Allow a re-import to delete units that are sold or reserved. Off by default. */
  allowRemovingCommitted?: boolean;
}

/**
 * Write an import to the database in one transaction.
 * Re-imports match units by unit_code and replace geometry only — status, price and
 * reserved_until are kept. New units start available with price 0.
 */
export async function importProject(data: ProjectImport, opts: ImportOptions = {}): Promise<ImportResult> {
  const result = await db.transaction(async tx => {
    let projectId = opts.projectId;
    if (projectId) {
      const [updated] = await tx.update(projects)
        .set({ name: data.name, total_floors: data.floors.length, ...(data.location && { location: data.location }), ...(data.amenities && { amenities: data.amenities }) })
        .where(eq(projects.id, projectId))
        .returning({ id: projects.id });
      if (!updated) throw new ImportError('Project not found', 404);
    } else {
      const [created] = await tx.insert(projects).values({
        name: data.name,
        location: data.location ?? { lat: 0, lng: 0, address: '' },
        total_floors: data.floors.length,
        amenities: data.amenities ?? [],
      }).returning({ id: projects.id });
      projectId = created.id;
    }

    // Floors: update in place by floor number, insert new ones. Obsolete floors are deleted at the end.
    const existingFloors = await tx.select().from(floors).where(eq(floors.project_id, projectId));
    const floorIdByNumber = new Map(existingFloors.map(f => [f.floor_number, f.id]));
    for (const f of data.floors) {
      const values = { label: f.label, floor_height: f.floor_height.toFixed(2), svg_outline: f.svg_outline, plan: f.plan ?? null };
      const id = floorIdByNumber.get(f.floor_number);
      if (id) {
        await tx.update(floors).set(values).where(eq(floors.id, id));
      } else {
        const [row] = await tx.insert(floors).values({ project_id: projectId, floor_number: f.floor_number, ...values }).returning({ id: floors.id });
        floorIdByNumber.set(f.floor_number, row.id);
      }
    }

    const existingUnits = existingFloors.length
      ? await tx.select().from(units).where(inArray(units.floor_id, existingFloors.map(f => f.id)))
      : [];
    const existingByCode = new Map(existingUnits.map(u => [u.unit_code, u]));
    const incomingCodes = new Set(data.floors.flatMap(f => f.units.map(u => u.unit_code)));

    const removed = existingUnits.filter(u => !incomingCodes.has(u.unit_code));
    const committed = removed.filter(u => u.status !== 'available');
    if (committed.length && !opts.allowRemovingCommitted) {
      throw new ImportError(
        `This import would delete ${committed.length} sold/reserved unit(s): ${committed.slice(0, 10).map(u => u.unit_code).join(', ')}. ` +
        'Fix the unit codes in the drawing, or confirm removal explicitly.', 409);
    }

    let created = 0;
    let updated = 0;
    const roomRows: (typeof rooms.$inferInsert)[] = [];
    for (const f of data.floors) {
      const floorId = floorIdByNumber.get(f.floor_number)!;
      for (const u of f.units) {
        const geometry = {
          floor_id: floorId, polygon: u.polygon, area_sqm: u.area_sqm.toFixed(2),
          facing: u.facing, bedrooms: u.bedrooms, bathrooms: u.bathrooms,
        };
        const existing = existingByCode.get(u.unit_code);
        let unitId: string;
        if (existing) {
          await tx.update(units).set({ ...geometry, updated_at: new Date() }).where(eq(units.id, existing.id));
          unitId = existing.id;
          updated++;
        } else {
          const [row] = await tx.insert(units).values({ ...geometry, unit_code: u.unit_code, status: 'available', price: 0 }).returning({ id: units.id });
          unitId = row.id;
          created++;
        }
        roomRows.push(...u.rooms.map(r => ({
          unit_id: unitId, room_type: r.type, polygon: r.polygon,
          area_sqm: r.area_sqm.toFixed(2), label: r.label ?? null,
        })));
      }
    }

    // Rooms are pure geometry: replace them wholesale for every unit that was kept.
    const keptIds = existingUnits.filter(u => incomingCodes.has(u.unit_code)).map(u => u.id);
    if (keptIds.length) await tx.delete(rooms).where(inArray(rooms.unit_id, keptIds));
    for (let i = 0; i < roomRows.length; i += 1000) await tx.insert(rooms).values(roomRows.slice(i, i + 1000));

    if (removed.length) await tx.delete(units).where(inArray(units.id, removed.map(u => u.id)));
    const incomingFloors = new Set(data.floors.map(f => f.floor_number));
    const obsoleteFloors = existingFloors.filter(f => !incomingFloors.has(f.floor_number)).map(f => f.id);
    if (obsoleteFloors.length) await tx.delete(floors).where(inArray(floors.id, obsoleteFloors));

    return {
      project_id: projectId,
      floors: data.floors.length,
      units_created: created,
      units_updated: updated,
      units_removed: removed.map(u => u.unit_code),
    };
  });

  await projectCache.invalidate(result.project_id).catch(err => console.warn('Project cache invalidate failed', err));
  return result;
}
