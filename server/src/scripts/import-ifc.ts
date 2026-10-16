import { parseArgs } from 'node:util';
import { pool } from '../db';
import { redis, redisPub, redisSub } from '../db/redis';
import { parseIfc } from '../services/parser';
import { assembleIfcProject, ImportError, importProject } from '../services/importer';

const USAGE = `Import an IFC model (Revit / Archicad export) into PropView.

  npm run import:ifc -- --name "Al Rawda Tower" model.ifc

Every storey becomes a floor with an engineered plan. Rooms (IfcSpace) are grouped into units by
their PV_Unit property (or IfcZone). See docs/architect-export-guide.md, "Revit".

Options:
  --name NAME             project name (required)
  --project ID            re-import into an existing project; keeps status, price and reservations
  --cut-height M          plan cut above each storey, metres (default 1.2)
  --address TEXT          project address
  --allow-removing-sold   let a re-import delete sold/reserved units missing from the model
  --dry-run               parse and report, but don't write to the database`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      project: { type: 'string' },
      'cut-height': { type: 'string' },
      address: { type: 'string' },
      'allow-removing-sold': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [file] = positionals;
  if (values.help || !file) { console.log(USAGE); return; }
  if (!values.name) throw new ImportError('--name is required');

  const cutHeight = values['cut-height'] ? Number(values['cut-height']) : undefined;
  const model = await parseIfc(file, { cutHeight });
  for (const w of model.warnings) console.warn(`⚠ ${w}`);
  for (const s of model.storeys) {
    const p = s.plan;
    console.log(`${s.name.padEnd(14)} ${s.units.length} units, ${s.units.reduce((n, u) => n + u.rooms.length, 0)} rooms · plan: ` +
      `${p.walls.length} wall areas, ${p.doors.length} doors, ${p.windows.length} windows, ${p.furniture.length} furniture`);
  }

  const data = assembleIfcProject(model, {
    name: values.name,
    location: values.address ? { lat: 0, lng: 0, address: values.address } : undefined,
  });
  const unitCount = data.floors.reduce((n, f) => n + f.units.length, 0);
  console.log(`\n"${data.name}": ${data.floors.length} floors, ${unitCount} units`);
  if (values['dry-run']) { console.log('Dry run — nothing written.'); return; }

  const result = await importProject(data, { projectId: values.project, allowRemovingCommitted: values['allow-removing-sold'] });
  console.log(`${values.project ? 'Updated' : 'Created'} project ${result.project_id}`);
  console.log(`  ${result.units_created} units created, ${result.units_updated} updated, ${result.units_removed.length} removed`);
  if (result.units_removed.length) console.log(`  removed: ${result.units_removed.join(', ')}`);
  console.log(`\nOpen http://localhost:5173/?project=${result.project_id}`);
}

main()
  .catch(err => {
    console.error(err instanceof Error && !process.env.DEBUG ? `Error: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    for (const r of [redis, redisPub, redisSub]) r.disconnect();
  });
