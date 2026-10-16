import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db';
import { redis, redisPub, redisSub } from '../db/redis';
import { agents } from '../db/schema';
import { hashPassword } from '../services/auth';

const USAGE = `Create an agent account (use this for the first admin; later admins can add agents in the panel).

  npm run agent:create -- --email sara@example.com --name "Sara" [--admin]

A random password is generated and printed once. The agent can change it from the panel (ask an admin).`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, admin: { type: 'boolean', default: false } } });
  const email = values.email?.trim().toLowerCase();
  if (!email || !values.name) { console.log(USAGE); process.exitCode = 1; return; }

  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.email, email));
  if (existing) throw new Error(`${email} already exists`);

  const password = randomBytes(12).toString('base64url');
  await db.insert(agents).values({ email, name: values.name, role: values.admin ? 'admin' : 'agent', password_hash: await hashPassword(password) });
  console.log(`Created ${values.admin ? 'admin' : 'agent'} ${email}`);
  console.log(`Password (shown once): ${password}`);
}

main()
  .catch(err => { console.error(`Error: ${(err as Error).message}`); process.exitCode = 1; })
  .finally(async () => {
    await pool.end();
    for (const r of [redis, redisPub, redisSub]) r.disconnect();
  });
