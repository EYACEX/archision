import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db';
import { projectCache, redis, redisPub, redisSub } from '../db/redis';
import { projects } from '../db/schema';

const USAGE = `Attach a baked model (pipeline/bake output folder) to a project.

  npm run model:attach -- --project <id> path/to/bake-out

Copies model.glb and its *_lightmap.webp (+ .mobile.webp) files to ASSETS_PATH/models/<id>/<timestamp>/
(a new folder per bake, so browser caches never serve a stale lightmap) and sets model_url.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { project: { type: 'string' } } });
  const [dir] = positionals;
  if (!values.project || !dir) { console.log(USAGE); process.exitCode = 1; return; }

  const files = (await readdir(dir)).filter(f => f === 'model.glb' || /_lightmap(\.mobile)?\.webp$/.test(f));
  if (!files.includes('model.glb')) throw new Error(`${dir} has no model.glb`);

  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, values.project));
  if (!project) throw new Error('Project not found');

  const version = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rel = `models/${project.id}/${version}`;
  const dest = path.resolve(process.env.ASSETS_PATH ?? './assets', rel);
  await mkdir(dest, { recursive: true });
  for (const f of files) await cp(path.join(dir, f), path.join(dest, f));

  await db.update(projects).set({ model_url: `/assets/${rel}/model.glb` }).where(eq(projects.id, project.id));
  await projectCache.invalidate(project.id);
  console.log(`Attached ${files.join(', ')} → /assets/${rel}/`);
}

main()
  .catch(err => { console.error(`Error: ${(err as Error).message}`); process.exitCode = 1; })
  .finally(async () => {
    await pool.end();
    for (const r of [redis, redisPub, redisSub]) r.disconnect();
  });
