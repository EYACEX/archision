import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Placeholder agent auth: shared bearer key from AGENT_API_KEY. Replace with real accounts later. */
export const requireAgent: RequestHandler = (req, res, next) => {
  const expected = process.env.AGENT_API_KEY;
  if (!expected) return res.status(503).json({ error: 'Status changes are disabled: AGENT_API_KEY not configured' });

  const given = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
