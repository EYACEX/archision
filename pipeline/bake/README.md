# Bake pipeline — render once, view on any phone

Runs on the render machine (a decent NVIDIA GPU), **once per project**. Not part of the server.

Cycles path-traces the daylight (sun, sky, shadows, light bouncing between surfaces) and stores **only the light** in a lightmap atlas. The phone shows `base texture × lightmap` with an unlit material, so it costs almost nothing to render. The original tiling textures stay sharp, because the lightmap holds light only.

```
model.obj (+ .mtl, textures)
  → bake_lightmap.py (Blender, headless)   model.glb + building_lightmap.webp + ground_lightmap.webp
  → npm run compress                        meshopt geometry, WebP textures (~4× smaller)
  → npm run check                           fails if compression dropped the lightmap UVs
  → npm run mobile                          2048 px *.mobile.webp lightmaps for phones (~4× smaller)
  → server: npm run model:attach            copies to server/assets, sets the project's model_url
```

## Setup (once)

- Blender 5.2+ (portable zip is fine), e.g. `D:\tools\blender\blender.exe`
- `npm install` in this folder (gltf-transform)

## Run

```bash
# 1. Bake (GPU: ~minutes; --cpu works but is much slower)
blender -b --factory-startup -P bake_lightmap.py -- --obj path/model.obj --out out --size 4096 --samples 256

# 2. Compress and check
npm run compress -- out/model.glb out/model.opt.glb
npm run check -- out/model.opt.glb
mv out/model.opt.glb out/model.glb
npm run mobile -- out

# 3. Attach to a project (from server/)
npm run model:attach -- --project <project-id> path/to/out
```

The viewer loads the procedural slabs first, then swaps in the baked model. **Show availability** switches back. Hovered floors and live status changes still show as a tinted overlay on the realistic model.

## Options worth knowing

| Option | Default | Notes |
|---|---|---|
| `--size` | 4096 | Building lightmap pixels. 4096 ≈ 1–2 cm per texel for a villa. Towers need more atlases (not built yet). |
| `--samples` | 256 | Noise vs. time. 32 is fine for a test. |
| `--sun-elevation` / `--sun-azimuth` | 45 / 135 | Light is fixed once baked. Day and night would be two bakes. |
| `--sky-strength` | 1.0 | Raise it (1.3–1.6) if interiors look too dark through the glazing. |
| `--glass` | `vetro,vetro_pannello` | Material-name fragments that are glass: not baked, rendered transparent, hidden during the bake so daylight reaches inside. |
| `--no-fix-normals` | off | By default normals are recalculated outward. CAD exports often have flipped faces, which bake black. |

## Reference result — Modern House (villa, 16k faces), RTX A2000 laptop

| | |
|---|---|
| Bake, 4096 px, 256 samples | 94 s |
| Geometry (meshopt) | 873 KB (from 2.7 MB) |
| Lightmap, desktop / phone | 1.9 MB / 422 KB |
| **Phone download, total** | **~1.3 MB** |

The viewer auto-aligns the model to the floor plans. CAD exports disagree on axes; this one came in rotated 90°. It tests the 4 quarter-turns, each also mirrored, against the ground-floor footprint, and logs the result to the console.

## Gotchas

- **Compression must keep TEXCOORD_1.** gltf-transform prunes "unused" attributes, and nothing in the file references the lightmap UVs (the viewer attaches them). `npm run compress` passes `--prune-attributes false`; `npm run check` verifies it.
- **Unreadable textures fall back to the material colour.** The script logs which ones.
- **One building atlas.** Big projects will need several atlases or per-floor bakes.
- **Tiny parts waste atlas space.** About a quarter of the villa's atlas goes to lamp and chrome pieces. Excluding them, or giving them a flat ambient value, would sharpen everything else.
