import { api, subscribeToProject } from '../api/client';
import { formatPrice } from '../format';
import type { AgentInfo, AgentRole, HoldRequest, HoldStatus, PriceUploadResult, Project, ProjectSummary, Unit, UnitStatus } from '../types';
import { agentApi, ApiError, session, setSignedOutHandler, type AgentRow } from './api';
import { priceSheetCsv, readPriceSheet, type ParsedSheet } from './sheet';

// ---------- tiny DOM helper: text is always set as textContent, never parsed as HTML ----------
type Child = Node | string | number | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const loginForm = document.querySelector<HTMLFormElement>('#login')!;
const loginError = document.querySelector<HTMLParagraphElement>('#login-error')!;
const app = document.querySelector<HTMLDivElement>('#app')!;

const STATUS_ACTIONS: { status: UnitStatus; label: string }[] = [
  { status: 'available', label: 'Release' }, { status: 'reserved', label: 'Reserve' }, { status: 'sold', label: 'Sold' },
];
const HOLD_POLL_MS = 30_000;
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pill = (s: string) => h('span', { class: `pill ${s}` }, s);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tab = 'units' | 'requests' | 'prices' | 'agents';

interface State {
  me: AgentInfo;
  projects: ProjectSummary[];
  project: Project | null;
  holds: HoldRequest[];
  tab: Tab;
  statusFilter: UnitStatus | 'all';
  search: string;
  sheet: { file: string; parsed: ParsedSheet; preview: PriceUploadResult | null } | null;
}
let state: State;
let unsubscribe: (() => void) | null = null;
let pollTimer = 0;
const flashed = new Set<string>(); // unit ids to highlight on the next render

// ---------- sign in / out ----------

function showLogin(message?: string) {
  app.hidden = true;
  loginForm.hidden = false;
  loginError.hidden = !message;
  loginError.textContent = message ?? '';
  unsubscribe?.(); unsubscribe = null;
  clearInterval(pollTimer);
  document.querySelector<HTMLInputElement>('#email')!.focus();
}
setSignedOutHandler(() => showLogin('Your session ended. Please sign in again.'));

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.querySelector<HTMLInputElement>('#email')!.value;
  const password = document.querySelector<HTMLInputElement>('#password')!;
  try {
    const { token } = await agentApi.login(email, password.value);
    session.set(token);
    password.value = '';
    await start();
  } catch (err) {
    loginError.hidden = false;
    loginError.textContent = errorText(err);
  }
});

async function signOut() {
  await agentApi.logout().catch(() => {});
  session.clear();
  showLogin();
}

// ---------- boot ----------

async function start() {
  const me = await agentApi.me();
  const projects = await api.listProjects();
  let saved: string | null = null;
  try { saved = localStorage.getItem('propview.agentProject'); } catch { /* ignore */ }
  state = { me, projects, project: null, holds: [], tab: 'units', statusFilter: 'all', search: '', sheet: null };
  loginForm.hidden = true;
  app.hidden = false;
  await openProject((projects.find(p => p.id === saved) ?? projects[0])?.id);
}

async function openProject(id: string | undefined) {
  unsubscribe?.(); unsubscribe = null;
  clearInterval(pollTimer);
  state.project = id ? await api.getProject(id) : null;
  state.sheet = null;
  if (state.project) {
    try { localStorage.setItem('propview.agentProject', state.project.id); } catch { /* ignore */ }
    const project = state.project;
    unsubscribe = subscribeToProject(project.id, {
      // Other agents' changes (and our own) arrive here; keep the table live.
      onUnitUpdated: u => {
        const unit = allUnits().find(x => x.id === u.unit_id);
        if (!unit) return;
        unit.status = u.status;
        unit.reserved_until = u.reserved_until;
        if (u.price !== undefined) unit.price = u.price;
        flashed.add(unit.id);
        render();
      },
      onReconnect: () => void openProject(project.id),
    });
    await loadHolds();
    pollTimer = window.setInterval(() => void loadHolds().then(render), HOLD_POLL_MS);
  }
  render();
}

async function loadHolds() {
  if (!state.project) return;
  try { state.holds = await agentApi.holds(state.project.id); } catch { /* keep the last list */ }
}

const allUnits = (): Unit[] => state.project?.floors.flatMap(f => f.units) ?? [];
const floorLabel = (n: number) => state.project?.floors.find(f => f.floor_number === n)?.label ?? `Level ${n}`;
const openHolds = () => state.holds.filter(x => x.status === 'open' || x.status === 'contacted');

// ---------- render ----------

function render() {
  const { me, projects, project } = state;
  const isAdmin = me.role === 'admin';
  const tabs: [Tab, string, number?][] = [
    ['units', 'Units'], ['requests', 'Requests', openHolds().length],
    ...(isAdmin ? [['prices', 'Prices'], ['agents', 'Agents']] as [Tab, string][] : []),
  ];
  const projectSelect = h('select', { onchange: (e: Event) => void openProject((e.target as HTMLSelectElement).value) },
    ...projects.map(p => h('option', { value: p.id, selected: p.id === project?.id }, p.name)));

  const content = !project ? h('p', { class: 'muted' }, 'No projects yet.')
    : state.tab === 'requests' ? renderRequests()
    : state.tab === 'prices' && isAdmin ? renderPrices()
    : state.tab === 'agents' && isAdmin ? renderAgents()
    : renderUnits();

  app.replaceChildren(
    h('header', {},
      h('h1', {}, 'PropView · Agents'), projectSelect,
      project && h('a', { href: `/?project=${project.id}`, target: '_blank', rel: 'noopener' }, 'Open 3D view ↗'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `${me.name} · ${me.role}`),
      h('button', { onclick: () => void signOut() }, 'Sign out')),
    h('nav', {}, ...tabs.map(([id, label, count]) =>
      h('button', { class: state.tab === id ? 'active' : '', onclick: () => { state.tab = id; render(); if (id === 'agents') void renderAgentsAsync(); } },
        label, count ? h('span', { class: 'badge' }, count) : null))),
    h('main', {}, content),
  );
  flashed.clear();
}

function renderUnits(): HTMLElement {
  const units = allUnits()
    .filter(u => state.statusFilter === 'all' || u.status === state.statusFilter)
    .filter(u => !state.search || u.unit_code.toLowerCase().includes(state.search.toLowerCase()));
  const counts = (s: UnitStatus) => allUnits().filter(u => u.status === s).length;
  const holdsByUnit = new Map<string, number>();
  for (const x of openHolds()) holdsByUnit.set(x.unit_id, (holdsByUnit.get(x.unit_id) ?? 0) + 1);

  const search = h('input', { type: 'search', placeholder: 'Search unit code', value: state.search });
  search.addEventListener('input', () => {
    state.search = search.value;
    render();
    const again = app.querySelector<HTMLInputElement>('input[type=search]');
    again?.focus(); again?.setSelectionRange(state.search.length, state.search.length);
  });

  const rows = units.map(u => {
    const tr = h('tr', { class: flashed.has(u.id) ? 'flash' : '' },
      h('td', {}, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void toggleHistory(tr, u); } }, u.unit_code)),
      h('td', {}, floorLabel(u.floor_number)),
      h('td', { class: 'num' }, `${u.area_sqm} m²`),
      h('td', { class: 'num' }, `${u.bedrooms} / ${u.bathrooms}`),
      h('td', { class: 'num' }, u.price > 0 ? formatPrice(u.price) : h('span', { class: 'muted' }, 'not set')),
      h('td', {}, pill(u.status), u.status === 'reserved' && u.reserved_until ? h('div', { class: 'muted' }, `until ${new Date(u.reserved_until).toLocaleDateString()}`) : null),
      h('td', {}, holdsByUnit.get(u.id) ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); state.tab = 'requests'; render(); } }, `${holdsByUnit.get(u.id)} request(s)`) : ''),
      h('td', {}, h('div', { class: 'actions' }, ...STATUS_ACTIONS.map(a =>
        h('button', { disabled: u.status === a.status, onclick: () => void changeStatus(u, a.status) }, a.label)))),
    );
    return tr;
  });

  return h('div', {},
    h('div', { class: 'toolbar' },
      search,
      h('select', { onchange: (e: Event) => { state.statusFilter = (e.target as HTMLSelectElement).value as State['statusFilter']; render(); } },
        ...(['all', 'available', 'reserved', 'sold'] as const).map(s => h('option', { value: s, selected: state.statusFilter === s },
          s === 'all' ? `All (${allUnits().length})` : `${s} (${counts(s)})`))),
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Unit', 'Floor', 'Area', 'Bed / Bath', 'Price', 'Status', 'Requests', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, ...rows))),
    !units.length ? h('p', { class: 'muted' }, 'No units match.') : null,
  );
}

async function changeStatus(u: Unit, status: UnitStatus) {
  if (status === 'sold' && !confirm(`Mark ${u.unit_code} as SOLD? Everyone viewing the building sees this immediately.`)) return;
  try {
    await agentApi.setStatus(u.id, status); // the live update re-renders the row
  } catch (err) {
    alert(`Couldn't update ${u.unit_code}: ${errorText(err)}`);
  }
}

async function toggleHistory(tr: HTMLTableRowElement, u: Unit) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains('history-row')) { next.remove(); return; }
  const cell = h('td', { colspan: 8, class: 'history' }, 'Loading history…');
  tr.after(h('tr', { class: 'history-row' }, cell));
  try {
    const events = await agentApi.history(u.id);
    cell.replaceChildren(events.length ? h('div', {}, ...events.map(e => h('div', {},
      `${fmtDate(e.at)} · ${e.by}: `,
      e.action === 'price' ? `price ${e.from && Number(e.from) > 0 ? formatPrice(Number(e.from)) : '—'} → ${formatPrice(Number(e.to))}` : `${e.from} → ${e.to}`)))
      : 'No changes recorded yet.');
  } catch (err) {
    cell.textContent = errorText(err);
  }
}

function renderRequests(): HTMLElement {
  const units = new Map(allUnits().map(u => [u.id, u]));
  const order: Record<HoldStatus, number> = { open: 0, contacted: 1, reserved: 2, dismissed: 3 };
  const list = [...state.holds].sort((a, b) => order[a.status] - order[b.status] || b.created_at.localeCompare(a.created_at));
  const rows = list.map(x => {
    const unit = units.get(x.unit_id);
    const active = x.status === 'open' || x.status === 'contacted';
    return h('tr', {},
      h('td', {}, fmtDate(x.created_at)),
      h('td', {}, x.unit_code, unit ? h('div', {}, pill(unit.status)) : null),
      h('td', {}, x.name),
      h('td', {}, h('a', { href: `tel:${x.phone.replace(/[^\d+]/g, '')}` }, x.phone)),
      h('td', { style: 'white-space: normal; min-width: 180px' }, x.note ?? ''),
      h('td', {}, pill(x.status), x.handled_by ? h('div', { class: 'muted' }, x.handled_by) : null),
      h('td', {}, active ? h('div', { class: 'actions' },
        x.status === 'open' ? h('button', { onclick: () => void setHold(x, 'contacted') }, 'Contacted') : null,
        h('button', { class: 'primary', disabled: unit?.status !== 'available', title: unit?.status !== 'available' ? 'Unit is no longer available' : '',
          onclick: () => void reserveFromHold(x) }, 'Reserve unit'),
        h('button', { onclick: () => void setHold(x, 'dismissed') }, 'Dismiss')) : ''),
    );
  });
  return h('div', {},
    h('p', { class: 'muted' }, 'Buyers who asked to hold a unit from the public site. Call them, then reserve the unit or dismiss the request. Refreshes every 30 s.'),
    list.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['Received', 'Unit', 'Name', 'Phone', 'Note', 'Status', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, ...rows)))
      : h('p', {}, 'No requests yet.'),
  );
}

async function setHold(x: HoldRequest, status: HoldStatus) {
  try {
    await agentApi.setHold(x.id, status);
    await loadHolds();
    render();
  } catch (err) { alert(errorText(err)); }
}

async function reserveFromHold(x: HoldRequest) {
  if (!confirm(`Reserve ${x.unit_code} for ${x.name}?`)) return;
  try {
    await agentApi.setStatus(x.unit_id, 'reserved');
    await setHold(x, 'reserved');
  } catch (err) { alert(errorText(err)); }
}

function renderPrices(): HTMLElement {
  const project = state.project!;
  const input = h('input', { type: 'file', accept: '.xlsx,.csv' });
  input.addEventListener('change', () => void loadSheet(input.files?.[0]));
  const download = () => {
    const blob = new Blob([priceSheetCsv(allUnits())], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${project.name} prices.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sheet = state.sheet;
  const preview = sheet?.preview;
  // The server numbers the rows it was sent (1..n); show the spreadsheet line instead.
  const serverErrors = (preview?.errors ?? []).map(e => ({ ...e, row: sheet!.parsed.lines[e.row - 1] ?? e.row }));
  const problems = [...(sheet?.parsed.problems ?? []), ...serverErrors];
  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Upload a price sheet'),
      h('p', { class: 'muted' },
        'Excel or CSV with a unit_code column and a price column in SAR (status is optional: available / reserved / sold). ',
        'Arabic headers work too: رقم الوحدة، السعر، الحالة. Nothing changes until you press Apply, and a sheet with any error applies nothing.'),
      h('div', { class: 'toolbar' }, input, h('button', { onclick: download }, 'Download current prices (CSV)')),
    ),
    sheet ? h('div', { class: 'card' },
      h('h2', {}, sheet.file),
      h('div', { class: 'summary' },
        h('span', {}, `${sheet.parsed.rows.length} rows read`),
        preview ? h('span', {}, `${preview.changes.length} changes`) : null,
        preview ? h('span', { class: 'muted' }, `${preview.unchanged} unchanged`) : null,
        problems.length ? h('span', { class: 'error' }, `${problems.length} problem(s)`) : null),
      problems.length ? h('div', { class: 'error' }, ...problems.slice(0, 50).map(p =>
        h('div', {}, `Row ${p.row}${'unit_code' in p && p.unit_code ? ` (${p.unit_code})` : ''}: ${p.error}`))) : null,
      preview && preview.changes.length ? h('div', { class: 'table-wrap', style: 'margin-top: 12px; max-height: 50vh' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['Unit', 'Price now', 'New price', 'Change', 'Status'].map(t => h('th', {}, t)))),
        h('tbody', {}, ...preview.changes.map(c => {
          const diff = c.from_price > 0 ? (c.to_price - c.from_price) / c.from_price : null;
          return h('tr', {},
            h('td', {}, c.unit_code),
            h('td', { class: 'num' }, c.from_price > 0 ? formatPrice(c.from_price) : '—'),
            h('td', { class: 'num' }, formatPrice(c.to_price)),
            h('td', { class: `num ${diff === null ? '' : diff > 0 ? 'up' : 'down'}` }, diff === null ? 'new' : `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)}%`),
            h('td', {}, c.from_status === c.to_status ? pill(c.to_status) : h('span', {}, pill(c.from_status), ' → ', pill(c.to_status))));
        })))) : null,
      h('div', { class: 'toolbar', style: 'margin-top: 12px' },
        h('button', { class: 'primary', disabled: !preview || problems.length > 0 || preview.changes.length === 0, onclick: () => void applySheet() },
          preview?.changes.length ? `Apply ${preview.changes.length} changes` : 'Nothing to apply'),
        h('button', { onclick: () => { state.sheet = null; render(); } }, 'Cancel')),
    ) : null,
  );
}

async function loadSheet(file: File | undefined) {
  if (!file) return;
  const parsed = await readPriceSheet(file);
  state.sheet = { file: file.name, parsed, preview: null };
  if (parsed.rows.length && !parsed.problems.length) {
    try { state.sheet.preview = await agentApi.uploadPrices(state.project!.id, parsed.rows, true); }
    catch (err) { parsed.problems.push({ row: 0, error: errorText(err) }); }
  }
  render();
}

async function applySheet() {
  const sheet = state.sheet;
  if (!sheet?.preview) return;
  if (!confirm(`Apply ${sheet.preview.changes.length} price changes to ${state.project!.name}? Buyers see the new prices immediately.`)) return;
  try {
    const result = await agentApi.uploadPrices(state.project!.id, sheet.parsed.rows, false);
    if (!result.applied) { sheet.preview = result; render(); return; } // something changed since the preview
    state.sheet = null;
    alert(`Done: ${result.changes.length} units updated.`);
    await openProject(state.project!.id);
  } catch (err) { alert(errorText(err)); }
}

// Agents tab: list loads on demand.
let agentRows: AgentRow[] | null = null;
let newSecret: { email: string; password: string } | null = null;

async function renderAgentsAsync() {
  try { agentRows = await agentApi.agents(); } catch (err) { alert(errorText(err)); }
  render();
}

const randomPassword = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 14);
};

function renderAgents(): HTMLElement {
  const email = h('input', { type: 'email', placeholder: 'email', required: true });
  const name = h('input', { placeholder: 'name', required: true });
  const role = h('select', {}, h('option', { value: 'agent' }, 'agent'), h('option', { value: 'admin' }, 'admin'));
  const form = h('form', { class: 'toolbar' }, email, name, role, h('button', { class: 'primary', type: 'submit' }, 'Add agent'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const password = randomPassword();
    try {
      await agentApi.createAgent({ email: email.value, name: name.value, role: role.value as AgentRole, password });
      newSecret = { email: email.value.trim().toLowerCase(), password };
      await renderAgentsAsync();
    } catch (err) { alert(errorText(err)); }
  });
  const resetPassword = async (a: AgentRow) => {
    if (!confirm(`Reset the password for ${a.name}? They'll be signed out everywhere.`)) return;
    const password = randomPassword();
    try { await agentApi.updateAgent(a.id, { password }); newSecret = { email: a.email, password }; render(); }
    catch (err) { alert(errorText(err)); }
  };
  const toggleActive = async (a: AgentRow) => {
    try { await agentApi.updateAgent(a.id, { active: !a.active }); await renderAgentsAsync(); }
    catch (err) { alert(errorText(err)); }
  };

  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Add an agent'), form,
      newSecret ? h('p', {}, `Password for ${newSecret.email}: `, h('span', { class: 'secret' }, newSecret.password),
        h('span', { class: 'muted' }, ' — shown once. Give it to them privately.')) : null),
    !agentRows ? h('p', { class: 'muted' }, 'Loading…') : h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Name', 'Email', 'Role', 'Status', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, ...agentRows.map(a => h('tr', {},
        h('td', {}, a.name), h('td', {}, a.email), h('td', {}, a.role),
        h('td', {}, a.active ? 'active' : h('span', { class: 'muted' }, 'deactivated')),
        h('td', {}, a.id === state.me.id ? h('span', { class: 'muted' }, 'you') : h('div', { class: 'actions' },
          h('button', { onclick: () => void resetPassword(a) }, 'Reset password'),
          h('button', { class: a.active ? 'danger' : '', onclick: () => void toggleActive(a) }, a.active ? 'Deactivate' : 'Reactivate')))))))),
  );
}

// ---------- go ----------
if (session.get()) {
  start().catch(err => showLogin(err instanceof ApiError && err.status === 401 ? undefined : errorText(err)));
} else {
  showLogin();
}
