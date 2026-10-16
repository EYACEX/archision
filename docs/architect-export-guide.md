# Architect export guide — AutoCAD → PropView

> **Using Revit?** Use the IFC route in [revit-export-guide.md](revit-export-guide.md). It gives engineered floor plans (walls, doors, windows, furniture) and needs no layer conventions.

PropView builds the 3D building from your floor plans. Draw on the layers below, save as **DXF**, and run the import.

## 1. Save as DXF

PropView reads **DXF**, not DWG. In AutoCAD: **Save As → AutoCAD 2018 DXF (\*.dxf)**. Any DXF version works.
For a batch of DWG files, the free [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter) converts a whole folder at once.

One file per **distinct** floor plan. A typical floor shared by levels 2–12 is **one** file.

## 2. Layers

Layer names are case-insensitive. Everything else in the drawing (furniture, dimensions, hatches) is ignored, so you can export your working drawing as-is once these layers exist.

| Layer | What goes on it | Entity |
|---|---|---|
| `FLOOR_OUTLINE` | The outer edge of the floor slab. Draw lift cores, shafts and courtyards as extra closed polylines **inside** it. They become holes. | Closed polyline |
| `UNITS` | One boundary per sellable unit. Shapes under 5 m² are ignored. | Closed polyline |
| `UNIT_LABELS` | The unit code, placed **inside** the unit boundary. | TEXT or MTEXT |
| `ROOMS` | One boundary per room, inside its unit (optional but recommended). | Closed polyline |
| `ROOM_LABELS` | The room name, placed **inside** the room boundary. | TEXT or MTEXT |

- **Closed polylines only.** Use `PEDIT → Close` or `BOUNDARY` to make them. Arcs inside polylines are fine.
- **Blocks are fine.** Units drawn as block references are exploded on import. The entities *inside* the block must be on the layers above, not on layer `0`.
- **All plans for one building must share the same origin**, so the floors stack correctly. Xref or copy from a common base drawing.

## 3. Unit codes

- On a plan used for **one floor**, write the real code: `G-01`.
- On a **typical floor** used for several floors, write `#` where the floor number goes: `A-#01` becomes `A-201`, `A-301`, … `A-1201`.
- Codes must be unique across the building, up to 20 characters.

**Codes are how PropView recognises a unit on re-import.** Keep them stable. Renaming a unit in the drawing makes PropView treat it as a new, unsold unit.

## 4. Room names → room types

Bedrooms and bathrooms are counted from the room names:

| Type | Recognised words |
|---|---|
| bedroom | bed, master, maid |
| bathroom | bath, wc, toilet, shower, ensuite, powder |
| kitchen | kitchen, pantry |
| living | living, lounge, majlis, dining, family, hall, salon, reception |
| balcony | balcony, terrace, loggia |
| storage | store, storage, laundry, closet, wardrobe, utility |

Unrecognised names are stored as storage, and the import prints a warning.

## 5. Units and north

- Drawing units come from the DXF header (`UNITS` command, *Insertion scale*). If they're unset, millimetres are assumed. Override with `--units mm|cm|m|in|ft`.
- Unit facing (N, NE, …) is measured from the floor centre, with **plan up = north**. If your north arrow is rotated, pass `--north <degrees clockwise>`.

## 6. Run the import

From `server/` (one-time setup: `npm run parser:install`):

```bash
# New project: ground floor plan for level 1, typical plan for levels 2–12
npm run import:dxf -- --name "Al Rawda Tower" --floor-height 3.2 plans/ground.dxf:1 plans/typical.dxf:2-12

# Check a drawing without writing anything
npm run import:dxf -- --name test --dry-run plans/typical.dxf:2

# Updated drawings for an existing project: keeps status, price and reservations
npm run import:dxf -- --project <project-id> --name "Al Rawda Tower" plans/ground.dxf:1 plans/typical.dxf:2-12
```

Floor lists can be `3`, `2-12` or `2,4,6-9`.

**Re-import safety:** if a re-import would delete a sold or reserved unit (because its code disappeared from the drawings), it is refused and nothing changes. Fix the code in the drawing. To really remove such a unit, add `--allow-removing-sold`.

New units start **available with price 0**. Prices are set separately.

Sample drawings that follow this convention: `server/samples/` (regenerate with `npm run samples:dxf`).
