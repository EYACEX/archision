"""Write sample DXF floor plans (millimetres) that follow the PropView layer convention.

  ground-floor.dxf   4 retail units drawn as block references, codes G-01..G-04
  typical-floor.dxf  12 apartments with rooms, codes A-#01..A-#12 (# = floor number)

Both share an L-shaped footprint with a lift-core hole. Usage: python make_sample_dxf.py OUT_DIR
"""
import os
import sys

import ezdxf

OUTLINE = [(0, 0), (40000, 0), (40000, 18000), (18000, 18000), (18000, 32000), (0, 32000)]
CORE = [(18500, 10500), (21500, 10500), (21500, 17500), (18500, 17500)]  # lift + stair shaft

TYPICAL_UNITS = [  # x, y, w, h in mm
    (0, 0, 10000, 8000), (10000, 0, 10000, 8000), (20000, 0, 10000, 8000), (30000, 0, 10000, 8000),
    (22000, 10000, 9000, 8000), (31000, 10000, 9000, 8000),
    (0, 10000, 8000, 8000), (10000, 10000, 8000, 8000),
    (0, 18000, 8000, 7000), (0, 25000, 8000, 7000),
    (10000, 18000, 8000, 7000), (10000, 25000, 8000, 7000),
]
GROUND_UNITS = [(0, 0, 20000, 8000), (20000, 0, 20000, 8000), (22000, 10000, 18000, 8000), (0, 10000, 18000, 22000)]


def rect(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def new_doc():
    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 4  # millimetres
    for name, color in [("FLOOR_OUTLINE", 7), ("UNITS", 3), ("UNIT_LABELS", 2), ("ROOMS", 4), ("ROOM_LABELS", 6)]:
        doc.layers.add(name, color=color)
    return doc


def label(space, text, layer, x, y, height=300):
    space.add_text(text, height=height, dxfattribs={"layer": layer}).set_placement(
        (x, y), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)


def poly(space, pts, layer):
    space.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})


def add_footprint(msp):
    poly(msp, OUTLINE, "FLOOR_OUTLINE")
    poly(msp, CORE, "FLOOR_OUTLINE")


def apartment_rooms(x, y, w, h):
    """Living + kitchen + bath on one side, one or two bedrooms on the other."""
    lw, rh = w * 0.55, h * 0.6
    rooms = [
        ("Living / Dining", rect(x, y, lw, rh)),
        ("Kitchen", rect(x + lw, y, w - lw, rh * 0.6)),
        ("Bathroom", rect(x + lw, y + rh * 0.6, w - lw, rh * 0.4)),
    ]
    top = h - rh
    if w >= 9000:
        rooms += [("Master Bedroom", rect(x, y + rh, w / 2, top)), ("Bedroom 2", rect(x + w / 2, y + rh, w / 2, top))]
    else:
        rooms += [("Bedroom", rect(x, y + rh, w, top))]
    return rooms


def typical():
    doc = new_doc()
    msp = doc.modelspace()
    add_footprint(msp)
    for i, (x, y, w, h) in enumerate(TYPICAL_UNITS, start=1):
        poly(msp, rect(x, y, w, h), "UNITS")
        label(msp, f"A-#{i:02d}", "UNIT_LABELS", x + w / 2, y + h * 0.3, height=400)
        for name, pts in apartment_rooms(x, y, w, h):
            poly(msp, pts, "ROOMS")
            cx = sum(p[0] for p in pts) / 4
            cy = sum(p[1] for p in pts) / 4
            label(msp, name, "ROOM_LABELS", cx, cy - 400, height=200)
    return doc


def ground():
    """Units are block references here, to check the parser explodes INSERTs."""
    doc = new_doc()
    msp = doc.modelspace()
    add_footprint(msp)
    for i, (x, y, w, h) in enumerate(GROUND_UNITS, start=1):
        block = doc.blocks.new(f"SHOP_{i}")
        poly(block, rect(0, 0, w, h), "UNITS")
        label(block, f"G-{i:02d}", "UNIT_LABELS", w / 2, h / 2, height=500)
        msp.add_blockref(block.name, (x, y))
    return doc


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    typical().saveas(os.path.join(out, "typical-floor.dxf"))
    ground().saveas(os.path.join(out, "ground-floor.dxf"))
    print(f"Wrote typical-floor.dxf and ground-floor.dxf to {out}")


if __name__ == "__main__":
    main()
