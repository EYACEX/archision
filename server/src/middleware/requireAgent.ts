import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { agentForToken } from '../services/auth';
import type { AgentInfo } from '../types';

/** Who is making a request: a logged-in agent, or a system integration using AGENT_API_KEY. */
export interface Actor { agent: AgentInfo | null; system: boolean }

export const actorOf = (res: Response): Actor => res.locals.actor as Actor;
export const bearer = (header?: string) => header?.replace(/^Bearer\s+/i, '').trim() ?? '';

function isApiKey(given: string): boolean {
  const expected = process.env.AGENT_API_KEY;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Agent session token (agent panel) or AGENT_API_KEY (scripts, the future Revit plugin).
 * The key acts as an admin "system" actor; changes it makes are logged with no agent.
 */
export const requireAgent: RequestHandler = async (req, res, next) => {
  try {
    const token = bearer(req.header('authorization'));
    if (isApiKey(token)) {
      res.locals.actor = { agent: null, system: true } satisfies Actor;
      return next();
    }
    const agent = await agentForToken(token);
    if (!agent) return res.status(401).json({ error: 'Please sign in' });
    res.locals.actor = { agent, system: false } satisfies Actor;
    next();
  } catch (err) {
    next(err);
  }
};

/** After requireAgent: admins and the system key only. */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  const actor = actorOf(res);
  if (actor.system || actor.agent?.role === 'admin') return next();
  res.status(403).json({ error: 'Admins only' });
};
