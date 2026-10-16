import 'dotenv/config';
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisPub, redisSub } from './db/redis';
import { agentsRouter, authRouter } from './routes/auth';
import { floorsRouter } from './routes/floors';
import { projectsRouter } from './routes/projects';
import { salesRouter } from './routes/sales';
import { unitsRouter } from './routes/units';
import { setupSync, type SyncServer } from './services/sync';

// CLIENT_URL may list several origins, comma-separated.
const clientUrls = (process.env.CLIENT_URL ?? 'http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean);
const PRIVATE_LAN = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;
const isDev = process.env.NODE_ENV !== 'production';

/** CLIENT_URL origins always; in development also phones and tablets on the local network. */
const allowOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
  cb(null, !origin || clientUrls.includes(origin) || (isDev && PRIVATE_LAN.test(origin)));

const app = express();
app.use(cors({ origin: allowOrigin }));
app.use(express.json({ limit: '20mb' })); // project imports carry full floor geometry

const httpServer = createServer(app);
const io: SyncServer = new Server(httpServer, {
  cors: { origin: allowOrigin },
  // Redis adapter: broadcasts reach clients connected to any server instance.
  adapter: createAdapter(redisPub, redisSub),
});
setupSync(io);

// Baked models and their lightmaps (pipeline/bake → npm run model:attach). Immutable per bake folder.
app.use('/assets', express.static(path.resolve(process.env.ASSETS_PATH ?? './assets'), { maxAge: '7d' }));

app.use('/api/auth', authRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/floors', floorsRouter);
app.use('/api/units', unitsRouter(io));
app.use('/api', salesRouter(io));

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => console.log(`PropView server listening on :${port}`));
