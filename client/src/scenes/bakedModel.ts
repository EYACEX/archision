import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Load a GLB from pipeline/bake. Baked nodes carry extras {lightmap, lightmap_intensity}:
 * their lighting is precomputed, so they render with unlit MeshBasicMaterial —
 * base texture × lightmap — which costs a phone almost nothing. Unbaked meshes (glass) keep
 * their glTF material.
 */
/** Small screens get the 2048 px `.mobile.webp` lightmaps when the bake shipped them. */
const PREFER_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 768;

export async function loadBakedModel(url: string): Promise<THREE.Group> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const base = new URL('.', new URL(url, location.href)).href;
  const textures = new THREE.TextureLoader();
  const lightmaps = new Map<string, Promise<THREE.Texture>>();

  const lightmap = (name: string) => {
    if (!lightmaps.has(name)) {
      const full = () => textures.loadAsync(base + name);
      const pick = PREFER_MOBILE
        ? textures.loadAsync(base + name.replace(/\.webp$/, '.mobile.webp')).catch(full) // older bakes have no mobile copy
        : full();
      lightmaps.set(name, pick.then(tex => {
        tex.flipY = false;                    // glTF UV convention
        tex.colorSpace = THREE.SRGBColorSpace; // the bake stores sRGB-encoded light
        tex.channel = 1;                      // TEXCOORD_1 = the lightmap UVs
        tex.anisotropy = 4;
        return tex;
      }));
    }
    return lightmaps.get(name)!;
  };

  const jobs: Promise<void>[] = [];
  gltf.scene.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    // Multi-material nodes become a Group of Meshes; the extras sit on the group.
    const extras = obj.userData.lightmap ? obj.userData : obj.parent?.userData ?? {};
    const name = extras.lightmap as string | undefined;
    if (!name) return;
    const intensity = Number(extras.lightmap_intensity ?? 1);
    jobs.push(lightmap(name).then(tex => {
      const old = obj.material as THREE.MeshStandardMaterial;
      obj.material = new THREE.MeshBasicMaterial({
        name: old.name,
        map: old.map,
        color: old.color,
        lightMap: tex,
        // MeshBasicMaterial divides light maps by π; the bake stored light/intensity.
        lightMapIntensity: intensity * Math.PI,
        side: old.side,
      });
      old.dispose();
    }));
  });
  await Promise.all(jobs);
  return gltf.scene;
}
