# PropView — Real Estate 3D Sales Platform

## Project Overview

PropView is a web platform for real estate developers to manage and display property units in 3D. Sales agents use it in-office to walk clients through building floors and unit details. Prospective buyers browse it on the web.

The core innovation: **no pre-rendered images**. The 3D scene is built procedurally in the browser from JSON data using Three.js, so any project can be loaded instantly without a rendering pipeline.

## Architecture

```
propview/
├── server/                    # Node.js + Express backend
│   ├── src/
│   │   ├── index.ts           # Entry point, Express + Socket.io setup
│   │   ├── routes/
│   │   │   ├── projects.ts    # GET /api/projects, GET /api/projects/:id
│   │   │   ├── floors.ts      # GET /api/floors/:projectId/:n
│   │   │   └── units.ts       # GET/PATCH /api/units/:id
│   │   ├── models/
│   │   │   ├── Project.ts     # Drizzle ORM schema
│   │   │   ├── Floor.ts
│   │   │   ├── Unit.ts
│   │   │   └── Room.ts
│   │   ├── services/
│   │   │   ├── parser/
│   │   │   │   ├── dxf.py     # Python ezdxf DXF→plan JSON (built)
│   │   │   │   ├── index.ts   # parseDxf(): spawns dxf.py
│   │   │   │   └── ifc.py     # Python ifcopenshell IFC→JSON (planned)
│   │   │   ├── importer.ts    # assembleProject() + importProject() (re-import keeps sales data)
│   │   │   └── sync.ts        # WebSocket broadcast logic
│   │   └── db/
│   │       ├── schema.ts      # Drizzle schema definitions
│   │       └── seed.ts        # Sample project data
│   ├── package.json
│   └── tsconfig.json
│
├── client/                    # Vite + TypeScript frontend
│   ├── src/
│   │   ├── main.ts            # App entry
│   │   ├── scenes/
│   │   │   ├── BuildingScene.ts   # Three.js procedural building
│   │   │   ├── FloorScene.ts      # SVG floor plan
│   │   │   └── UnitScene.ts       # Unit walkthrough + configurator
│   │   ├── components/
│   │   │   ├── StatusOverlay.ts   # Unit color legend + filters
│   │   │   ├── UnitPanel.ts       # Slide-in unit details panel
│   │   │   └── BookingFlow.ts     # Reserve → confirm flow
│   │   ├── stores/
│   │   │   └── project.ts         # Zustand store — project state
│   │   ├── api/
│   │   │   └── client.ts          # Fetch wrapper + socket listener
│   │   └── types/
│   │       └── index.ts           # Shared TypeScript types
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
│
├── docker-compose.yml         # PostgreSQL + Redis + server + client
├── .env.example
└── CLAUDE.md                  # This file
```

## Technology Choices and Why

**Backend: Node.js + Express + TypeScript**
Chosen for native WebSocket support via socket.io. Real-time unit status sync between multiple office displays is a core feature — latency must be under 100ms on LAN.

**Database: PostgreSQL with Drizzle ORM**
Units store polygon coordinates as JSONB columns. PostgreSQL handles spatial-ish queries well enough for our scale (thousands of units per project, not millions). Drizzle chosen over Prisma for lighter footprint and better TypeScript inference.

**Cache / Pub-Sub: Redis**
Unit status changes go through Redis pub/sub so multiple server instances can broadcast to the correct socket rooms. Also caches the full project JSON to avoid rebuilding from DB on every client connection.

**3D Engine: Three.js**
The browser renders the building procedurally — no pre-baked images, no external render farm. Each floor is an `ExtrudeGeometry` built from the floor's SVG outline. Unit colors update in real-time by changing mesh material colors.

For the office kiosk mode (high-spec machine on LAN), we enable:
- `THREE.PCFSoftShadowMap` for shadows
- `THREE.PMREMGenerator` for environment maps
- GLTF furniture models loaded from `/assets/models/`
- 4K textures from `/assets/textures/`

For public web mode (any device), we disable all of the above and use flat-shaded materials only.

**File Parsing: Python microservice**
DWG files (AutoCAD) are parsed with `ezdxf`. IFC files (BIM) use `ifcopenshell`. Both output the same normalized JSON schema. The Python service runs as a separate process, called from Node.js via child_process when a project file is uploaded.

**Frontend: Vite + Vanilla TypeScript (no framework)**
Three.js and framework reactivity systems conflict badly — Three.js owns the canvas update loop, React/Vue want to own DOM updates. Vanilla TS with a Zustand store gives us state management without the conflict. Vite for fast HMR during development.

## Core Data Model

```typescript
// types/index.ts — single source of truth, shared server/client

export type UnitStatus = 'available' | 'sold' | 'reserved';
export type Facing = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';

export interface Point2D { x: number; y: number; }

export interface Room {
  id: string;
  type: 'bedroom' | 'living' | 'kitchen' | 'bathroom' | 'balcony' | 'storage';
  polygon: Point2D[];
  area_sqm: number;
  label?: string;
}

export interface Unit {
  id: string;
  unit_code: string;           // "A-301"
  polygon: Point2D[];          // bounding polygon on floor plan
  area_sqm: number;
  status: UnitStatus;
  price: number;
  facing: Facing;
  bedrooms: number;
  bathrooms: number;
  floor_number: number;
  rooms: Room[];               // internal layout
  media: Media[];
  reserved_until?: string;     // ISO date
}

export interface Floor {
  id: string;
  project_id: string;
  floor_number: number;
  label: string;
  floor_height: number;        // metres — used for ExtrudeGeometry depth
  svg_outline: string;         // SVG path string for the floor footprint
  units: Unit[];
}

export interface Project {
  id: string;
  name: string;
  location: { lat: number; lng: number; address: string };
  total_floors: number;
  floors: Floor[];
  amenities: string[];
  thumbnail_url?: string;
  created_at: string;
}

export interface Media {
  type: 'image' | '360' | 'video';
  url: string;
  label?: string;
  is_primary?: boolean;
}

// WebSocket event payloads
export interface UnitStatusUpdate {
  unit_id: string;
  status: UnitStatus;
  reserved_until?: string;
  updated_by?: string;
}
```

## Key Implementation Details

### Building the 3D Scene (BuildingScene.ts)

```typescript
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import type { Floor } from '../types';

export class BuildingScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private floorMeshes = new Map<number, THREE.Mesh>();

  constructor(canvas: HTMLCanvasElement, isOfficeMode = false) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(isOfficeMode ? window.devicePixelRatio : 1);
    if (isOfficeMode) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 1000);
    this.camera.position.set(0, 80, 120);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
  }

  loadProject(floors: Floor[]) {
    this.clearScene();
    floors.forEach(floor => {
      const mesh = this.buildFloor(floor);
      this.scene.add(mesh);
      this.floorMeshes.set(floor.floor_number, mesh);
    });
  }

  private buildFloor(floor: Floor): THREE.Mesh {
    // Parse SVG path into Three.js Shape
    const shape = svgPathToThreeShape(floor.svg_outline);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: floor.floor_height,
      bevelEnabled: false,
    });
    const ratio = floor.units.filter(u => u.status === 'available').length / floor.units.length;
    const color = availabilityColor(ratio); // green→amber→red
    const material = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = (floor.floor_number - 1) * (floor.floor_height + 0.3);
    mesh.userData = { floorNumber: floor.floor_number };
    return mesh;
  }

  updateUnitStatus(floorNumber: number, unitId: string, status: string) {
    const floor = this.currentProject?.floors.find(f => f.floor_number === floorNumber);
    if (!floor) return;
    const unit = floor.units.find(u => u.id === unitId);
    if (unit) unit.status = status as any;
    const mesh = this.floorMeshes.get(floorNumber);
    if (mesh) {
      const ratio = floor.units.filter(u => u.status === 'available').length / floor.units.length;
      (mesh.material as THREE.MeshStandardMaterial).color.set(availabilityColor(ratio));
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
```

### WebSocket Live Sync

Sockets are **receive-only**. Status changes go through the authenticated REST endpoint, never a socket event, so public viewers can't change unit status.

Flow: agent tool → `PATCH /api/units/:id` (Bearer `AGENT_API_KEY`) → DB update → invalidate Redis project cache → `io.to('project:<id>').emit('unit_updated', payload)`. The `@socket.io/redis-adapter` delivers the broadcast to clients on every server instance.

- `server/src/services/sync.ts`: `join_project` / `leave_project` handlers + `broadcastUnitUpdate()`
- `server/src/routes/units.ts`: validation (status enum; `reserved_until` must be future, defaults to +3 days; cleared for non-reserved)
- `client/src/api/client.ts`: `subscribeToProject()` rejoins the room on every connect and calls `onReconnect` so the client refetches and replays missed changes
- Event maps `ServerToClientEvents` / `ClientToServerEvents` live in `types/index.ts`
- `AGENT_API_KEY` is a placeholder until real agent accounts exist

### DXF Import

ezdxf reads **DXF only**; DWG files are saved as DXF first (AutoCAD Save As, or ODA File Converter). Architect-facing rules: `docs/architect-export-guide.md`.

Flow: `npm run import:dxf -- --name X ground.dxf:1 typical.dxf:2-12` → `parseDxf()` spawns `dxf.py` per file → `assembleProject()` → `importProject()` → invalidate the project cache.

- `dxf.py` reads layers `FLOOR_OUTLINE` (inner rings become holes), `UNITS`, `UNIT_LABELS`, `ROOMS` and `ROOM_LABELS`. It explodes block references, converts to metres from `$INSUNITS`, infers room type from the label, and computes facing from the floor centre. It writes warnings to the JSON, not to stderr.
- It outputs coordinates in the drawing's own origin. `assembleProject()` shifts all plans by one shared offset so floors stay stacked, and expands `#` in unit codes to the floor number.
- `ProjectImport` in `types/index.ts` is the normalized format for every source (DXF now; IFC and the plugins later). `POST /api/projects/import` and `POST /api/projects/:id/import` take it directly and need the agent key.
- A re-import matches units by `unit_code`. It replaces geometry and rooms and keeps `status`, `price` and `reserved_until`. If it would delete sold or reserved units, it fails with a 409 unless `allow_removing_committed` is set. New units start available at price 0.

### Agents, Prices and Buyer Requests

- **Auth** is in `services/auth.ts`. Agents are email + scrypt password with role `admin|agent`. Sessions are random bearer tokens; only their SHA-256 is stored, and they last 7 days. Login is rate-limited in Redis per IP and per account. `requireAgent` accepts a session token or `AGENT_API_KEY`. The key is the "system" actor and also passes `requireAdmin`. `res.locals.actor` says who it was.
- **Audit:** every status or price change writes `unit_events` (agent_id null = system). `GET /api/units/:id/events` reads it.
- **Prices:** `POST /api/projects/:id/prices` (admin) takes `{rows: PriceRow[]}` with prices in SAR (major units) and stores halalas. `?dry_run=true` previews. It's all-or-nothing: any row error gives a 422 with the full result and nothing written. Applied changes broadcast `unit_updated` with `price`. Sheets are parsed client-side in `client/src/agent/sheet.ts` (CSV + .xlsx via read-excel-file; English and Arabic headers, Arabic digits).
- **Holds:** `POST /api/units/:id/hold-requests` is public and rate-limited (5/h/IP), with duplicates (same unit + phone, open) merged. The unit status does **not** change. Agents use `GET /api/holds` and `PATCH /api/holds/:id`. Buyer personal data is only exposed on agent endpoints.
- **Client:** `agent.html` + `src/agent/*` is the agent panel. It builds DOM only via the `h()` helper (textContent), because it shows buyer-entered text. `components/UnitPanel.ts` is the buyer drawer that opens when a unit in `FloorScene` is clicked.
- Bootstrap the first admin with `npm run agent:create -- --email … --name … --admin`. Local test accounts go in `server/.dev-agents.txt` (git-ignored).

### IFC Import (Revit / Archicad), the recommended source

`npm run import:ifc -- --name X model.ifc` → `parseIfc()` spawns `ifc.py` (IfcOpenShell + shapely) → `assembleIfcProject()` → `importProject()`. Architect-facing rules are in `docs/revit-export-guide.md`.

- One IFC holds every storey. `IfcBuildingStorey`s sorted by elevation become floors 1..n. The top storey's height comes from its walls.
- Units come from `IfcSpace`s grouped by a `PV_Unit` property (any pset, i.e. a Revit shared parameter), falling back to `IfcZone`. Spaces without one are common areas: labelled, not sold. Room type comes from LongName via `dxf.room_type`.
- The plan is a section at `--cut-height` (default 1.2 m). Walls, columns, doors, windows and railings are sliced: mesh–plane segments, then polygonize, then even-odd. Furniture, sanitary fittings and stairs are drawn in projection. Door swings are derived from the leaf plus its `IfcRelFillsElement` opening. The geometry iterator skips openings, so those are built with `create_shape`.
- Plans are stored in `floors.plan` (jsonb `FloorPlan`) and kept out of the project JSON (only `has_plan` is sent). They're served by `GET /api/floors/:id/plan` with `no-cache` + ETag, since re-imports keep floor ids. `FloorScene` fetches the plan on open and draws furniture under the unit colours, walls, windows and doors over them, and room names + areas from the plan.

### Baked Realistic View

Built as an extension of "no render farm": rendering happens **once per project** on a GPU machine, never per viewer. See `pipeline/bake/README.md`.

- `pipeline/bake/bake_lightmap.py` (Blender, headless): Cycles bakes DIFFUSE direct+indirect light, **without surface colour**, into a lightmap atlas on a second UV map. Output: GLB with TEXCOORD_1, plus `*_lightmap.webp`. Baked nodes carry extras `{lightmap, lightmap_intensity}`.
- `npm run model:attach` copies the bake to `ASSETS_PATH/models/<project>/<version>/` and sets `projects.model_url`. The server serves `/assets` statically.
- Client: `scenes/bakedModel.ts` swaps baked meshes to `MeshBasicMaterial({ map, lightMap, lightMapIntensity: k·π })`, so they render unlit and cheap. On small screens it picks `.mobile.webp` lightmaps when they exist.
- `BuildingScene.setModel()` auto-aligns the model to the ground-floor footprint (quarter-turns × mirror). In the realistic view, slabs are invisible but still raycast. Hover, selection and live-status flashes show as a translucent slab over the model.
- Compression must keep TEXCOORD_1 (`--prune-attributes false`). `npm run check` in `pipeline/bake` enforces it.

## Database Schema (Drizzle)

```typescript
// server/src/db/schema.ts
import { pgTable, uuid, varchar, integer, decimal, jsonb, timestamp, text } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  location: jsonb('location').notNull(),
  total_floors: integer('total_floors').notNull(),
  amenities: jsonb('amenities').$type<string[]>().default([]),
  thumbnail_url: text('thumbnail_url'),
  created_at: timestamp('created_at').defaultNow(),
});

export const floors = pgTable('floors', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id).notNull(),
  floor_number: integer('floor_number').notNull(),
  label: varchar('label', { length: 100 }),
  floor_height: decimal('floor_height', { precision: 4, scale: 2 }).notNull().default('3.00'),
  svg_outline: text('svg_outline').notNull(),
});

export const units = pgTable('units', {
  id: uuid('id').primaryKey().defaultRandom(),
  floor_id: uuid('floor_id').references(() => floors.id).notNull(),
  unit_code: varchar('unit_code', { length: 20 }).notNull(),
  polygon: jsonb('polygon').$type<Point2D[]>().notNull(),
  area_sqm: decimal('area_sqm', { precision: 6, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('available'),
  price: decimal('price', { precision: 12, scale: 2 }).notNull(),
  facing: varchar('facing', { length: 5 }),
  bedrooms: integer('bedrooms').notNull(),
  bathrooms: integer('bathrooms').notNull(),
  reserved_until: timestamp('reserved_until'),
  updated_at: timestamp('updated_at').defaultNow(),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  unit_id: uuid('unit_id').references(() => units.id).notNull(),
  room_type: varchar('room_type', { length: 50 }).notNull(),
  polygon: jsonb('polygon').$type<Point2D[]>().notNull(),
  area_sqm: decimal('area_sqm', { precision: 5, scale: 2 }),
  label: varchar('label', { length: 100 }),
});
```

## Environment Variables

```bash
# .env.example
DATABASE_URL=postgresql://propview:password@localhost:5432/propview
REDIS_URL=redis://localhost:6379
PORT=3001
CLIENT_URL=http://localhost:5173
NODE_ENV=development

# Office kiosk mode — enables high-quality rendering, local assets
OFFICE_MODE=false
ASSETS_PATH=./assets
```

## Docker Setup

```yaml
# docker-compose.yml
version: '3.9'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: propview
      POSTGRES_USER: propview
      POSTGRES_PASSWORD: password
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  server:
    build: ./server
    ports: ["3001:3001"]
    environment:
      DATABASE_URL: postgresql://propview:password@postgres:5432/propview
      REDIS_URL: redis://redis:6379
    depends_on: [postgres, redis]

  client:
    build: ./client
    ports: ["5173:5173"]
    environment:
      VITE_API_URL: http://localhost:3001
      VITE_WS_URL: ws://localhost:3001

volumes:
  pgdata:
```

## Development Commands

```bash
# Start everything
docker-compose up -d

# Server dev (hot reload)
cd server && npm run dev

# Client dev (Vite HMR)
cd client && npm run dev

# Run DB migrations
cd server && npm run db:migrate

# Seed with sample project data
cd server && npm run db:seed

# Parse a DWG file (test)
python server/src/services/parser/dwg.py path/to/file.dwg

# Run tests
npm test
```

## What Claude Code Should Do First

When starting the project, do this in order:

1. `docker-compose up -d` to start PostgreSQL and Redis
2. `cd server && npm install && npm run db:migrate && npm run db:seed`
3. `cd client && npm install`
4. `npm run dev` in both directories
5. Verify: `curl http://localhost:3001/api/projects` returns seeded data
6. Open `http://localhost:5173` — building should render in 3D

## Coding Conventions

- TypeScript strict mode everywhere — no `any` unless absolutely necessary
- All DB queries go through Drizzle ORM, never raw SQL except in migrations
- WebSocket events are typed — both emitter and listener use the same `UnitStatusUpdate` interface from `types/index.ts`
- Three.js scene classes own their own animation loops — never drive them from outside
- Error handling: all API routes return `{ error: string }` on failure with appropriate HTTP status
- The Python parser is called via `child_process.spawn`, never `exec` (security)
- All monetary values stored as integers (halalas/fils) in DB, divided by 100 for display

## Office Kiosk Mode vs Public Web

Detected via `OFFICE_MODE=true` env var on server, passed to client as `window.__OFFICE_MODE__`.

Office mode enables:
- High-res Three.js renderer (full device pixel ratio)
- Shadow maps and ambient occlusion post-processing
- GLTF furniture model loading from local `/assets/models/`
- 4K texture loading from `/assets/textures/`
- Unit configurator (change flooring, wall color, furniture set)
- Dual-display layout: admin view + client view on separate windows
- Offline fallback: full project data cached in IndexedDB on first load

Public web mode:
- Flat-shaded materials, no shadows
- Compressed WebP textures (200KB max per image)
- No GLTF models
- Progressive loading — floor plan first, 3D building after

## Later Phase: Revit & SketchUp Integration

Not in scope yet. Build only after the core platform (3D building, floor plans, live sync, booking) ships.

**Who exports:** our own in-house architects produce and upload the model files — not client architects. This means we control the naming conventions, and a plugin is worth building once the export/upload loop becomes a daily chore.

### Step 1 — File upload (covers both tools with the planned parsers)
- **Revit** → export IFC. Revit Rooms arrive as `IfcSpace`; map them to PropView units/rooms in `ifc.py`.
- **SketchUp** → export IFC (preferred) or DWG (Pro). SketchUp has no room concept, so our architects follow a naming convention:
  - Unit boundaries: group/tag named `UNIT <unit_code>` (e.g. `UNIT A-301`)
  - Rooms inside a unit: `ROOM <type>` (e.g. `ROOM bedroom`), type from `Room['type']`
  - Floor footprint: `FLOOR_OUTLINE`
- DWG files from either tool use the existing layer convention (`UNITS`, `FLOOR_OUTLINE`).
- Document the export settings and naming convention for the architects in `docs/architect-export-guide.md`.

### Step 2 — Live "Publish to PropView" plugins
- **Revit add-in** (C#, Revit API): reads Levels, Rooms and Areas directly and sends them to PropView.
- **SketchUp extension** (Ruby API): reads tagged groups per the convention above.
- Both send the **same normalized JSON** the Python parsers output, to a new authenticated endpoint (e.g. `POST /api/projects/:id/import`). The server must not care which source produced it.
- Re-publishing must update geometry without overwriting sales data: match units by `unit_code` and keep `status`, `price`, `reserved_until`.
- Plugins live in separate repos/folders (`integrations/revit/`, `integrations/sketchup/`) with their own build tooling.
