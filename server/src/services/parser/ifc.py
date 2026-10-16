"""Parse an IFC model (Revit/Archicad export) into PropView storeys: units, rooms and an engineered plan.

Per storey:
  - plan: a horizontal section at --cut-height above the storey, the way architects draw plans.
    Cut elements (walls, columns, doors, windows, railings) are sliced; furniture, sanitary
    fittings and stairs below the cut are drawn in projection. Doors get a 90° swing arc.
  - units: rooms (IfcSpace) grouped by their unit code, read from a "PV_Unit" property (any
    property set; a Revit shared parameter) or, failing that, from the IfcZone they belong to.
    Spaces without a unit (corridors, lobbies) are drawn and labelled, but aren't sold.
  - outline: the storey's slabs; failing that, the walls and spaces, closed over.

Coordinates are metres in the model's own origin, plan north = +Y (true north is read from the
model and used for unit facing). Output: JSON on stdout. Warnings go into the JSON.

Usage: python ifc.py model.ifc [--cut-height 1.2]
"""
import argparse
import json
import math
import multiprocessing
import os
import sys
from functools import reduce

import numpy as np
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as uel
import ifcopenshell.util.placement as upl
import ifcopenshell.util.unit as uunit
from shapely import LineString, MultiPolygon, Polygon, unary_union
from shapely.geometry.polygon import orient
from shapely.ops import polygonize

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dxf import facing, room_type  # noqa: E402  shared with the DXF parser

CUT_CLASSES = ("IfcWall", "IfcColumn", "IfcCurtainWall", "IfcPlate", "IfcMember", "IfcDoor", "IfcWindow", "IfcRailing")
PROJECTED_CLASSES = ("IfcFurnishingElement", "IfcFurniture", "IfcSanitaryTerminal", "IfcStairFlight", "IfcStair")
UNIT_KEYS = ("pv_unit", "propview unit", "propview_unit", "unit code", "unit")
WALL_GAP = 0.15  # metres: closes the wall gaps between rooms when merging them into a unit outline


def ring_pts(coords):
    return [[round(x, 3), round(y, 3)] for x, y in list(coords)[:-1]]


def poly_rings(geom):
    """Shapely (Multi)Polygon → [[outer, hole, ...], ...] with rounded [x, y] points."""
    parts = geom.geoms if isinstance(geom, MultiPolygon) else [geom] if not geom.is_empty else []
    return [[ring_pts(p.exterior.coords), *[ring_pts(h.coords) for h in p.interiors]] for p in parts if p.area > 1e-4]


def to_points(ring):
    return [{"x": x, "y": y} for x, y in ring]


class Meshes:
    """World-space triangle meshes for a set of products, via the IfcOpenShell geometry iterator."""

    def __init__(self, model, products):
        self.by_id = {}
        if not products:
            return
        s = ifcopenshell.geom.settings()
        s.set("use-world-coords", True)
        s.set("weld-vertices", True)
        it = ifcopenshell.geom.iterator(s, model, max(1, multiprocessing.cpu_count() - 1), include=products)
        if it.initialize():
            while True:
                shape = it.get()
                g = shape.geometry
                verts = np.array(g.verts, dtype=np.float64).reshape(-1, 3)
                faces = np.array(g.faces, dtype=np.int64).reshape(-1, 3)
                if len(faces):
                    self.by_id[shape.id] = (verts, faces)
                if not it.next():
                    break

    def get(self, product):
        return self.by_id.get(product.id())

    def add_individually(self, products):
        """The iterator never yields IfcOpeningElements; build those one by one."""
        s = ifcopenshell.geom.settings()
        s.set("use-world-coords", True)
        for p in products:
            if p.id() in self.by_id:
                continue
            try:
                g = ifcopenshell.geom.create_shape(s, p).geometry
            except RuntimeError:
                continue
            self.by_id[p.id()] = (np.array(g.verts, dtype=np.float64).reshape(-1, 3),
                                  np.array(g.faces, dtype=np.int64).reshape(-1, 3))


def section(verts, faces, z):
    """Slice a triangle mesh with the plane Z=z. Returns the cut area (even-odd filled) or None."""
    above = verts[:, 2] >= z
    lines = []
    for tri in faces:
        a = above[tri]
        if a.all() or not a.any():
            continue
        pts = []
        for i, j in ((0, 1), (1, 2), (2, 0)):
            vi, vj = sorted((tri[i], tri[j]))  # same edge → same floats in both neighbouring triangles
            if above[vi] != above[vj]:
                p, q = verts[vi], verts[vj]
                t = (z - p[2]) / (q[2] - p[2])
                pts.append((round(p[0] + t * (q[0] - p[0]), 6), round(p[1] + t * (q[1] - p[1]), 6)))
        if len(pts) == 2 and pts[0] != pts[1]:
            lines.append(LineString(pts))
    if not lines:
        return None
    polys = [p for p in polygonize(unary_union(lines)) if p.area > 1e-6]
    if not polys:
        return None
    return reduce(lambda acc, p: acc.symmetric_difference(p), polys).buffer(0)


def projection(verts, faces, below=None):
    """Plan outline of a mesh seen from above: the union of its triangles projected onto XY."""
    tris = []
    for tri in faces:
        p = verts[tri]
        if below is not None and p[:, 2].min() > below:
            continue
        poly = Polygon(p[:, :2])
        if poly.is_valid and poly.area > 1e-6:
            tris.append(poly)
    return unary_union(tris).buffer(0) if tris else None


def door_swing(leaf, opening):
    """90° swing arc for a door leaf drawn open, hinged at the end nearest the opening's axis."""
    if leaf is None or opening is None:
        return None
    from shapely import Point
    c = [np.array(p) for p in list(leaf.minimum_rotated_rectangle.exterior.coords)[:4]]
    # The two short sides are the leaf's ends; their midpoints are the hinge and the tip.
    sides = sorted(((c[i], c[(i + 1) % 4]) for i in range(4)), key=lambda s: np.linalg.norm(s[1] - s[0]))
    end1, end2 = (sides[0][0] + sides[0][1]) / 2, (sides[1][0] + sides[1][1]) / 2
    # The hinge sits in the wall opening; the tip sticks out of it.
    hinge, tip = (end1, end2) if opening.distance(Point(end1)) <= opening.distance(Point(end2)) else (end2, end1)
    ocent = np.array(opening.centroid.coords[0])
    r = float(np.linalg.norm(tip - hinge))
    if r < 0.3:
        return None
    # Closed position: along the opening's long axis, away from the hinge.
    ob = opening.minimum_rotated_rectangle
    oc = list(ob.exterior.coords)[:4]
    axis = max(((np.array(oc[i]), np.array(oc[(i + 1) % 4])) for i in range(4)), key=lambda s: np.linalg.norm(s[1] - s[0]))
    d = axis[1] - axis[0]
    d = d / np.linalg.norm(d)
    if np.dot(ocent - hinge, d) < 0:
        d = -d
    a0 = math.atan2(tip[1] - hinge[1], tip[0] - hinge[0])
    a1 = math.atan2(d[1], d[0])
    sweep = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    pts = [[round(hinge[0] + r * math.cos(a0 + sweep * k / 16), 3), round(hinge[1] + r * math.sin(a0 + sweep * k / 16), 3)]
           for k in range(17)]
    return pts


def true_north_deg(model):
    for ctx in model.by_type("IfcGeometricRepresentationContext"):
        tn = getattr(ctx, "TrueNorth", None)
        if tn is not None:
            x, y = tn.DirectionRatios[0], tn.DirectionRatios[1]
            return math.degrees(math.atan2(x, y))  # clockwise from plan +Y
    return 0.0


def unit_code(space):
    for props in uel.get_psets(space).values():
        for key, value in props.items():
            if key.lower() in UNIT_KEYS and isinstance(value, str) and value.strip():
                return value.strip()
    for rel in getattr(space, "HasAssignments", []) or []:
        if rel.is_a("IfcRelAssignsToGroup") and rel.RelatingGroup.is_a("IfcZone") and rel.RelatingGroup.Name:
            return rel.RelatingGroup.Name.strip()
    return None


def storey_of(product):
    container = uel.get_container(product) or uel.get_aggregate(product)
    while container is not None and not container.is_a("IfcBuildingStorey"):
        container = uel.get_aggregate(container)
    return container


def parse(path, cut_height):
    warnings = []
    model = ifcopenshell.open(path)
    scale = uunit.calculate_unit_scale(model)  # project length unit → metres
    north = true_north_deg(model)

    storeys = sorted(model.by_type("IfcBuildingStorey"),
                     key=lambda s: upl.get_local_placement(s.ObjectPlacement)[2, 3] if s.ObjectPlacement else (s.Elevation or 0))
    if not storeys:
        raise ValueError("No IfcBuildingStorey in the model.")

    members = {s.id(): {"cut": [], "proj": [], "slabs": [], "spaces": []} for s in storeys}
    for cls, bucket in [(c, "cut") for c in CUT_CLASSES] + [(c, "proj") for c in PROJECTED_CLASSES] + [("IfcSlab", "slabs"), ("IfcSpace", "spaces")]:
        for el in model.by_type(cls):
            st = storey_of(el)
            if st is not None and el not in members[st.id()][bucket]:
                members[st.id()][bucket].append(el)
    openings = {}
    for door in model.by_type("IfcDoor"):
        for rel in door.FillsVoids or []:
            openings[door.id()] = rel.RelatingOpeningElement

    everything = [el for m in members.values() for b in m.values() for el in b]
    meshes = Meshes(model, everything)
    meshes.add_individually(list(openings.values()))

    def elevation(st):
        if st.ObjectPlacement:
            return float(upl.get_local_placement(st.ObjectPlacement)[2, 3]) * scale
        return float(st.Elevation or 0) * scale

    out = []
    for i, st in enumerate(storeys):
        m = members[st.id()]
        if not (m["cut"] or m["spaces"] or m["slabs"]):
            continue
        z0 = elevation(st)
        if i + 1 < len(storeys):
            z_next = elevation(storeys[i + 1])
        else:  # top storey: as tall as its walls
            tops = [meshes.get(el)[0][:, 2].max() for el in m["cut"] if meshes.get(el) is not None]
            z_next = max(tops) if tops else z0 + 3.0
        zc = z0 + cut_height
        label = st.Name or f"Level {len(out) + 1}"

        walls, windows, doors, swings, furniture = [], [], [], [], []
        for el in m["cut"]:
            mesh = meshes.get(el)
            if mesh is None:
                continue
            cut = section(*mesh, zc)
            if cut is None or cut.is_empty:
                continue
            if el.is_a("IfcWindow"):
                windows.append(cut)
            elif el.is_a("IfcDoor"):
                doors.append(cut)
                op = openings.get(el.id())
                op_mesh = meshes.get(op) if op is not None else None
                swing = door_swing(cut, projection(*op_mesh)) if op_mesh else None
                if swing:
                    swings.append(swing)
            else:
                walls.append(cut)
        for el in m["proj"]:
            mesh = meshes.get(el)
            if mesh is not None and mesh[0][:, 2].max() <= zc + 0.5:
                p = projection(*mesh)
                if p is not None:
                    furniture.append(p)

        slab_fp = [projection(*meshes.get(s)) for s in m["slabs"] if meshes.get(s)]
        slab_fp = [p for p in slab_fp if p is not None]
        wall_union = unary_union(walls) if walls else None

        # Spaces → rooms → units.
        labels, units_rooms = [], {}
        for sp in m["spaces"]:
            mesh = meshes.get(sp)
            if mesh is None:
                warnings.append(f"{label}: space {sp.Name} has no geometry; skipped.")
                continue
            fp = section(*mesh, min(zc, mesh[0][:, 2].max() - 0.05)) or projection(*mesh)
            if fp is None or fp.is_empty:
                continue
            fp = max(fp.geoms, key=lambda g: g.area) if isinstance(fp, MultiPolygon) else fp
            name = (sp.LongName or sp.Name or "").strip()
            area = round(fp.area, 2)
            at = fp.representative_point()
            labels.append({"x": round(at.x, 3), "y": round(at.y, 3), "text": name, "sub": f"{area:.1f} m²"})
            code = unit_code(sp)
            if not code:
                continue  # common area: drawn, not sold
            kind = room_type(name) if name else None
            if kind is None:
                warnings.append(f"{label}: room '{name or sp.Name}' in {code}: type not recognised, stored as storage.")
                kind = "storage"
            units_rooms.setdefault(code, []).append(
                {"type": kind, "label": name or None, "polygon": to_points(ring_pts(orient(fp).exterior.coords)), "area_sqm": area, "_geom": fp})

        if slab_fp:
            outline_geom = unary_union(slab_fp)
        else:
            pieces = [g for g in [wall_union] if g is not None] + [r["_geom"] for rs in units_rooms.values() for r in rs]
            if not pieces:
                warnings.append(f"{label}: nothing to build a floor outline from; skipped.")
                continue
            outline_geom = unary_union(pieces).buffer(WALL_GAP, join_style="mitre").buffer(-WALL_GAP, join_style="mitre")
            warnings.append(f"{label}: no slab; outline built from walls and rooms.")
        outline_geom = outline_geom.buffer(0)
        main_part = max(outline_geom.geoms, key=lambda g: g.area) if isinstance(outline_geom, MultiPolygon) else outline_geom
        main_part = orient(main_part)
        centre = main_part.centroid.coords[0]

        units = []
        for code, rooms in sorted(units_rooms.items()):
            merged = unary_union([r["_geom"] for r in rooms]).buffer(WALL_GAP, join_style="mitre").buffer(-WALL_GAP, join_style="mitre")
            if isinstance(merged, MultiPolygon):
                warnings.append(f"{label}: unit {code} has rooms that don't touch; using its largest part as the outline.")
                merged = max(merged.geoms, key=lambda g: g.area)
            for r in rooms:
                del r["_geom"]
            units.append({
                "unit_code": code,
                "polygon": to_points(ring_pts(orient(merged).exterior.coords)),
                "area_sqm": round(sum(r["area_sqm"] for r in rooms), 2),  # net: sum of room areas
                "facing": facing(centre, merged.centroid.coords[0], north),
                "bedrooms": sum(r["type"] == "bedroom" for r in rooms),
                "bathrooms": sum(r["type"] == "bathroom" for r in rooms),
                "rooms": rooms,
            })

        out.append({
            "name": label,
            "elevation": round(z0, 3),
            "height": round(max(z_next - z0, 2.0), 3),
            "outline": to_points(ring_pts(main_part.exterior.coords)),
            "holes": [to_points(ring_pts(h.coords)) for h in main_part.interiors],
            "units": units,
            "plan": {
                "walls": poly_rings(wall_union) if wall_union is not None else [],
                "windows": [r for w in windows for r in poly_rings(w)],
                "doors": [r for d in doors for r in poly_rings(d)],
                "swings": swings,
                "furniture": [r for f in furniture for r in poly_rings(f)],
                "labels": labels,
            },
        })

    if not out:
        raise ValueError("No storey has walls, slabs or spaces.")
    if not any(s["units"] for s in out):
        warnings.append("No space has a PV_Unit property or IfcZone: nothing will be for sale. See the Revit export guide.")
    return {"source": path, "north_deg": round(north, 2), "storeys": out, "warnings": warnings}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file")
    ap.add_argument("--cut-height", type=float, default=1.2, help="plan cut above each storey, metres")
    args = ap.parse_args()
    try:
        result = parse(args.file, args.cut_height)
    except (OSError, RuntimeError, ValueError) as err:
        print(f"{args.file}: {err}", file=sys.stderr)
        sys.exit(1)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
