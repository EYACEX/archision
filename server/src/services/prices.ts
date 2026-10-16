import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { projectCache } from '../db/redis';
import { floors, unitEvents, units } from '../db/schema';
import { broadcastUnitUpdate, type SyncServer } from './sync';
import { DEFAULT_HOLD_DAYS, UNIT_STATUSES, type PriceChange, type PriceRow, type PriceUploadResult, type UnitStatus } from '../types';

const MAX_ROWS = 5000;
const MAX_PRICE_SAR = 1e10; // 10 billion: anything bigger is a typo

/**
 * Apply a price sheet to one project, all-or-nothing: any bad row → nothing changes.
 * dryRun returns exactly what would change, for the upload preview.
 */
export async function applyPriceSheet(
  io: SyncServer, projectId: string, rows: unknown, opts: { dryRun: boolean; agentId: string | null; agentName: string },
): Promise<PriceUploadResult> {
  const errors: PriceUploadResult['errors'] = [];
  if (!Array.isArray(rows) || rows.length === 0) return { applied: false, changes: [], unchanged: 0, errors: [{ row: 0, error: 'The sheet has no rows' }] };
  if (rows.length > MAX_ROWS) return { applied: false, changes: [], unchanged: 0, errors: [{ row: 0, error: `At most ${MAX_ROWS} rows per upload` }] };

  const existing = await db.select({ id: units.id, unit_code: units.unit_code, price: units.price, status: units.status })
    .from(units).innerJoin(floors, eq(floors.id, units.floor_id)).where(eq(floors.project_id, projectId));
  const byCode = new Map(existing.map(u => [u.unit_code.toUpperCase(), u]));

  const seen = new Set<string>();
  const planned: (PriceChange & { id: string })[] = [];
  let unchanged = 0;
  rows.forEach((raw, i) => {
    const row = i + 1;
    const r = raw as Partial<PriceRow>;
    const code = typeof r?.unit_code === 'string' ? r.unit_code.trim() : '';
    if (!code) return errors.push({ row, error: 'Missing unit code' });
    const unit = byCode.get(code.toUpperCase());
    if (!unit) return errors.push({ row, unit_code: code, error: 'No such unit in this project' });
    if (seen.has(unit.unit_code)) return errors.push({ row, unit_code: code, error: 'Unit appears twice in the sheet' });
    seen.add(unit.unit_code);
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE_SAR) return errors.push({ row, unit_code: code, error: 'Price must be a positive amount in SAR' });
    if (r.status !== undefined && !UNIT_STATUSES.includes(r.status)) return errors.push({ row, unit_code: code, error: `Status must be one of: ${UNIT_STATUSES.join(', ')}` });
    const toPrice = Math.round(price * 100); // SAR → halalas
    const toStatus = (r.status ?? unit.status) as UnitStatus;
    if (toPrice === unit.price && toStatus === unit.status) { unchanged++; return; }
    planned.push({ id: unit.id, unit_code: unit.unit_code, from_price: unit.price, to_price: toPrice, from_status: unit.status as UnitStatus, to_status: toStatus });
  });

  const changes = planned.map(({ id: _id, ...c }) => c);
  // Nothing to write: errors, a preview, or a sheet that matches the database already.
  if (errors.length || opts.dryRun || planned.length === 0) {
    return { applied: !errors.length && !opts.dryRun, changes, unchanged, errors };
  }

  const holdUntil = new Date(Date.now() + DEFAULT_HOLD_DAYS * 864e5);
  await db.transaction(async tx => {
    for (const c of planned) {
      const statusChanged = c.to_status !== c.from_status;
      await tx.update(units).set({
        price: c.to_price,
        ...(statusChanged && { status: c.to_status, reserved_until: c.to_status === 'reserved' ? holdUntil : null }),
        updated_at: new Date(),
      }).where(eq(units.id, c.id));
      if (c.to_price !== c.from_price) {
        await tx.insert(unitEvents).values({ unit_id: c.id, agent_id: opts.agentId, action: 'price', from_value: String(c.from_price), to_value: String(c.to_price) });
      }
      if (statusChanged) {
        await tx.insert(unitEvents).values({ unit_id: c.id, agent_id: opts.agentId, action: 'status', from_value: c.from_status, to_value: c.to_status });
      }
    }
  });
  await projectCache.invalidate(projectId);

  // Re-read reserved_until so the broadcast matches the database exactly.
  const fresh = await db.select({ id: units.id, status: units.status, price: units.price, reserved_until: units.reserved_until })
    .from(units).where(inArray(units.id, planned.map(c => c.id)));
  for (const u of fresh) {
    broadcastUnitUpdate(io, {
      project_id: projectId, unit_id: u.id, status: u.status as UnitStatus, price: u.price,
      reserved_until: u.reserved_until?.toISOString(), updated_by: opts.agentName,
    });
  }
  return { applied: true, changes, unchanged, errors };
}
