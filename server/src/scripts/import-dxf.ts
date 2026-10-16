import { parseArgs } from 'node:util';
import { pool } from '../db';
import { redis, redisPub, redisSub } from '../db/redis';
import { parseDxf, type DxfOptions } from '../services/parser';
import { assembleProject, ImportError, importProject, type PlanAssignment } from '../services/importer';

const USAGE = `Import DXF floor plans into PropView.

  npm run import:dxf -- --name "Al Noor Tower" plans/ground.dxf:1 plans/typical.dxf:2-12

Each file is FILE:FLOORS, where FLOORS is a number, a range or a list (1 | 2-12 | 2,4,6-9).
A plan used for several floors must label units with '#' for the floor number, e.g. A-#01.

Options:
  --name NAME             project name (required for a new project)
  --project ID            re-import into an existing project; keeps status, price and reservations
  --floor-height M        storey height in metres (default 3)
  --units mm|cm|m|in|ft   override the drawing units ($INSUNITS)
  --north DEG             plan north, degrees clockwise from straight up (default 0)
  --address TEXT          project address
  --allow-removing-sold   let a re-import delete sold/reserved units missing from the drawings
  --dry-run               parse and report, but don't write to the database`;

function parseFloors(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    const end = b ?? a;
    if (!Number.isInteger(a) || !Number.isInteger(end) || a < 1 || end < a) throw new ImportError(`Bad floor list "${spec}"`);
    for (let n = a; n <= end; n++) out.push(n);
  }
  return out;
}

/** Split FILE:FLOORS on the last colon so Windows drive letters (D:\...) survive. */
function parseAssignment(arg: string): { file: string; floors: number[] } {
  const i = arg.lastIndexOf(':');
  const spec = arg.slice(i + 1);
  if (i <= 1 || !/^[\d,-]+$/.test(spec)) throw new ImportError(`"${arg}" must be FILE:FLOORS, e.g. typical.dxf:2-12`);
  return { file: arg.slice(0, i), floors: parseFloors(spec) };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      project: { type: 'string' },
      'floor-height': { type: 'string' },
      units: { type: 'string' },
      north: { type: 'string' },
      address: { type: 'string' },
      'allow-removing-sold': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length === 0) { console.log(USAGE); return; }
  if (!values.name) throw new ImportError('--name is required');

  const dxfOpts: DxfOptions = {
    units: values.units as DxfOptions['units'],
    north: values.north ? Number(values.north) : undefined,
  };
  const floorHeight = values['floor-height'] ? Number(values['floor-height']) : undefined;
  if (floorHeight !== undefined && !(floorHeight > 0 && floorHeight < 100)) throw new ImportError('--floor-height must be in metres, 0-100');

  const assignments: PlanAssignment[] = [];
  for (const arg of positionals) {
    const { file, floors } = parseAssignment(arg);
    const plan = await parseDxf(file, dxfOpts);
    const rooms = plan.units.reduce((n, u) => n + u.rooms.length, 0);
    console.log(`${file}: ${plan.units.length} units, ${rooms} rooms → floors ${floors[0]}${floors.length > 1 ? `–${floors.at(-1)}` : ''}`);
    for (const w of plan.warnings) console.warn(`  ⚠ ${w}`);
    assignments.push({ plan, floors });
  }

  const data = assembleProject(assignments, {
    name: values.name,
    floorHeight,
    location: values.address ? { lat: 0, lng: 0, address: values.address } : undefined,
  });
  const unitCount = data.floors.reduce((n, f) => n + f.units.length, 0);
  console.log(`\n"${data.name}": ${data.floors.length} floors, ${unitCount} units`);

  if (values['dry-run']) { console.log('Dry run — nothing written.'); return; }

  const result = await importProject(data, {
    projectId: values.project,
    allowRemovingCommitted: values['allow-removing-sold'],
  });
  console.log(`${values.project ? 'Updated' : 'Created'} project ${result.project_id}`);
  console.log(`  ${result.units_created} units created, ${result.units_updated} updated, ${result.units_removed.length} removed`);
  if (result.units_removed.length) console.log(`  removed: ${result.units_removed.join(', ')}`);
  console.log(`\nOpen http://localhost:5173/?project=${result.project_id}`);
}

main()
  .catch(err => {
    // Input and parser problems get a plain message; set DEBUG=1 for the stack.
    console.error(err instanceof Error && !process.env.DEBUG ? `Error: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    for (const r of [redis, redisPub, redisSub]) r.disconnect();
  });
