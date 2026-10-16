import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, FloorPlan, Project, ProjectSummary, ServerToClientEvents, UnitStatusUpdate } from '../types';

// Default: the API on the same host the page came from, so a phone opening http://<pc-ip>:5173
// talks to http://<pc-ip>:3001 rather than to itself.
export const API_URL = import.meta.env.VITE_API_URL ?? `${location.protocol}//${location.hostname}:3001`;
const WS_URL = import.meta.env.VITE_WS_URL ?? API_URL;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Absolute URL for a server-relative asset path such as a project's model_url. */
export const assetUrl = (path: string) => new URL(path, API_URL).href;

export const api = {
  listProjects: () => get<ProjectSummary[]>('/api/projects'),
  getProject: (id: string) => get<Project>(`/api/projects/${id}`),
  getFloorPlan: (floorId: string) => get<FloorPlan>(`/api/floors/${floorId}/plan`),
  /** Public: a buyer asks an agent to call about a unit. */
  requestHold: async (unitId: string, details: { name: string; phone: string; note?: string }) => {
    const res = await fetch(`${API_URL}/api/units/${unitId}/hold-requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Something went wrong. Please try again.');
    }
  },
};

export interface ProjectSubscription {
  /** Called for every live status change in this project. */
  onUnitUpdated: (update: UnitStatusUpdate) => void;
  /** Called after a dropped connection comes back — updates may have been missed, so resync. */
  onReconnect?: () => void;
  onConnectionChange?: (connected: boolean) => void;
}

/** Join the project's socket room. Returns an unsubscribe function. */
export function subscribeToProject(projectId: string, handlers: ProjectSubscription): () => void {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(WS_URL, { transports: ['websocket'] });
  let hasConnected = false;

  socket.on('connect', () => {
    // Rooms don't survive a reconnect, so join on every connect.
    socket.emit('join_project', projectId);
    handlers.onConnectionChange?.(true);
    if (hasConnected) handlers.onReconnect?.();
    hasConnected = true;
  });
  socket.on('disconnect', () => handlers.onConnectionChange?.(false));
  socket.on('unit_updated', update => {
    if (update.project_id === projectId) handlers.onUnitUpdated(update);
  });

  return () => {
    socket.emit('leave_project', projectId);
    socket.disconnect();
  };
}
