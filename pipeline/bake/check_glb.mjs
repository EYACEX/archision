// Sanity-check a baked GLB: every node with a lightmap must still have TEXCOORD_1.
// Usage: node check_glb.mjs model.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
let ok = true;
for (const node of doc.getRoot().listNodes()) {
  const extras = node.getExtras();
  const mesh = node.getMesh();
  if (!mesh) continue;
  const uv1 = mesh.listPrimitives().every(p => p.getAttribute('TEXCOORD_1'));
  const baked = typeof extras.lightmap === 'string';
  console.log(`${node.getName().padEnd(16)} lightmap=${extras.lightmap ?? '-'} intensity=${extras.lightmap_intensity ?? '-'} TEXCOORD_1=${uv1}`);
  if (baked && !uv1) ok = false;
}
if (!ok) { console.error('FAIL: a baked node lost its lightmap UVs'); process.exit(1); }
console.log('OK');
