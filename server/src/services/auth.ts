import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db';
import { redis } from '../db/redis';
import { agents, sessions } from '../db/schema';
import type { AgentInfo } from '../types';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 32;
export const SESSION_DAYS = 7;

/** "scrypt$<salt hex>$<hash hex>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD = 10;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const toAgentInfo = (a: typeof agents.$inferSelect): AgentInfo => ({ id: a.id, email: a.email, name: a.name, role: a.role as AgentInfo['role'] });

/** New session; returns the bearer token (shown to the client once, stored only as a hash). */
export async function createSession(agentId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    token_hash: sha256(token),
    agent_id: agentId,
    expires_at: new Date(Date.now() + SESSION_DAYS * 864e5),
  });
  // Opportunistic cleanup so the table doesn't grow forever.
  await db.delete(sessions).where(lt(sessions.expires_at, new Date()));
  return token;
}

/** The active agent behind a bearer token, or null. */
export async function agentForToken(token: string): Promise<AgentInfo | null> {
  if (!token || token.length > 100) return null;
  const [row] = await db.select({ agent: agents }).from(sessions)
    .innerJoin(agents, eq(agents.id, sessions.agent_id))
    .where(and(eq(sessions.token_hash, sha256(token)), gt(sessions.expires_at, new Date()), eq(agents.active, true)));
  return row ? toAgentInfo(row.agent) : null;
}

export async function endSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token_hash, sha256(token)));
}

export async function endAllSessions(agentId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.agent_id, agentId));
}

/**
 * Fixed-window rate limit in Redis (shared by all server instances).
 * Returns true if allowed. Fails open if Redis is down: availability over strictness here.
 */
export async function rateLimit(key: string, max: number, windowS: number): Promise<boolean> {
  try {
    const k = `ratelimit:${key}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowS);
    return n <= max;
  } catch {
    return true;
  }
}
