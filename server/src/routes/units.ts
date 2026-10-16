import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, floors, unitEvents, units } from '../db/schema';
import { projectCache } from '../db/redis';
import { actorOf, requireAgent } from '../middleware/requireAgent';
import { broadcastUnitUpdate, type SyncServer } from '../services/sync';
import { DEFAULT_HOLD_DAYS, UNIT_STATUSES, type UnitStatus, type UnitStatusUpdate } from '../types';

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

  // Audit trail for one unit (agents only).
  router.get('/:id/events', requireAgent, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
      const rows = await db.select({ e: unitEvents, agent: agents.name }).from(unitEvents)
        .leftJoin(agents, eq(agents.id, unitEvents.agent_id))
        .where(eq(unitEvents.unit_id, req.params.id)).orderBy(desc(unitEvents.at)).limit(50);
      res.json(rows.map(({ e, agent }) => ({
        action: e.action, from: e.from_value, to: e.to_value, at: e.at.toISOString(), by: agent ?? 'System',
      })));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load history' });
    }
  });

  router.patch('/:id', requireAgent, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
      const { agent } = actorOf(res);
      const { status, reserved_until } = req.body ?? {};

      if (!UNIT_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${UNIT_STATUSES.join(', ')}` });
      }
      let reservedUntil: Date | null = null;
      if (status === 'reserved') {
        // Default hold is 3 days if the agent doesn't give an expiry.
        reservedUntil = reserved_until ? new Date(reserved_until) : new Date(Date.now() + DEFAULT_HOLD_DAYS * 864e5);
        if (Number.isNaN(reservedUntil.getTime()) || reservedUntil <= new Date()) {
          return res.status(400).json({ error: 'reserved_until must be a future ISO date' });
        }
      }

      const result = await db.transaction(async tx => {
        const [before] = await tx.select({ status: units.status, floor_id: units.floor_id }).from(units).where(eq(units.id, req.params.id)).for('update');
        if (!before) return null;
        const [updated] = await tx.update(units)
          .set({ status, reserved_until: reservedUntil, updated_at: new Date() })
          .where(eq(units.id, req.params.id))
          .returning({ id: units.id, floor_id: units.floor_id });
        if (before.status !== status) {
          await tx.insert(unitEvents).values({ unit_id: updated.id, agent_id: agent?.id ?? null, action: 'status', from_value: before.status, to_value: status });
        }
        return updated;
      });
      if (!result) return res.status(404).json({ error: 'Unit not found' });

      const [floor] = await db.select({ project_id: floors.project_id }).from(floors).where(eq(floors.id, result.floor_id));
      await projectCache.invalidate(floor.project_id);

      const payload: UnitStatusUpdate = {
        project_id: floor.project_id,
        unit_id: result.id,
        status: status as UnitStatus,
        reserved_until: reservedUntil?.toISOString(),
        updated_by: agent?.name ?? 'System',
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
