import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents } from '../db/schema';
import { actorOf, bearer, requireAdmin, requireAgent } from '../middleware/requireAgent';
import {
  MIN_PASSWORD, SESSION_DAYS, createSession, endAllSessions, endSession, hashPassword, rateLimit, toAgentInfo, verifyPassword,
} from '../services/auth';

export const authRouter = Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRouter.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    // Per IP and per account, so one attacker can't lock everyone out and can't spray one account.
    const okIp = await rateLimit(`login:ip:${req.ip}`, 30, 15 * 60);
    const okAccount = await rateLimit(`login:acct:${email}`, 10, 15 * 60);
    if (!okIp || !okAccount) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

    const [agent] = await db.select().from(agents).where(eq(agents.email, email));
    // Same message whether the email exists or not; still hash to keep timing similar.
    const valid = agent ? await verifyPassword(password, agent.password_hash) : (await hashPassword(password), false);
    if (!agent || !valid || !agent.active) return res.status(401).json({ error: 'Wrong email or password' });

    const token = await createSession(agent.id);
    res.json({ token, agent: toAgentInfo(agent), expires_in_days: SESSION_DAYS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

authRouter.post('/logout', async (req, res) => {
  const token = bearer(req.header('authorization'));
  if (token) await endSession(token).catch(() => {});
  res.status(204).end();
});

authRouter.get('/me', requireAgent, (_req, res) => {
  const { agent, system } = actorOf(res);
  res.json(agent ?? { id: 'system', email: '', name: 'System (API key)', role: system ? 'admin' : 'agent' });
});

// ---- Agent management (admins) ----

export const agentsRouter = Router();
agentsRouter.use(requireAgent, requireAdmin);

agentsRouter.get('/', async (_req, res) => {
  const rows = await db.select().from(agents).orderBy(asc(agents.name));
  res.json(rows.map(a => ({ ...toAgentInfo(a), active: a.active, created_at: a.created_at.toISOString() })));
});

agentsRouter.post('/', async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const name = String(req.body?.name ?? '').trim();
    const password = String(req.body?.password ?? '');
    const role = req.body?.role === 'admin' ? 'admin' : 'agent';
    if (!EMAIL.test(email) || email.length > 200) return res.status(400).json({ error: 'A valid email is required' });
    if (!name || name.length > 100) return res.status(400).json({ error: 'Name is required (max 100 characters)' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.email, email));
    if (existing) return res.status(409).json({ error: 'An agent with this email already exists' });
    const [agent] = await db.insert(agents).values({ email, name, role, password_hash: await hashPassword(password) }).returning();
    res.status(201).json({ ...toAgentInfo(agent), active: agent.active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// Deactivate / reactivate, change role, or reset password. Deactivating signs the agent out everywhere.
agentsRouter.patch('/:id', async (req, res) => {
  try {
    const { agent: me } = actorOf(res);
    const changes: Partial<typeof agents.$inferInsert> = {};
    if (typeof req.body?.active === 'boolean') changes.active = req.body.active;
    if (req.body?.role === 'admin' || req.body?.role === 'agent') changes.role = req.body.role;
    if (typeof req.body?.password === 'string') {
      if (req.body.password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
      changes.password_hash = await hashPassword(req.body.password);
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to change' });
    if (me?.id === req.params.id && (changes.active === false || changes.role === 'agent')) {
      return res.status(400).json({ error: "You can't deactivate or demote yourself" });
    }
    const [agent] = await db.update(agents).set(changes).where(eq(agents.id, req.params.id)).returning().catch(() => []);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (changes.active === false || changes.password_hash) await endAllSessions(agent.id);
    res.json({ ...toAgentInfo(agent), active: agent.active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});
