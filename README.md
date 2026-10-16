# PropView

3D real-estate sales platform. See `CLAUDE.md` for the full design.

## Run locally

Needs **Node.js 20+** and **Docker Desktop** (running).

```bash
# 1. Database + Redis
docker compose up -d

# 2. Server (terminal 1)
cd server
cp ../.env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev            # http://localhost:3001

# 3. Client (terminal 2)
cd client
npm install
npm run dev            # http://localhost:5173
```

Open http://localhost:5173 — the building renders in 3D. Open it in two windows to see live sync.

## Agent panel and buyer requests

Sales staff use **http://localhost:5173/agent.html**. Create the first admin once:

```bash
cd server
npm run agent:create -- --email you@company.com --name "Your Name" --admin
```

It prints a random password once. Sign in at `/agent.html`; admins add the other agents in the **Agents** tab.

| Tab | Who | What |
|---|---|---|
| Units | everyone | Every unit with price and status. **Reserve / Sold / Release** changes it live for every viewer. Click a unit code to see its history (who changed what, when). |
| Requests | everyone | Buyers who tapped "Request a call back". Call them, then **Reserve unit**, mark **Contacted**, or **Dismiss**. |
| Prices | admins | Upload an Excel (.xlsx) or CSV sheet: `unit_code`, `price` (SAR) and optionally `status`. Arabic headers work too: رقم الوحدة، السعر، الحالة. You get a preview with % changes first; a sheet with any error applies nothing. **Download current prices** gives you a sheet to edit. |
| Agents | admins | Add agents (each gets a one-time random password), reset passwords, deactivate. |

**Buyers:** on the public site, tapping an apartment in a floor plan opens its details and a short form (name, phone, note). The unit stays available until an agent reserves it. Requests are limited to 5 per hour per network address, and a repeat request from the same phone for the same unit is merged.

Scripts and integrations can still use `Authorization: Bearer $AGENT_API_KEY`. Those changes are logged as "System".

## Open it on a phone (same Wi-Fi)

Find the PC's address (`ipconfig` → Wi-Fi IPv4, e.g. `10.7.0.147`) and open `http://<that-ip>:5173` on the phone. The client calls the API on the same host it was loaded from. In development the server accepts requests from any private-network origin (10.x, 192.168.x, 172.16–31.x). In production only `CLIENT_URL` is accepted, and it can be a comma-separated list.

If the phone can't connect, Windows Firewall must allow Node.js inbound for the network profile you're on.

## Try a live status change

```bash
curl -s localhost:3001/api/projects                 # copy the project "id"
curl -s localhost:3001/api/projects/<project-id>    # copy any unit "id"

curl -X PATCH localhost:3001/api/units/<unit-id> \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"status":"sold"}'
```

Status can be `available`, `reserved` or `sold`. Every open window updates instantly.

On Windows PowerShell, use `curl.exe` instead of `curl`.

## Import real floor plans (DXF)

Needs **Python 3.10+**. One-time: `cd server && npm run parser:install`.

```bash
cd server
npm run import:dxf -- --name "Al Rawda Tower" samples/ground-floor.dxf:1 samples/typical-floor.dxf:2-12
```

It prints a link like `http://localhost:5173/?project=<id>`. The project picker in the top-left switches between projects.
Layer names, unit-code rules and re-import behaviour for the architects: [`docs/architect-export-guide.md`](docs/architect-export-guide.md).

**Revit / Archicad (IFC), recommended.** Each level becomes a floor with an engineered plan (cut walls, doors with swings, windows, furniture, room areas). Rooms are grouped into units by a `PV_Unit` shared parameter. Setup and export settings are in [`docs/revit-export-guide.md`](docs/revit-export-guide.md).

```bash
cd server
npm run import:ifc -- --name "Sample Tower" samples/sample-tower.ifc
```

**3D-only DXF models** (just `3DFACE` meshes, no plan layers, e.g. a villa model) can't go through `import:dxf`. Instead, `mesh_plan.py` unions the slab faces at each level into a footprint and imports the building as one unit:

```bash
cd server
python src/services/parser/mesh_plan.py model.dxf --name "Modern House" --units m \
  --level "0:PAVIMENTO_PT,PAVIMENTO,PAVIMENTO_SALONE" --level "3.0:PAVIMENTO,PAVIMENTO_SALONE,PAVIMENTO_BALCONE" \
  --balcony-layers PAVIMENTO_BALCONE --unit-code VILLA-01 > house.json
curl -X POST localhost:3001/api/projects/import -H "Authorization: Bearer change-me" -H "Content-Type: application/json" --data-binary @house.json
```

To find each level's height and slab layers, look at the horizontal faces per layer. The unit has no rooms, so bedrooms and bathrooms come out as 0.

For other tools, the same import is available as `POST /api/projects/import` (new) and `POST /api/projects/:id/import` (update). Both take the `ProjectImport` JSON from `client/src/types/index.ts` and the agent Bearer key.

## Troubleshooting

- **Port 5432 already in use**: you have Postgres installed locally. Stop it, or change the port in `docker-compose.yml` and `DATABASE_URL` in `server/.env`.
- **Blank page / "Failed to fetch"**: the server isn't running — check terminal 1.
- **Reset demo data**: `cd server && npm run db:seed`, then refresh the browser. This also deletes imported projects.
- **`Could not start Python`**: Python isn't on PATH. Set `PYTHON_BIN` in `server/.env` to the full path of `python.exe`.
