"""Bake daylight into lightmaps and export a light glTF that any phone can display.

Runs inside Blender on the strong machine, once per project:

  blender -b --factory-startup -P bake_lightmap.py -- --obj model.obj --out out_dir [options]

What it does:
  1. Imports the OBJ (with its MTL textures) and adds a ground plane.
  2. Joins all opaque geometry into one mesh and gives it a second, non-overlapping UV map.
  3. Lights the scene (sun + sky) and bakes Cycles DIFFUSE direct+indirect light WITHOUT the
     surface colour: the lightmap holds only light, so the original tiling textures stay sharp.
  4. Normalises each lightmap to 8-bit sRGB WebP and records the scale needed to undo that.
  5. Exports GLB: TEXCOORD_0 = original texture UVs, TEXCOORD_1 = lightmap UVs. Each baked node
     carries extras {lightmap, lightmap_intensity}. Glass stays a separate, unbaked, transparent mesh.

The viewer renders: colour = base texture x lightmap x lightmap_intensity (unlit, so it's cheap).
"""
import argparse
import math
import os
import sys

import bpy
import numpy as np


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--obj", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=4096, help="building lightmap resolution (px)")
    ap.add_argument("--ground-size", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--glass", default="vetro,vetro_pannello",
                    help="comma-separated material name fragments treated as glass (not baked)")
    ap.add_argument("--sun-elevation", type=float, default=45.0, help="degrees above the horizon")
    ap.add_argument("--sun-azimuth", type=float, default=135.0, help="degrees, 0 = +Y, clockwise")
    ap.add_argument("--sun-strength", type=float, default=4.0)
    ap.add_argument("--sky-strength", type=float, default=1.0)
    ap.add_argument("--cpu", action="store_true", help="bake on the CPU instead of the GPU")
    ap.add_argument("--no-fix-normals", dest="fix_normals", action="store_false",
                    help="keep the model's own normals (only if they are known to be clean)")
    return ap.parse_args(argv)


def log(msg):
    print(f"[bake] {msg}", flush=True)


def setup_cycles(args):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = False  # bakes aren't denoised; we rely on samples + margin
    scene.render.bake.margin = 8
    scene.render.bake.target = "IMAGE_TEXTURES"
    if args.cpu:
        scene.cycles.device = "CPU"
        log("device: CPU")
        return
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == backend
            scene.cycles.device = "GPU"
            log(f"device: {backend} ({', '.join(d.name for d in gpus)})")
            return
    scene.cycles.device = "CPU"
    log("device: CPU (no GPU backend found)")


def import_model(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.obj_import(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    log(f"imported {len(meshes)} objects, {sum(len(o.data.polygons) for o in meshes)} faces")
    return meshes


def principled(mat):
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat.use_nodes else None


def fix_materials(meshes, glass_words):
    """Drop unreadable textures (fall back to the flat colour); turn glass into a transparent material."""
    glass = set()
    for o in meshes:
        for slot in o.material_slots:
            mat = slot.material
            if not mat or mat.name in glass:
                continue
            bsdf = principled(mat)
            if not bsdf:
                continue
            for node in list(mat.node_tree.nodes):
                if node.type == "TEX_IMAGE" and (node.image is None or not node.image.has_data and not _loads(node.image)):
                    log(f"{mat.name}: texture {node.image.name if node.image else '?'} unreadable, using flat colour")
                    mat.node_tree.nodes.remove(node)
            bsdf.inputs["Roughness"].default_value = 0.7
            bsdf.inputs["Specular IOR Level"].default_value = 0.2
            if any(w in mat.name.lower() for w in glass_words):
                glass.add(mat.name)
                bsdf.inputs["Alpha"].default_value = 0.3
                bsdf.inputs["Roughness"].default_value = 0.05
                if hasattr(mat, "surface_render_method"):
                    mat.surface_render_method = "BLENDED"
    return glass


def _loads(image):
    try:
        image.reload()
        return image.has_data or image.size[0] > 0
    except RuntimeError:
        return False


def add_ground(meshes):
    zmin = min((o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices)
    xs = [(o.matrix_world @ v.co).x for o in meshes for v in o.data.vertices]
    ys = [(o.matrix_world @ v.co).y for o in meshes for v in o.data.vertices]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    size = max(max(xs) - min(xs), max(ys) - min(ys)) * 3
    bpy.ops.mesh.primitive_plane_add(size=size, location=(cx, cy, zmin - 0.01))
    ground = bpy.context.active_object
    ground.name = "ground"
    mat = bpy.data.materials.new("MAT_ground")
    mat.use_nodes = True
    principled(mat).inputs["Base Color"].default_value = (0.32, 0.34, 0.30, 1)
    principled(mat).inputs["Roughness"].default_value = 0.9
    ground.data.materials.append(mat)
    ground.data.uv_layers[0].name = "UVMap"
    return ground


def add_lights(args):
    world = bpy.data.worlds.new("sky")
    bpy.context.scene.world = world
    if world.node_tree is None:  # Blender 6 always has world nodes and drops use_nodes
        world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.55, 0.70, 1.0, 1)
    bg.inputs["Strength"].default_value = args.sky_strength

    sun_data = bpy.data.lights.new("sun", type="SUN")
    sun_data.energy = args.sun_strength
    sun_data.angle = math.radians(1.0)  # soft-edged shadows
    sun_data.color = (1.0, 0.95, 0.88)
    sun = bpy.data.objects.new("sun", sun_data)
    bpy.context.scene.collection.objects.link(sun)
    # A sun light shines along its local -Z. Point it from azimuth/elevation towards the scene.
    el, az = math.radians(args.sun_elevation), math.radians(args.sun_azimuth)
    sun.rotation_euler = (math.pi / 2 - el, 0, -az + math.pi)


def fix_normals(obj):
    """CAD exports often have inward or mixed normals; a face lit from behind bakes black.
    Drop the imported custom normals and recalculate face winding to point outward."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def join(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


def add_lightmap_uv(obj, unwrap=True):
    uvs = obj.data.uv_layers
    if not uvs:
        uvs.new(name="UVMap")
    lm = uvs.new(name="Lightmap")
    uvs.active = lm               # bake writes through the active UV map
    for uv in uvs:
        uv.active_render = uv.name != "Lightmap"  # textures still read the original UVs
    if not unwrap:
        return
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.001, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.002, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake(obj, size):
    img = bpy.data.images.new(f"{obj.name}_lightmap_raw", size, size, alpha=True, float_buffer=True)
    nodes_added = []
    for slot in obj.material_slots:
        tree = slot.material.node_tree
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = img
        tree.nodes.active = node   # bake target: the active image node of every material
        nodes_added.append((tree, node))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    log(f"baking {obj.name} at {size}px ...")
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=8)
    for tree, node in nodes_added:
        tree.nodes.remove(node)
    return img


def encode_lightmap(raw, path):
    """Float lightmap -> 8-bit sRGB WebP. Returns the scale the viewer multiplies back in."""
    w, h = raw.size
    px = np.empty(w * h * 4, dtype=np.float32)
    raw.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    covered = px[:, 3] > 0
    peak = float(np.percentile(px[covered, :3].max(axis=1), 99.5)) if covered.any() else 1.0
    scale = max(peak, 1e-4)
    rgb = np.clip(px[:, :3] / scale, 0, 1)
    rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    out = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    out.colorspace_settings.name = "Non-Color"   # values are already sRGB-encoded; store as-is
    data = np.ones((w * h, 4), dtype=np.float32)
    data[:, :3] = rgb
    out.pixels.foreach_set(data.ravel())
    out.file_format = "WEBP"
    out.save(filepath=path, quality=90)
    if not os.path.isfile(path):
        raise RuntimeError(f"Blender did not write {path}")
    return scale


def main():
    args = parse_args()
    args.out = os.path.abspath(args.out)  # Blender resolves bare relative paths unpredictably
    os.makedirs(args.out, exist_ok=True)
    meshes = import_model(os.path.abspath(args.obj))
    glass_mats = fix_materials(meshes, [w.strip().lower() for w in args.glass.split(",") if w.strip()])
    ground = add_ground(meshes)
    add_lights(args)
    setup_cycles(args)

    is_glass = lambda o: any(s.material and s.material.name in glass_mats for s in o.material_slots)
    glass = [o for o in meshes if is_glass(o)]
    opaque = [o for o in meshes if not is_glass(o)]
    log(f"glass objects (not baked): {[o.name for o in glass]}")

    if args.fix_normals:
        for o in opaque:
            fix_normals(o)
    house = join(opaque, "building")
    add_lightmap_uv(house)
    add_lightmap_uv(ground, unwrap=False)  # new layers copy the plane's clean 0..1 layout

    for o in glass:
        o.hide_render = True  # windows open for the bake: daylight reaches the interior

    for obj, size in ((house, args.size), (ground, args.ground_size)):
        raw = bake(obj, size)
        name = f"{obj.name}_lightmap.webp"
        scale = encode_lightmap(raw, os.path.join(args.out, name))
        obj["lightmap"] = name
        obj["lightmap_intensity"] = round(scale, 5)
        log(f"{name}: scale {scale:.4f}")

    for o in glass:
        o.hide_render = False
    for obj in (house, ground):
        obj.data.uv_layers.active = obj.data.uv_layers["UVMap"]

    bpy.ops.object.select_all(action="DESELECT")
    for o in [house, ground, *glass]:
        o.select_set(True)
    glb = os.path.join(args.out, "model.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format="GLB", use_selection=True, export_extras=True,
        export_texcoords=True, export_normals=True, export_apply=True, export_yup=True,
        export_image_format="WEBP", export_materials="EXPORT", export_lights=False, export_cameras=False,
    )
    log(f"wrote {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
