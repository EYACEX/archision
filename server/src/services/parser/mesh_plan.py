"""Derive storey footprints from a 3D DXF model (3DFACE meshes) and write a ProjectImport JSON.

For 3D models that have no 2D plan layers: horizontal faces on the slab layers at each level are
unioned into a footprint. The whole building becomes ONE unit (a house/villa) on the lowest
storey. Its area is the enclosed floor area of all storeys, without balconies/terraces.
Rooms can't be derived from a mesh, so the unit has none.

Usage:
  python mesh_plan.py model.dxf --name "Modern House" \
      --level 0:PAVIMENTO_PT,PAVIMENTO,PAVIMENTO_SALONE \
      --level 3.0:PAVIMENTO,PAVIMENTO_SALONE,PAVIMENTO_BALCONE \
      --balcony-layers PAVIMENTO_BALCONE --unit-code VILLA-01 --units m > house.json
Then POST the JSON to /api/projects/import.
"""
import argparse
import json
import sys

from ezdxf import bbox, recover
from shapely import Polygon, MultiPolygon, unary_union
from shapely.geometry.polygon import orient

UNIT_SCALE = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}
INSUNITS = {1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m"}
Z_TOLERANCE = 0.02   # metres; faces this close to the level height count as the slab
WALL_GAP = 0.25      # metres; slabs stop at walls, so close gaps up to 2x this (0.5 m walls) in the outline


def faces_at(doc, z, layers, scale):
    polys = []
    for e in doc.modelspace().query("3DFACE"):
        if e.dxf.layer.upper() not in layers:
            continue
        pts = [e.dxf.vtx0, e.dxf.vtx1, e.dxf.vtx2, e.dxf.vtx3]
        if any(abs(p.z * scale - z) > Z_TOLERANCE for p in pts):
            continue
        ring = []
        for p in pts:
            xy = (p.x * scale, p.y * scale)
            if not ring or ring[-1] != xy:
                ring.append(xy)
        if len(ring) >= 3:
            poly = Polygon(ring)
            if poly.is_valid and poly.area > 1e-6:
                polys.append(poly)
    return polys


def floor_area(polys):
    """Net slab area: the raw union, without the wall gaps footprint() closes."""
    return unary_union(polys).area


def footprint(polys):
    merged = unary_union(polys).buffer(WALL_GAP, join_style="mitre").buffer(-WALL_GAP, join_style="mitre")
    parts = list(merged.geoms) if isinstance(merged, MultiPolygon) else [merged]
    return [orient(p.simplify(0.01), 1.0) for p in parts if p.area > 1.0]  # outer CCW, holes CW


def ring_points(coords, dx, dy):
    pts = list(coords)[:-1]  # shapely repeats the first point
    return [{"x": round(x - dx, 3), "y": round(y - dy, 3)} for x, y in pts]


def svg_path(parts, dx, dy):
    rings = []
    for p in parts:
        for ring in [p.exterior, *p.interiors]:
            pts = ring_points(ring.coords, dx, dy)
            rings.append("M" + " L".join(f"{q['x']} {q['y']}" for q in pts) + " Z")
    return " ".join(rings)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file")
    ap.add_argument("--name", required=True)
    ap.add_argument("--level", action="append", required=True, metavar="Z:LAYER,LAYER",
                    help="slab height (drawing units after scaling, metres) and its floor layers; repeat per storey, bottom first")
    ap.add_argument("--balcony-layers", default="", help="layers counted in the footprint but not in the unit area")
    ap.add_argument("--unit-code", default="VILLA-01")
    ap.add_argument("--facing", default="N", choices=["N", "S", "E", "W", "NE", "NW", "SE", "SW"])
    ap.add_argument("--units", choices=sorted(UNIT_SCALE), help="override the drawing units ($INSUNITS)")
    args = ap.parse_args()

    doc, _ = recover.readfile(args.file)
    scale = UNIT_SCALE[args.units] if args.units else UNIT_SCALE[INSUNITS.get(doc.header.get("$INSUNITS", 0), "mm")]
    top = bbox.extents(doc.modelspace(), fast=True).extmax.z * scale
    balcony = {s.strip().upper() for s in args.balcony_layers.split(",") if s.strip()}

    levels = []
    for spec in args.level:
        z, _, names = spec.partition(":")
        levels.append((float(z), {s.strip().upper() for s in names.split(",") if s.strip()}))
    levels.sort()

    storeys = []
    for i, (z, layers) in enumerate(levels):
        faces = faces_at(doc, z, layers, scale)
        parts = footprint(faces)
        if not parts:
            sys.exit(f"No horizontal faces on {sorted(layers)} at z={z} m. Check --level and --units.")
        enclosed = floor_area(faces_at(doc, z, layers - balcony, scale))
        height = (levels[i + 1][0] if i + 1 < len(levels) else top) - z
        storeys.append({"parts": parts, "enclosed_area": enclosed, "height": height})

    # Shared origin: bottom-left of everything, so storeys stay stacked.
    dx = min(p.bounds[0] for s in storeys for p in s["parts"])
    dy = min(p.bounds[1] for s in storeys for p in s["parts"])

    ground = max(storeys[0]["parts"], key=lambda p: p.area)
    unit = {
        "unit_code": args.unit_code,
        "polygon": ring_points(ground.exterior.coords, dx, dy),
        "area_sqm": round(sum(s["enclosed_area"] for s in storeys), 2),
        "facing": args.facing,
        "bedrooms": 0,
        "bathrooms": 0,
        "rooms": [],
    }
    floors = [{
        "floor_number": n,
        "label": "Ground" if n == 1 else f"Level {n}",
        "floor_height": round(s["height"], 2),
        "svg_outline": svg_path(s["parts"], dx, dy),
        "units": [unit] if n == 1 else [],
    } for n, s in enumerate(storeys, start=1)]

    for n, s in enumerate(storeys, start=1):
        print(f"storey {n}: footprint {sum(p.area for p in s['parts']):.1f} m², enclosed {s['enclosed_area']:.1f} m², "
              f"height {s['height']:.2f} m, {len(s['parts'])} part(s)", file=sys.stderr)
    json.dump({"name": args.name, "floors": floors}, sys.stdout)


if __name__ == "__main__":
    main()
