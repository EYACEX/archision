"""Parse one DXF floor plan into PropView's normalized plan JSON (printed to stdout).

Layer convention (case-insensitive), see docs/architect-export-guide.md:
  FLOOR_OUTLINE  closed polyline(s): the floor footprint; inner ones become holes (courtyards, shafts)
  UNITS          closed polylines: unit boundaries
  UNIT_LABELS    TEXT/MTEXT inside a unit: its code, e.g. "A-#01" (# = floor number)
  ROOMS          closed polylines: rooms inside units
  ROOM_LABELS    TEXT/MTEXT inside a room: its name, e.g. "Bedroom 2" (type is inferred)

Coordinates are output in metres, in the drawing's own origin (not shifted), so several
floors parsed separately still line up. The Node importer shifts them to a common origin.

Usage: python dxf.py plan.dxf [--units mm|cm|m|in|ft] [--north DEG]
"""
import argparse
import json
import math
import sys

import ezdxf
from ezdxf import disassemble, path, recover

LAYER_OUTLINE = "FLOOR_OUTLINE"
LAYER_UNITS = "UNITS"
LAYER_UNIT_LABELS = "UNIT_LABELS"
LAYER_ROOMS = "ROOMS"
LAYER_ROOM_LABELS = "ROOM_LABELS"

# metres per drawing unit
UNIT_SCALE = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}
INSUNITS = {1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m"}

MIN_UNIT_AREA = 5.0  # m²; smaller closed shapes on UNITS are treated as drafting noise
MIN_ROOM_AREA = 0.5

ROOM_KEYWORDS = [  # first match wins
    ("bathroom", ("bath", "wc", "toilet", "shower", "ensuite", "powder")),
    ("kitchen", ("kitchen", "pantry")),
    ("balcony", ("balcony", "terrace", "loggia")),
    ("storage", ("store", "storage", "laundry", "closet", "wardrobe", "utility")),
    ("bedroom", ("bed", "master", "maid")),
    ("living", ("living", "lounge", "majlis", "dining", "family", "hall", "salon", "reception")),
]

FACINGS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def shoelace(pts):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2


def centroid(pts):
    a = shoelace(pts)
    if abs(a) < 1e-9:
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        cross = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    return (cx / (6 * a), cy / (6 * a))


def contains(poly, pt):
    x, y = pt
    inside = False
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def room_type(label):
    low = label.lower()
    for kind, words in ROOM_KEYWORDS:
        if any(w in low for w in words):
            return kind
    return None


def facing(from_pt, to_pt, north_deg):
    """8-way compass direction from the floor centre to a unit, plan north rotated by north_deg (clockwise)."""
    dx, dy = to_pt[0] - from_pt[0], to_pt[1] - from_pt[1]
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return "N"
    bearing = (math.degrees(math.atan2(dx, dy)) - north_deg) % 360  # 0 = plan up, clockwise
    return FACINGS[int((bearing + 22.5) // 45) % 8]


def detect_scale(doc, override, warnings):
    if override:
        return UNIT_SCALE[override]
    name = INSUNITS.get(doc.header.get("$INSUNITS", 0))
    if name:
        return UNIT_SCALE[name]
    warnings.append("Drawing has no units set ($INSUNITS); assuming millimetres. Pass --units to override.")
    return UNIT_SCALE["mm"]


def collect(doc, scale):
    """Walk modelspace (including block references) and bucket closed polygons and labels by layer."""
    polys = {LAYER_OUTLINE: [], LAYER_UNITS: [], LAYER_ROOMS: []}
    labels = {LAYER_UNIT_LABELS: [], LAYER_ROOM_LABELS: []}
    tolerance = 0.02 / scale  # flatten arcs to within 2 cm

    for e in disassemble.recursive_decompose(doc.modelspace()):
        layer = e.dxf.layer.upper()
        kind = e.dxftype()
        if layer in polys and kind in ("LWPOLYLINE", "POLYLINE"):
            closed = e.closed if kind == "LWPOLYLINE" else e.is_closed
            pts = [(v.x * scale, v.y * scale) for v in path.make_path(e).flattening(tolerance)]
            if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-3:
                pts.pop()
                closed = True
            if closed and len(pts) >= 3:
                polys[layer].append(pts)
        elif layer in labels and kind in ("TEXT", "MTEXT"):
            text = (e.plain_text() if kind == "MTEXT" else e.dxf.text).strip()
            if kind == "TEXT" and (e.dxf.get("halign", 0) or e.dxf.get("valign", 0)):
                at = e.dxf.get("align_point", e.dxf.insert)
            else:
                at = e.dxf.insert
            if text:
                labels[layer].append((text, (at.x * scale, at.y * scale)))
    return polys, labels


def label_inside(poly, candidates):
    return [text for text, at in candidates if contains(poly, at)]


def parse(file_path, units_override=None, north_deg=0.0):
    warnings = []
    doc, auditor = recover.readfile(file_path)
    if auditor.has_errors:
        warnings.append(f"DXF had {len(auditor.errors)} structural error(s); recovered what could be read.")
    scale = detect_scale(doc, units_override, warnings)
    polys, labels = collect(doc, scale)

    # Floor outline: largest polygon is the footprint, polygons inside it are holes.
    outlines = sorted(polys[LAYER_OUTLINE], key=lambda p: abs(shoelace(p)), reverse=True)
    unit_polys = [p for p in polys[LAYER_UNITS] if abs(shoelace(p)) >= MIN_UNIT_AREA]
    if not unit_polys:
        raise ValueError(f"No closed polylines on layer {LAYER_UNITS} (at least {MIN_UNIT_AREA} m²).")
    if outlines:
        outline = outlines[0]
        holes = [p for p in outlines[1:] if contains(outline, centroid(p))]
    else:
        xs = [x for p in unit_polys for x, _ in p]
        ys = [y for p in unit_polys for _, y in p]
        outline = [(min(xs), min(ys)), (max(xs), min(ys)), (max(xs), max(ys)), (min(xs), max(ys))]
        holes = []
        warnings.append(f"No {LAYER_OUTLINE} polyline; using the bounding box of the units as the footprint.")

    centre = centroid(outline)
    rooms = [p for p in polys[LAYER_ROOMS] if abs(shoelace(p)) >= MIN_ROOM_AREA]
    units = []
    for i, poly in enumerate(unit_polys, start=1):
        codes = label_inside(poly, labels[LAYER_UNIT_LABELS])
        if not codes:
            code = f"U{i:02d}"
            warnings.append(f"Unit at {fmt_pt(centroid(poly))} has no {LAYER_UNIT_LABELS} text; named {code}.")
        else:
            code = codes[0]
            if len(codes) > 1:
                warnings.append(f"Unit {code} has several labels {codes}; using the first.")

        unit_rooms = []
        for rp in rooms:
            if not contains(poly, centroid(rp)):
                continue
            names = label_inside(rp, labels[LAYER_ROOM_LABELS])
            name = names[0] if names else ""
            kind = room_type(name) if name else None
            if kind is None:
                warnings.append(f"Room '{name or 'unlabelled'}' in {code}: type not recognised, stored as storage.")
                kind = "storage"
            unit_rooms.append({
                "type": kind,
                "label": name or None,
                "polygon": to_points(rp),
                "area_sqm": round(abs(shoelace(rp)), 2),
            })

        units.append({
            "unit_code": code,
            "polygon": to_points(poly),
            "area_sqm": round(abs(shoelace(poly)), 2),
            "facing": facing(centre, centroid(poly), north_deg),
            "bedrooms": sum(r["type"] == "bedroom" for r in unit_rooms),
            "bathrooms": sum(r["type"] == "bathroom" for r in unit_rooms),
            "rooms": unit_rooms,
        })

    seen = set()
    for u in units:
        if u["unit_code"] in seen:
            warnings.append(f"Duplicate unit code {u['unit_code']} on this plan.")
        seen.add(u["unit_code"])

    return {
        "source": file_path,
        "outline": to_points(outline),
        "holes": [to_points(h) for h in holes],
        "units": units,
        "warnings": warnings,
    }


def to_points(pts):
    return [{"x": round(x, 3), "y": round(y, 3)} for x, y in pts]


def fmt_pt(p):
    return f"({p[0]:.1f}, {p[1]:.1f}) m"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file")
    ap.add_argument("--units", choices=sorted(UNIT_SCALE), help="override the drawing units")
    ap.add_argument("--north", type=float, default=0.0, help="plan north, degrees clockwise from straight up")
    args = ap.parse_args()
    try:
        result = parse(args.file, args.units, args.north)
    except (OSError, ezdxf.DXFError, ValueError) as err:
        print(f"{args.file}: {err}", file=sys.stderr)
        sys.exit(1)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
