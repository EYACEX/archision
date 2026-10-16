import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { floors, units } from '../db/schema';
import { projectCache } from '../db/redis';
import { requireAgent } from '../middleware/requireAgent';
import { broadcastUnitUpdate, type SyncServer } from '../services/sync';
import { UNIT_STATUSES, type UnitStatus, type UnitStatusUpdate } from '../types';

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function unitsRouter(io: SyncServer): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
      const [unit] = await db.select().from(units).where(eq(units.id, req.params.id));
      if (!unit) return res.status(404).json({ error: 'Unit not found' });
      res.json({ ...unit, area_sqm: Number(unit.area_sqm) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load unit' });
    }
  });

  router.patch('/:id', requireAgent, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
      const { status, reserved_until, updated_by } = req.body ?? {};

      if (!UNIT_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${UNIT_STATUSES.join(', ')}` });
      }
      let reservedUntil: Date | null = null;
      if (status === 'reserved') {
        // Default hold is 3 days if the agent doesn't give an expiry.
        reservedUntil = reserved_until ? new Date(reserved_until) : new Date(Date.now() + 3 * 864e5);
        if (Number.isNaN(reservedUntil.getTime()) || reservedUntil <= new Date()) {
          return res.status(400).json({ error: 'reserved_until must be a future ISO date' });
        }
      }

      const [updated] = await db.update(units)
        .set({ status, reserved_until: reservedUntil, updated_at: new Date() })
        .where(eq(units.id, req.params.id))
        .returning({ id: units.id, floor_id: units.floor_id });
      if (!updated) return res.status(404).json({ error: 'Unit not found' });

      const [floor] = await db.select({ project_id: floors.project_id }).from(floors).where(eq(floors.id, updated.floor_id));

      await projectCache.invalidate(floor.project_id);

      const payload: UnitStatusUpdate = {
        project_id: floor.project_id,
        unit_id: updated.id,
        status: status as UnitStatus,
        reserved_until: reservedUntil?.toISOString(),
        updated_by: typeof updated_by === 'string' ? updated_by.slice(0, 100) : undefined,
      };
      broadcastUnitUpdate(io, payload);
      res.json(payload);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update unit' });
    }
  });

  return router;
}
