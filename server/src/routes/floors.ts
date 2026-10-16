import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { floors } from '../db/schema';

export const floorsRouter = Router();

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// The engineered plan (FloorPlan) of one floor, fetched when its floor-plan view opens.
floorsRouter.get('/:id/plan', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Floor not found' });
    const [row] = await db.select({ plan: floors.plan }).from(floors).where(eq(floors.id, req.params.id));
    if (!row) return res.status(404).json({ error: 'Floor not found' });
    if (!row.plan) return res.status(404).json({ error: 'This floor has no engineered plan' });
    // Re-imports update floors in place (same id), so revalidate every time; the ETag keeps it cheap.
    res.set('Cache-Control', 'no-cache').json(row.plan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load floor plan' });
  }
});
