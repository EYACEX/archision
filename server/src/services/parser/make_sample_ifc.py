"""Write a small Revit-style IFC4 building for testing the IFC import.

3 storeys x 2 apartments. Like a Revit export, it has: storeys with elevations, walls with door and
window openings cut into them, doors, windows, slabs, furniture, and one IfcSpace per room
(Name = room number, LongName = room name). The unit each room belongs to is the "PV_Unit"
property, as a Revit shared parameter exported in a property set would be.

Usage: python make_sample_ifc.py OUT.ifc
"""
import sys

import numpy as np
import ifcopenshell
import ifcopenshell.api.aggregate as aggregate
import ifcopenshell.api.context as context
import ifcopenshell.api.feature as feature
import ifcopenshell.api.geometry as geometry
import ifcopenshell.api.project as project
import ifcopenshell.api.pset as pset
import ifcopenshell.api.root as root
import ifcopenshell.api.spatial as spatial
import ifcopenshell.api.unit as unit

W, D = 24.0, 12.0          # building footprint, metres
H = 3.2                    # storey height
EXT, INT = 0.25, 0.12      # wall thicknesses
STOREYS = 3


def placement(x, y, z, angle=0.0):
    m = np.eye(4)
    c, s = np.cos(angle), np.sin(angle)
    m[:3, :3] = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    m[:3, 3] = [x, y, z]
    return m


class Builder:
    def __init__(self):
        self.f = project.create_file(version="IFC4")
        proj = root.create_entity(self.f, ifc_class="IfcProject", name="PropView Sample Tower")
        unit.assign_unit(self.f)  # metres
        model = context.add_context(self.f, context_type="Model")
        self.body = context.add_context(self.f, context_type="Model", context_identifier="Body",
                                        target_view="MODEL_VIEW", parent=model)
        site = root.create_entity(self.f, ifc_class="IfcSite", name="Site")
        self.building = root.create_entity(self.f, ifc_class="IfcBuilding", name="Tower A")
        aggregate.assign_object(self.f, products=[site], relating_object=proj)
        aggregate.assign_object(self.f, products=[self.building], relating_object=site)

    def storey(self, n, z):
        st = root.create_entity(self.f, ifc_class="IfcBuildingStorey", name=f"Level {n}")
        st.Elevation = z
        geometry.edit_object_placement(self.f, product=st, matrix=placement(0, 0, z))
        aggregate.assign_object(self.f, products=[st], relating_object=self.building)
        return st

    def element(self, cls, st, rep, matrix, name=None):
        el = root.create_entity(self.f, ifc_class=cls, name=name)
        geometry.edit_object_placement(self.f, product=el, matrix=matrix)
        geometry.assign_representation(self.f, product=el, representation=rep)
        spatial.assign_container(self.f, products=[el], relating_structure=st)
        return el

    def wall(self, st, z, x0, y0, x1, y1, t, openings=()):
        """Straight wall centred on the line (x0,y0)-(x1,y1). openings: (offset_along, width, sill, height, kind)."""
        length = float(np.hypot(x1 - x0, y1 - y0))
        angle = float(np.arctan2(y1 - y0, x1 - x0))
        # add_wall_representation extrudes along local +X with thickness towards local +Y: shift by t/2.
        nx, ny = -np.sin(angle) * t / 2, np.cos(angle) * t / 2
        rep = geometry.add_wall_representation(self.f, context=self.body, length=length, height=H, thickness=t)
        wall = self.element("IfcWall", st, rep, placement(x0 - nx, y0 - ny, z, angle))
        for along, width, sill, height, kind in openings:
            ox = x0 - nx + np.cos(angle) * along
            oy = y0 - ny + np.sin(angle) * along
            hole = root.create_entity(self.f, ifc_class="IfcOpeningElement")
            geometry.edit_object_placement(self.f, product=hole, matrix=placement(ox, oy, z + sill, angle))
            geometry.assign_representation(self.f, product=hole, representation=geometry.add_wall_representation(
                self.f, context=self.body, length=width, height=height, thickness=t))
            feature.add_feature(self.f, feature=hole, element=wall)
            if kind == "door":
                # Door leaf drawn open at 90°, hinged at the opening start, like a plan symbol.
                leaf = geometry.add_wall_representation(self.f, context=self.body, length=width - 0.05, height=height - 0.02, thickness=0.04)
                filling = self.element("IfcDoor", st, leaf, placement(ox, oy, z, angle + np.pi / 2), name="Door")
            else:
                glass = geometry.add_wall_representation(self.f, context=self.body, length=width, height=height, thickness=0.02)
                gx, gy = ox + np.cos(angle + np.pi / 2) * (t / 2 - 0.01), oy + np.sin(angle + np.pi / 2) * (t / 2 - 0.01)
                filling = self.element("IfcWindow", st, glass, placement(gx, gy, z + sill, angle), name="Window")
            feature.add_filling(self.f, opening=hole, element=filling)  # IfcRelFillsElement, as Revit writes
        return wall

    def slab(self, st, z, poly):
        rep = geometry.add_slab_representation(self.f, context=self.body, depth=0.2, polyline=poly)
        return self.element("IfcSlab", st, rep, placement(0, 0, z - 0.2), name="Floor slab")

    def space(self, st, z, number, name, unit_code, x, y, w, d):
        rep = geometry.add_slab_representation(self.f, context=self.body, depth=H - 0.2,
                                               polyline=[(0, 0), (w, 0), (w, d), (0, d)])
        sp = root.create_entity(self.f, ifc_class="IfcSpace", name=number)
        sp.LongName = name
        geometry.edit_object_placement(self.f, product=sp, matrix=placement(x, y, z))
        geometry.assign_representation(self.f, product=sp, representation=rep)
        aggregate.assign_object(self.f, products=[sp], relating_object=st)
        ps = pset.add_pset(self.f, product=sp, name="Identity Data")
        pset.edit_pset(self.f, pset=ps, properties={"PV_Unit": unit_code})
        return sp

    def furniture(self, st, z, name, x, y, w, d, h):
        rep = geometry.add_slab_representation(self.f, context=self.body, depth=h, polyline=[(0, 0), (w, 0), (w, d), (0, d)])
        return self.element("IfcFurniture", st, rep, placement(x, y, z), name=name)


def apartment(b, st, z, n, ox, code, prefix):
    """12 x 12 m apartment at x offset ox: living + kitchen + bath along the south, two bedrooms north."""
    rooms = [  # number, name, x, y, w, d (interior, inside wall faces)
        ("01", "Living / Dining", 0, 0, 7, 6),
        ("02", "Kitchen", 7, 0, 5, 4),
        ("03", "Bathroom", 7, 4, 5, 2),
        ("04", "Master Bedroom", 0, 6, 6, 6),
        ("05", "Bedroom 2", 6, 6, 6, 6),
    ]
    for num, name, x, y, w, d in rooms:
        b.space(st, z, f"{prefix}{n}{num}", name, code, ox + x + INT / 2, y + INT / 2, w - INT, d - INT)
    # Internal walls, with doors from the living room / corridor side.
    b.wall(st, z, ox + 7, 0, ox + 7, 6, INT, openings=[(4.6, 0.9, 0, 2.1, "door")])
    b.wall(st, z, ox + 7, 4, ox + 12, 4, INT, openings=[(0.6, 0.8, 0, 2.1, "door")])
    b.wall(st, z, ox, 6, ox + 12, 6, INT, openings=[(4.6, 0.9, 0, 2.1, "door"), (7.2, 0.9, 0, 2.1, "door")])
    b.wall(st, z, ox + 6, 6, ox + 6, 12, INT)
    b.furniture(st, z, "Sofa", ox + 1.0, 0.8, 2.4, 0.9, 0.8)
    b.furniture(st, z, "Dining table", ox + 3.8, 3.0, 1.8, 1.0, 0.75)
    b.furniture(st, z, "Bed", ox + 1.5, 8.5, 1.8, 2.1, 0.5)
    b.furniture(st, z, "Bed", ox + 8.0, 8.8, 1.4, 2.0, 0.5)
    b.furniture(st, z, "Kitchen counter", ox + 7.3, 0.3, 4.4, 0.6, 0.9)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "sample-tower.ifc"
    b = Builder()
    for n in range(1, STOREYS + 1):
        z = (n - 1) * H
        st = b.storey(n, z)
        b.slab(st, z, [(0, 0), (W, 0), (W, D), (0, D)])
        win = lambda at: (at, 1.6, 0.9, 1.4, "window")
        # Exterior walls: windows on south and north, entrance doors on the west/east ends.
        b.wall(st, z, 0, 0, W, 0, EXT, openings=[win(1.5), win(4.5), win(8.5), win(13.5), win(16.5), win(20.5)])
        b.wall(st, z, W, 0, W, D, EXT, openings=[(1.5, 1.0, 0, 2.1, "door"), win(8.0)])
        b.wall(st, z, W, D, 0, D, EXT, openings=[win(1.5), win(4.5), win(8.5), win(13.5), win(16.5), win(20.5)])
        b.wall(st, z, 0, D, 0, 0, EXT, openings=[win(2.4), (9.5, 1.0, 0, 2.1, "door")])
        b.wall(st, z, 12, 0, 12, D, 0.2)  # party wall between the apartments
        apartment(b, st, z, n, 0, f"A-{n}01", "A")
        apartment(b, st, z, n, 12, f"A-{n}02", "B")
    b.f.write(out)
    print(f"Wrote {out}: {len(b.f.by_type('IfcBuildingStorey'))} storeys, {len(b.f.by_type('IfcSpace'))} spaces, "
          f"{len(b.f.by_type('IfcWall'))} walls, {len(b.f.by_type('IfcDoor'))} doors, {len(b.f.by_type('IfcWindow'))} windows")


if __name__ == "__main__":
    main()
