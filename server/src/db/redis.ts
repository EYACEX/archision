import 'dotenv/config';
import { Redis } from 'ioredis';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

// General-purpose client (cache) plus a dedicated pub/sub pair for the socket.io adapter.
export const redis = new Redis(url);
export const redisPub = new Redis(url);
export const redisSub = new Redis(url);

const PROJECT_CACHE_TTL_S = 60 * 60;
const projectKey = (id: string) => `cache:project:${id}`;

export const projectCache = {
  get: (id: string) => redis.get(projectKey(id)),
  set: (id: string, json: string) => redis.set(projectKey(id), json, 'EX', PROJECT_CACHE_TTL_S),
  invalidate: (id: string) => redis.del(projectKey(id)),
};
