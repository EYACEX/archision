import { Router, type RequestHandler } from 'express';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { projectCache } from '../db/redis';
import { projects, floors, units, rooms } from '../db/schema';
import { requireAgent } from '../middleware/requireAgent';
import { ImportError, importProject, validateProjectImport } from '../services/importer';
import type { Facing, Floor, Project, ProjectImport, RoomType, Unit, UnitStatus } from '../types';

export const projectsRouter = Router();

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Import normalized building geometry (see ProjectImport). POST /import creates a project;
// POST /:id/import re-imports into an existing one, keeping status/price/reservations by unit_code.
// ?allow_removing_committed=true lets a re-import delete sold/reserved units.
const handleImport: RequestHandler = async (req, res) => {
  try {
    const projectId: string | undefined = req.params.id;
    if (projectId !== undefined && !isUuid(projectId)) return res.status(404).json({ error: 'Project not found' });
    const invalid = validateProjectImport(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const result = await importProject(req.body as ProjectImport, {
      projectId,
      allowRemovingCommitted: req.query.allow_removing_committed === 'true',
    });
    res.status(projectId ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof ImportError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to import project' });
  }
};

projectsRouter.post('/import', requireAgent, handleImport);
projectsRouter.post('/:id/import', requireAgent, handleImport);

projectsRouter.get('/', async (_req, res) => {
  try {
    const rows = await db.select().from(projects);
    res.json(rows.map(p => ({
      id: p.id, name: p.name, location: p.location, total_floors: p.total_floors,
      amenities: p.amenities ?? [], thumbnail_url: p.thumbnail_url ?? undefined,
      model_url: p.model_url ?? undefined, created_at: p.created_at.toISOString(),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

projectsRouter.get('/:id', async (req, res) => {
  try {
    const cached = await projectCache.get(req.params.id).catch(() => null);
    if (cached) return res.type('json').send(cached);

    const [p] = await db.select().from(projects).where(eq(projects.id, req.params.id));
    if (!p) return res.status(404).json({ error: 'Project not found' });

    // Everything but the (large) engineered plan, which GET /api/floors/:id/plan serves on demand.
    const floorRows = await db.select({
      id: floors.id, project_id: floors.project_id, floor_number: floors.floor_number, label: floors.label,
      floor_height: floors.floor_height, svg_outline: floors.svg_outline,
      has_plan: sql<boolean>`${floors.plan} is not null`,
    }).from(floors).where(eq(floors.project_id, p.id));
    const floorIds = floorRows.map(f => f.id);
    const unitRows = floorIds.length ? await db.select().from(units).where(inArray(units.floor_id, floorIds)).orderBy(asc(units.unit_code)) : [];
    const unitIds = unitRows.map(u => u.id);
    const roomRows = unitIds.length ? await db.select().from(rooms).where(inArray(rooms.unit_id, unitIds)) : [];

    const floorNumberById = new Map(floorRows.map(f => [f.id, f.floor_number]));

    const toUnit = (u: typeof unitRows[number]): Unit => ({
      id: u.id,
      unit_code: u.unit_code,
      polygon: u.polygon,
      area_sqm: Number(u.area_sqm),
      status: u.status as UnitStatus,
      price: u.price,
      facing: (u.facing ?? 'N') as Facing,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      floor_number: floorNumberById.get(u.floor_id)!,
      rooms: roomRows.filter(r => r.unit_id === u.id).map(r => ({
        id: r.id, type: r.room_type as RoomType, polygon: r.polygon,
        area_sqm: Number(r.area_sqm ?? 0), label: r.label ?? undefined,
      })),
      media: [],
      reserved_until: u.reserved_until?.toISOString(),
    });

    const result: Project = {
      id: p.id, name: p.name, location: p.location, total_floors: p.total_floors,
      amenities: p.amenities ?? [], thumbnail_url: p.thumbnail_url ?? undefined,
      model_url: p.model_url ?? undefined, created_at: p.created_at.toISOString(),
      floors: floorRows
        .sort((a, b) => a.floor_number - b.floor_number)
        .map((f): Floor => ({
          id: f.id, project_id: f.project_id, floor_number: f.floor_number,
          label: f.label ?? `Level ${f.floor_number}`,
          floor_height: Number(f.floor_height), svg_outline: f.svg_outline, has_plan: f.has_plan,
          units: unitRows.filter(u => u.floor_id === f.id).map(toUnit),
        })),
    };
    const json = JSON.stringify(result);
    await projectCache.set(p.id, json).catch(err => console.warn('Project cache write failed', err));
    res.type('json').send(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load project' });
  }
});
