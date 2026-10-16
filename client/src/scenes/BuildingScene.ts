import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { Floor, Project, UnitStatusUpdate } from '../types';

const FLOOR_GAP = 0.3; // metres between floor slabs, so floors read as separate
const FLASH_MS = 1200; // how long a floor glows after a live status change

/** availability: procedural slabs coloured by status. realistic: the baked model, slabs shown only to highlight. */
export type BuildingView = 'availability' | 'realistic';

const BG_AVAILABILITY = new THREE.Color('#0f1115');
const BG_REALISTIC = new THREE.Color('#a9bdd1');
// Baked sunlit white plaster reaches ~2x albedo; this keeps it off pure white under ACES.
const REALISTIC_EXPOSURE = 0.6;

export interface BuildingSceneOptions {
  isOfficeMode?: boolean;
  onFloorHover?: (floor: Floor | null) => void;
  onFloorSelect?: (floor: Floor) => void;
}

/** Parse an SVG path `d` string into Three.js shapes (outer contours + holes). */
export function svgPathToThreeShapes(d: string): THREE.Shape[] {
  const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`);
  return data.paths.flatMap(p => SVGLoader.createShapes(p));
}

/** Map an availability ratio (0..1) to red → amber → green. */
export function availabilityColor(ratio: number): THREE.Color {
  const red = new THREE.Color('#d64545');
  const amber = new THREE.Color('#e0a030');
  const green = new THREE.Color('#3fae6a');
  const r = THREE.MathUtils.clamp(ratio, 0, 1);
  return r < 0.5 ? red.lerp(amber, r * 2) : amber.lerp(green, (r - 0.5) * 2);
}

/**
 * Share of available units on a floor. A floor with no units of its own (the upper storey of a
 * villa, a roof or plant level) follows the whole building instead of reading as sold out.
 */
function availableRatio(floor: Floor, project: Project): number {
  const pool = floor.units.length ? floor.units : project.floors.flatMap(f => f.units);
  if (pool.length === 0) return 0;
  return pool.filter(u => u.status === 'available').length / pool.length;
}

function pointInPolygon(p: THREE.Vector2, ring: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export class BuildingScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly building = new THREE.Group();
  private readonly floorMeshes = new Map<number, THREE.Mesh>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private currentProject: Project | null = null;
  private hovered: THREE.Mesh | null = null;
  private selected: THREE.Mesh | null = null;
  private frameId = 0;
  private readonly flashes = new Map<THREE.Mesh, number>(); // mesh → flash start time
  private ground!: THREE.Mesh;
  private model: THREE.Object3D | null = null;
  private view: BuildingView = 'availability';

  constructor(private readonly canvas: HTMLCanvasElement, private readonly opts: BuildingSceneOptions = {}) {
    const office = opts.isOfficeMode ?? false;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(office ? window.devicePixelRatio : 1);
    if (office) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    // Tone map for the baked model; the slab materials opt out to keep their exact status colours.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene.background = BG_AVAILABILITY.clone();
    this.scene.add(this.building);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    this.camera.position.set(0, 80, 120);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't orbit below the ground

    this.addLightsAndGround(office);

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('click', this.onClick);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.animate();
  }

  loadProject(project: Project): void {
    this.clearBuilding();
    this.currentProject = project;

    for (const floor of project.floors) {
      const mesh = this.buildFloor(floor);
      this.building.add(mesh);
      this.floorMeshes.set(floor.floor_number, mesh);
    }

    // Centre the building footprint on the origin and frame it.
    const box = new THREE.Box3().setFromObject(this.building);
    const center = box.getCenter(new THREE.Vector3());
    this.building.position.x -= center.x;
    this.building.position.z -= center.z;
    this.frameBuilding();
  }

  /**
   * Show a baked model (see loadBakedModel) aligned to the slabs: centred on the same footprint,
   * standing on the ground. Pass null to remove it. Switches to the realistic view.
   */
  setModel(model: THREE.Object3D | null): void {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse(o => {
        if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
      });
    }
    this.model = null;
    if (model) {
      this.alignModel(model);       // sets this.model to the alignment pivot wrapping it
      this.scene.add(this.model!);
    }
    this.setView(model ? 'realistic' : 'availability');
  }

  /**
   * CAD exports disagree on axes (Y-up vs Z-up, mirrored), so the baked model can come in rotated
   * relative to the floor plans. Try the 4 quarter-turns, each also mirrored, and keep the one
   * that puts the most of the model's ground-storey geometry inside the ground-floor footprint.
   */
  private alignModel(model: THREE.Object3D): void {
    // Measure by the building itself, not the much larger baked ground plane.
    model.updateMatrixWorld(true);
    const target = model.getObjectByName('building') ?? model;
    const box = new THREE.Box3().setFromObject(target);
    const center = box.getCenter(new THREE.Vector3());
    const ground = this.currentProject?.floors[0];
    const slab = ground && this.floorMeshes.get(ground.floor_number);

    // Model sample points: horizontal (x, z) around the model's centre, lowest storey only.
    const band = box.min.y + (ground?.floor_height ?? 3);
    const samples: THREE.Vector2[] = [];
    const v = new THREE.Vector3();
    target.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = o.geometry.getAttribute('position');
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.y <= band) samples.push(new THREE.Vector2(v.x - center.x, v.z - center.z));
      }
    });

    let best = { turns: 0, mirror: false, score: -1 };
    if (slab && samples.length) {
      // Footprint polygons in world (x, z), centred like the slabs are.
      const slabBox = new THREE.Box3().setFromObject(slab);
      const sc = slabBox.getCenter(new THREE.Vector3());
      const rings = svgPathToThreeShapes(ground.svg_outline).map(s =>
        s.extractPoints(4).shape.map(p => new THREE.Vector2(p.x + this.building.position.x - sc.x, -p.y + this.building.position.z - sc.z)));
      const inside = (p: THREE.Vector2) => rings.some(r => pointInPolygon(p, r));
      for (const mirror of [false, true]) {
        for (let turns = 0; turns < 4; turns++) {
          const a = turns * Math.PI / 2;
          const cos = Math.cos(a), sin = Math.sin(a);
          let hits = 0;
          for (const s of samples) {
            const x = mirror ? -s.x : s.x;
            // Same rotation three.js applies for rotation.y = a.
            if (inside(new THREE.Vector2(x * cos + s.y * sin, -x * sin + s.y * cos))) hits++;
          }
          const score = hits / samples.length;
          if (score > best.score + 0.02) best = { turns, mirror, score };
        }
      }
      console.info(`Baked model aligned: ${best.turns * 90}°${best.mirror ? ' mirrored' : ''}, ${(best.score * 100).toFixed(0)}% inside footprint`);
    }

    // Wrap so the alignment transform composes cleanly with whatever the glTF root carries.
    const slabCenter = slab ? new THREE.Box3().setFromObject(slab).getCenter(new THREE.Vector3()) : new THREE.Vector3();
    model.position.set(-center.x, -box.min.y, -center.z);
    const pivot = new THREE.Group();
    pivot.name = 'model-alignment';
    pivot.rotation.y = best.turns * Math.PI / 2;
    pivot.scale.x = best.mirror ? -1 : 1;
    pivot.position.set(slabCenter.x, 0, slabCenter.z);
    model.parent?.remove(model);
    pivot.add(model);
    this.model = pivot;
  }

  get hasModel(): boolean { return this.model !== null; }
  get currentView(): BuildingView { return this.view; }

  setView(view: BuildingView): void {
    this.view = view === 'realistic' && this.model ? 'realistic' : 'availability';
    const realistic = this.view === 'realistic';
    if (this.model) this.model.visible = realistic;
    this.ground.visible = !realistic;
    (this.scene.background as THREE.Color).copy(realistic ? BG_REALISTIC : BG_AVAILABILITY);
    this.renderer.toneMappingExposure = realistic ? REALISTIC_EXPOSURE : 1;
    for (const mesh of this.floorMeshes.values()) this.applyMaterialState(mesh);
  }

  /** Apply a live status change. Returns the affected floor, or null if the unit isn't in this project. */
  updateUnitStatus(update: UnitStatusUpdate): Floor | null {
    const floor = this.currentProject?.floors.find(f => f.units.some(u => u.id === update.unit_id));
    if (!floor) return null;
    const unit = floor.units.find(u => u.id === update.unit_id)!;
    if (update.price !== undefined) unit.price = update.price; // price changes don't recolour anything
    if (unit.status === update.status && unit.reserved_until === update.reserved_until) return floor;
    unit.status = update.status;
    unit.reserved_until = update.reserved_until;

    // Recolour this floor, plus unit-less floors since they follow the building total.
    const project = this.currentProject!;
    for (const f of project.floors) {
      if (f !== floor && f.units.length) continue;
      const mesh = this.floorMeshes.get(f.floor_number);
      if (!mesh) continue;
      mesh.userData.baseColor = availabilityColor(availableRatio(f, project));
      this.flashes.set(mesh, performance.now());
      this.applyMaterialState(mesh);
    }
    return floor;
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('click', this.onClick);
    this.clearBuilding();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private buildFloor(floor: Floor): THREE.Mesh {
    const geometry = new THREE.ExtrudeGeometry(svgPathToThreeShapes(floor.svg_outline), {
      depth: floor.floor_height,
      bevelEnabled: false,
    });
    // Shapes live in the XY plane (SVG coords); rotate so extrusion goes up the Y axis.
    geometry.rotateX(-Math.PI / 2);

    const baseColor = availabilityColor(availableRatio(floor, this.currentProject!));
    const material = new THREE.MeshStandardMaterial({
      color: baseColor, transparent: true, opacity: 0.9, roughness: 0.6, metalness: 0.05,
      flatShading: !this.opts.isOfficeMode, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = (floor.floor_number - 1) * (floor.floor_height + FLOOR_GAP);
    mesh.castShadow = mesh.receiveShadow = !!this.opts.isOfficeMode;
    mesh.userData = { floorNumber: floor.floor_number, baseColor };

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: '#0f1115', transparent: true, opacity: 0.6, toneMapped: false }),
    );
    mesh.add(edges);
    return mesh;
  }

  private addLightsAndGround(office: boolean): void {
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#30343c', 1.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(60, 120, 80);
    if (office) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, far: 400 });
    }
    this.scene.add(sun);

    const ground = this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(200, 64),
      new THREE.MeshStandardMaterial({ color: '#1a1d23', roughness: 1, toneMapped: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = office;
    this.scene.add(ground);
  }

  private frameBuilding(): void {
    const box = new THREE.Box3().setFromObject(this.building);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    // Fit the narrower of the two fields of view, so portrait phones see the whole building.
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist));
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private clearBuilding(): void {
    this.building.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.building.clear();
    this.building.position.set(0, 0, 0);
    this.floorMeshes.clear();
    this.flashes.clear();
    this.hovered = this.selected = null;
  }

  private pick(event: PointerEvent | MouseEvent): THREE.Mesh | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.floorMeshes.values()], false)[0];
    return (hit?.object as THREE.Mesh) ?? null;
  }

  private floorFor(mesh: THREE.Mesh | null): Floor | null {
    if (!mesh || !this.currentProject) return null;
    return this.currentProject.floors.find(f => f.floor_number === mesh.userData.floorNumber) ?? null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    const mesh = this.pick(e);
    if (mesh === this.hovered) return;
    const prev = this.hovered;
    this.hovered = mesh;
    if (prev) this.applyMaterialState(prev);
    if (mesh) this.applyMaterialState(mesh);
    this.canvas.style.cursor = mesh ? 'pointer' : '';
    this.opts.onFloorHover?.(this.floorFor(mesh));
  };

  private onClick = (e: MouseEvent): void => {
    const mesh = this.pick(e);
    if (!mesh) return;
    const prev = this.selected;
    this.selected = mesh;
    if (prev) this.applyMaterialState(prev);
    this.applyMaterialState(mesh);
    const floor = this.floorFor(mesh);
    if (floor) this.opts.onFloorSelect?.(floor);
  };

  private applyMaterialState(mesh: THREE.Mesh, now = performance.now()): void {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.color.copy(mesh.userData.baseColor as THREE.Color);

    let glow = mesh === this.selected ? 0.35 : mesh === this.hovered ? 0.18 : 0;
    const flashStart = this.flashes.get(mesh);
    if (flashStart !== undefined) {
      const t = (now - flashStart) / FLASH_MS;
      if (t >= 1) this.flashes.delete(mesh);
      else glow = Math.max(glow, 0.6 * (1 - t));
    }
    mat.emissive.setScalar(glow);

    // Realistic view: slabs are invisible but still pickable (raycasting ignores `visible`);
    // the hovered/selected/just-changed floor shows as a tinted overlay on the baked model.
    const realistic = this.view === 'realistic';
    mesh.visible = !realistic || glow > 0;
    mat.opacity = realistic ? 0.45 : 0.9;
    mat.depthWrite = !realistic;
    for (const child of mesh.children) child.visible = !realistic;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    if (this.flashes.size) {
      const now = performance.now();
      for (const mesh of [...this.flashes.keys()]) this.applyMaterialState(mesh, now);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
