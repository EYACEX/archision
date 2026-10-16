import { api, assetUrl, subscribeToProject } from './api/client';
import { loadBakedModel } from './scenes/bakedModel';
import { formatPrice } from './format';
import { BuildingScene } from './scenes/BuildingScene';
import { FloorScene } from './scenes/FloorScene';
import type { Floor, Project, ProjectSummary } from './types';

declare global {
  interface Window { __OFFICE_MODE__?: boolean }
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hud = document.querySelector<HTMLDivElement>('#hud-body')!;
const live = document.querySelector<HTMLSpanElement>('#live')!;
const picker = document.querySelector<HTMLDivElement>('#picker')!;
const viewToggle = document.querySelector<HTMLDivElement>('#view-toggle-slot')!;

function describeFloor(floor: Floor, project: Project): string {
  if (!floor.units.length) {
    // e.g. the upper storey of a villa: it belongs to a unit drawn on another floor.
    const all = project.floors.flatMap(f => f.units);
    const owner = all.length === 1 ? `part of ${all[0].unit_code} (${all[0].status})` : 'no units on this floor';
    return `<strong>${floor.label}</strong> · ${owner}`;
  }
  const count = (s: string) => floor.units.filter(u => u.status === s).length;
  const available = floor.units.filter(u => u.status === 'available');
  const prices = available.map(u => u.price).filter(p => p > 0); // imported units start unpriced (0)
  const from = prices.length ? `from ${formatPrice(Math.min(...prices))}` : available.length ? 'prices not set' : 'fully committed';
  return `<strong>${floor.label}</strong> · ${count('available')} available, ${count('reserved')} reserved, ${count('sold')} sold<br>${from}`;
}

/** Project switcher: the choice lives in ?project=<id> so links and reloads keep it. */
function renderProjectPicker(projects: ProjectSummary[], currentId: string) {
  if (projects.length < 2) return;
  const select = document.createElement('select');
  select.id = 'project-picker';
  for (const p of projects) select.add(new Option(p.name, p.id, false, p.id === currentId));
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('project', select.value);
    location.assign(url);
  });
  picker.replaceChildren(select);
}

/** Realistic (baked model) ↔ availability (status-coloured slabs). Only shown when a model exists. */
function renderViewToggle(scene: BuildingScene) {
  const button = document.createElement('button');
  button.id = 'view-toggle';
  const label = () => { button.textContent = scene.currentView === 'realistic' ? 'Show availability' : 'Show realistic'; };
  button.addEventListener('click', () => {
    scene.setView(scene.currentView === 'realistic' ? 'availability' : 'realistic');
    label();
  });
  label();
  viewToggle.replaceChildren(button);
}

async function main() {
  const projects = await api.listProjects();
  if (!projects.length) { hud.textContent = 'No projects found. Run npm run db:seed or npm run import:dxf in server/.'; return; }
  const requested = new URLSearchParams(location.search).get('project');
  const summary = projects.find(p => p.id === requested) ?? projects[0];
  renderProjectPicker(projects, summary.id);
  const project: Project = await api.getProject(summary.id);
  const idle = `${project.name} · ${project.total_floors} floors<br>Hover a floor for details`;
  let hoveredFloor: Floor | null = null;
  const renderHud = () => {
    const shown = floorPlan.currentFloor ?? hoveredFloor;
    hud.innerHTML = shown ? describeFloor(shown, project) : idle;
  };
  const floorPlan = new FloorScene(document.body, {
    onBack: () => { floorPlan.close(); renderHud(); },
    loadPlan: floor => api.getFloorPlan(floor.id),
  });
  renderHud();

  const scene = new BuildingScene(canvas, {
    isOfficeMode: window.__OFFICE_MODE__ ?? false,
    onFloorHover: floor => { hoveredFloor = floor; renderHud(); },
    onFloorSelect: floor => { floorPlan.open(floor); renderHud(); },
  });
  scene.loadProject(project);
  // Procedural slabs show at once (progressive loading); the baked model replaces them when ready.
  if (project.model_url) {
    loadBakedModel(assetUrl(project.model_url))
      .then(model => { scene.setModel(model); renderViewToggle(scene); })
      .catch(err => console.warn('Baked model failed to load; staying on the availability view', err));
  }

  subscribeToProject(project.id, {
    onUnitUpdated: update => {
      const floor = scene.updateUnitStatus(update);
      if (floor && floor === floorPlan.currentFloor) floorPlan.updateUnitStatus(update);
      if (floor) renderHud(); // cheap, and unit-less floors describe units on other floors
    },
    onReconnect: async () => {
      // Replay any changes missed while offline by diffing against a fresh copy.
      const fresh = await api.getProject(project.id);
      for (const unit of fresh.floors.flatMap(f => f.units)) {
        scene.updateUnitStatus({ project_id: project.id, unit_id: unit.id, status: unit.status, reserved_until: unit.reserved_until });
      }
      floorPlan.refresh();
      renderHud();
    },
    onConnectionChange: connected => {
      live.textContent = connected ? '● Live' : '○ Reconnecting…';
      live.className = connected ? 'live on' : 'live';
    },
  });
}

main().catch(err => { hud.textContent = `Error: ${(err as Error).message}`; console.error(err); });
