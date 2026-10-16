# Architect export guide — Revit → PropView (IFC)

This is the recommended route for new projects. One Revit model gives PropView:
- **engineered floor plans** for every level: walls, doors with swings, windows, furniture, room names and areas;
- **units and rooms**: bedrooms and bathrooms counted, net areas, facing;
- the 3D model for the realistic bake (later).

The model just needs Levels, Rooms and one shared parameter.

## 1. In the model

**Levels.** Every sellable floor is a Level. Each Level becomes a PropView floor, ordered by elevation, and the floor is labelled with the Level name.

**Rooms.** Place a Room in every space: bedrooms, living, kitchen, bathrooms, balconies, corridors, lobby.
- *Name* is what buyers see ("Master Bedroom", "Living / Dining"). The room type comes from the name:

  | Type | Words in the name |
  |---|---|
  | bedroom | bed, master, maid |
  | bathroom | bath, wc, toilet, shower, ensuite, powder |
  | kitchen | kitchen, pantry |
  | living | living, lounge, majlis, dining, family, hall, salon, reception |
  | balcony | balcony, terrace, loggia |
  | storage | store, storage, laundry, closet, wardrobe, utility |

- The *Number* can follow your office standard; PropView doesn't use it.
- Room areas come from the room boundaries (net, inside the walls). A unit's area is the sum of its rooms.

**The `PV_Unit` shared parameter.** This is the only PropView-specific step.
1. Create a shared parameter **`PV_Unit`**: type Text, group Identity Data, category Rooms.
2. Fill it on every room that belongs to an apartment with the unit code, e.g. `A-301`. All rooms of one apartment get the same code.
3. Leave it empty for common areas (corridors, lobby, stairs). They are drawn and labelled on the plan but aren't for sale.

Unit codes must be unique across the building and at most 20 characters. **Keep them stable:** PropView recognises units by code on re-import. Renaming a code makes it a new, unsold unit.

Using Revit Zones instead? A room that belongs to an IfcZone uses the zone's name as its unit code when `PV_Unit` is empty.

**Walls across levels.** Walls, columns and curtain walls that span several levels must be split per level, either in the model or with the exporter option below. Otherwise they only appear on the level where they start.

**True north.** Set the project's True North. It's exported, and PropView uses it for each unit's facing (N, SE, …).

## 2. Export settings

**File → Export → IFC**, then **Modify Setup…**. Option names vary slightly between Revit versions.

| Tab | Setting | Value |
|---|---|---|
| General | IFC version | **IFC4 Reference View** (or IFC2x3 Coordination View 2.0) |
| General | Split walls, columns, ducts by level | **On** |
| Additional Content | Export rooms / spaces | **On** (rooms become IfcSpace) |
| Property Sets | Export Revit property sets | **On** (carries `PV_Unit`) |
| Property Sets | Export IFC common property sets | On |
| Level of Detail | Detail | Medium is enough |

Export the **whole model** (not a filtered view) and save the `.ifc` file.

## 3. Import

From `server/` (one-time setup: `npm run parser:install`):

```bash
# Check first: lists levels, units and plan contents, writes nothing
npm run import:ifc -- --name "Al Rawda Tower" --dry-run model.ifc

# New project
npm run import:ifc -- --name "Al Rawda Tower" --address "Olaya St, Riyadh" model.ifc

# Updated model for an existing project: keeps status, price and reservations
npm run import:ifc -- --project <project-id> --name "Al Rawda Tower" model.ifc
```

`--cut-height 1.5` moves the plan cut if your windows' sills are high; the default is 1.2 m above each level.

The dry run prints **warnings** worth reading:
- rooms whose type wasn't recognised;
- units whose rooms don't touch;
- no `PV_Unit` anywhere, which means nothing will be for sale.

**Re-import safety:** same as DXF. If a re-import would delete a sold or reserved unit, it is refused unless you pass `--allow-removing-sold`.

## What PropView draws from the model

| In Revit | On the PropView plan |
|---|---|
| Walls, columns, curtain walls, railings | Cut at 1.2 m, drawn solid |
| Windows | Blue, in the wall openings |
| Doors | Leaf plus a dashed 90° swing arc |
| Furniture, plumbing fixtures, stairs | Outline, seen from above |
| Rooms | Name and net area. Apartments are coloured by sales status. |

A sample model that follows this guide: `server/samples/sample-tower.ifc` (regenerate with `python src/services/parser/make_sample_ifc.py samples/sample-tower.ifc`).
