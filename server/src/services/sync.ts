import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, UnitStatusUpdate } from '../types';

export type SyncServer = Server<ClientToServerEvents, ServerToClientEvents>;

const room = (projectId: string) => `project:${projectId}`;

export function setupSync(io: SyncServer): void {
  io.on('connection', socket => {
    socket.on('join_project', projectId => {
      if (typeof projectId === 'string') socket.join(room(projectId));
    });
    socket.on('leave_project', projectId => {
      if (typeof projectId === 'string') socket.leave(room(projectId));
    });
  });
}

/** Broadcast to every client in the project room, across all server instances (Redis adapter). */
export function broadcastUnitUpdate(io: SyncServer, payload: UnitStatusUpdate): void {
  io.to(room(payload.project_id)).emit('unit_updated', payload);
}
