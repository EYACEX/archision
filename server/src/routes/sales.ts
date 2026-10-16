import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, floors, holdRequests, projects, units } from '../db/schema';
import { actorOf, requireAdmin, requireAgent } from '../middleware/requireAgent';
import { rateLimit } from '../services/auth';
import { applyPriceSheet } from '../services/prices';
import type { SyncServer } from '../services/sync';
import { HOLD_STATUSES, type HoldRequest, type HoldStatus } from '../types';

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const PHONE = /^\+?[\d\s\-()]{7,30}$/;

/** Prices (admins), and buyer hold requests: created publicly, handled by agents. Mounted at /api. */
export function salesRouter(io: SyncServer): Router {
  const router = Router();

  // Price sheet upload. ?dry_run=true previews; otherwise all-or-nothing apply.
  router.post('/projects/:id/prices', requireAgent, requireAdmin, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Project not found' });
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, req.params.id));
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const { agent } = actorOf(res);
      const result = await applyPriceSheet(io, project.id, req.body?.rows, {
        dryRun: req.query.dry_run === 'true', agentId: agent?.id ?? null, agentName: agent?.name ?? 'System',
      });
      res.status(result.errors.length ? 422 : 200).json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to apply prices' });
    }
  });

  // Public: a buyer asks to hold a unit. Rate-limited; duplicates (same unit + phone, still open) are merged.
  router.post('/units/:id/hold-requests', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
      const name = String(req.body?.name ?? '').trim();
      const phone = String(req.body?.phone ?? '').trim();
      const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
      if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Please enter your name' });
      if (!PHONE.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number' });
      if (!(await rateLimit(`hold:ip:${req.ip}`, 5, 60 * 60))) {
        return res.status(429).json({ error: 'Too many requests. Please try again later or call the sales office.' });
      }

      const [unit] = await db.select({ id: units.id, status: units.status }).from(units).where(eq(units.id, req.params.id));
      if (!unit) return res.status(404).json({ error: 'Unit not found' });
      if (unit.status !== 'available') return res.status(409).json({ error: 'Sorry, this unit is no longer available' });

      const [dupe] = await db.select({ id: holdRequests.id }).from(holdRequests)
        .where(and(eq(holdRequests.unit_id, unit.id), eq(holdRequests.phone, phone), eq(holdRequests.status, 'open')));
      if (dupe) return res.status(200).json({ ok: true, id: dupe.id });

      const [created] = await db.insert(holdRequests).values({ unit_id: unit.id, name, phone, note }).returning({ id: holdRequests.id });
      res.status(201).json({ ok: true, id: created.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to send request' });
    }
  });

  // Agents: the request inbox. ?status=open (default) | contacted | reserved | dismissed | all; ?project_id=
  router.get('/holds', requireAgent, async (req, res) => {
    try {
      const status = String(req.query.status ?? 'open');
      const projectId = typeof req.query.project_id === 'string' && isUuid(req.query.project_id) ? req.query.project_id : null;
      const conditions = [
        ...(status !== 'all' && HOLD_STATUSES.includes(status as HoldStatus) ? [eq(holdRequests.status, status)] : []),
        ...(projectId ? [eq(floors.project_id, projectId)] : []),
      ];
      const rows = await db.select({ h: holdRequests, unit_code: units.unit_code, project_id: floors.project_id, agent: agents.name })
        .from(holdRequests)
        .innerJoin(units, eq(units.id, holdRequests.unit_id))
        .innerJoin(floors, eq(floors.id, units.floor_id))
        .leftJoin(agents, eq(agents.id, holdRequests.handled_by))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(holdRequests.created_at)).limit(500);
      res.json(rows.map(({ h, unit_code, project_id, agent }): HoldRequest => ({
        id: h.id, unit_id: h.unit_id, unit_code, project_id, name: h.name, phone: h.phone, note: h.note ?? undefined,
        status: h.status as HoldStatus, handled_by: agent ?? undefined, created_at: h.created_at.toISOString(),
      })));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load requests' });
    }
  });

  router.patch('/holds/:id', requireAgent, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Request not found' });
      const status = req.body?.status;
      if (!HOLD_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${HOLD_STATUSES.join(', ')}` });
      const { agent } = actorOf(res);
      const [updated] = await db.update(holdRequests)
        .set({ status, handled_by: agent?.id ?? null, updated_at: new Date() })
        .where(eq(holdRequests.id, req.params.id)).returning({ id: holdRequests.id });
      if (!updated) return res.status(404).json({ error: 'Request not found' });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update request' });
    }
  });

  return router;
}
