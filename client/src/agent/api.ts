import { API_URL } from '../api/client';
import type { AgentInfo, AgentRole, HoldRequest, HoldStatus, PriceRow, PriceUploadResult, UnitStatus, UnitStatusUpdate } from '../types';

const TOKEN_KEY = 'propview.agentToken';

// Storage can throw (private mode, blocked site data); the panel then just asks to sign in again.
export const session = {
  get: (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* session-only */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ } },
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) { super(message); }
}

/** Fetch with the agent's bearer token. A 401 clears the session and calls onSignedOut. */
let onSignedOut = () => {};
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

async function request<T>(method: string, path: string, body?: unknown, token = session.get()): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (res.status === 401 && path !== '/api/auth/login') { session.clear(); onSignedOut(); }
  // Price uploads answer 422 with a full result (the row errors) — that's data, not a failure.
  if (!res.ok && !(res.status === 422 && path.includes('/prices'))) {
    throw new ApiError((data as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}

export interface AgentRow extends AgentInfo { active: boolean; created_at?: string }
export interface UnitEvent { action: 'status' | 'price'; from: string | null; to: string | null; at: string; by: string }

export const agentApi = {
  login: (email: string, password: string) =>
    request<{ token: string; agent: AgentInfo }>('POST', '/api/auth/login', { email, password }, null),
  logout: () => request<void>('POST', '/api/auth/logout'),
  me: () => request<AgentInfo>('GET', '/api/auth/me'),

  setStatus: (unitId: string, status: UnitStatus) => request<UnitStatusUpdate>('PATCH', `/api/units/${unitId}`, { status }),
  history: (unitId: string) => request<UnitEvent[]>('GET', `/api/units/${unitId}/events`),

  uploadPrices: (projectId: string, rows: PriceRow[], dryRun: boolean) =>
    request<PriceUploadResult>('POST', `/api/projects/${projectId}/prices${dryRun ? '?dry_run=true' : ''}`, { rows }),

  holds: (projectId: string, status: HoldStatus | 'all' = 'all') =>
    request<HoldRequest[]>('GET', `/api/holds?project_id=${projectId}&status=${status}`),
  setHold: (id: string, status: HoldStatus) => request<{ ok: true }>('PATCH', `/api/holds/${id}`, { status }),

  agents: () => request<AgentRow[]>('GET', '/api/agents'),
  createAgent: (a: { email: string; name: string; role: AgentRole; password: string }) => request<AgentRow>('POST', '/api/agents', a),
  updateAgent: (id: string, changes: { active?: boolean; role?: AgentRole; password?: string }) =>
    request<AgentRow>('PATCH', `/api/agents/${id}`, changes),
};
