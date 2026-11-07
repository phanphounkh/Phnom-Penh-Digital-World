import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Group, Mesh, Float32BufferAttribute } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
export class AssetManager {
  constructor() {
    this.loader = new GLTFLoader();
    this.cache = new Map();
  }
  async load(path) {
    if (!this.cache.has(path))
      this.cache.set(
        path,
        this.loader.loadAsync("/models/" + path + ".glb").then((g) => {
          let root = g.scene;
          // Bake static geometry by shared material; keep character pivots and cart wheels animatable.
          if (!path.startsWith("characters/")) {
            root.updateMatrixWorld(true);
            const batches = new Map(),
              merged = new Group();
            root.traverse((n) => {
              if (!n.isMesh) return;
              if (n.name.startsWith("Wheel")) {
                const wheel = n.clone();
                n.matrixWorld.decompose(
                  wheel.position,
                  wheel.quaternion,
                  wheel.scale,
                );
                merged.add(wheel);
                return;
              }
              const geo = n.geometry.clone().applyMatrix4(n.matrixWorld);
              const key = n.material.uuid;
              if (!batches.has(key))
                batches.set(key, { material: n.material, geos: [] });
              batches.get(key).geos.push(geo);
            });
            for (const { material, geos } of batches.values()) {
              const geometry = mergeGeometries(geos);
              if (geometry) merged.add(new Mesh(geometry, material));
              geos.forEach((geo) => geo.dispose());
            }
            const wheels = new Set();
            merged.traverse((n) => {
              if (n.isMesh) wheels.add(n.geometry);
            });
            root.traverse((n) => {
              if (n.isMesh && !wheels.has(n.geometry)) n.geometry.dispose();
            });
            root = merged;
          }
          if (path.startsWith("characters/")) {
            // Batch facial/clothing details within each joint; preserve the joint hierarchy.
            const groups = [],
              oldGeometry = new Set();
            root.traverse((n) => groups.push(n));
            for (const parent of groups.reverse()) {
              const batches = new Map();
              for (const child of [...parent.children]) {
                if (
                  !child.isMesh ||
                  child.isSkinnedMesh ||
                  child.children.length ||
                  Array.isArray(child.material)
                )
                  continue;
                child.updateMatrix();
                const geo = child.geometry.clone().applyMatrix4(child.matrix);
                if (!geo.attributes.uv)
                  geo.setAttribute(
                    "uv",
                    new Float32BufferAttribute(
                      new Float32Array(geo.attributes.position.count * 2),
                      2,
                    ),
                  );
                const key = child.material.uuid;
                if (!batches.has(key))
                  batches.set(key, { material: child.material, geos: [] });
                batches.get(key).geos.push(geo);
                oldGeometry.add(child.geometry);
                parent.remove(child);
              }
              for (const batch of batches.values()) {
                const geometry = mergeGeometries(batch.geos);
                if (geometry) {
                  const mesh = new Mesh(geometry, batch.material);
                  mesh.name = "JointDetails";
                  parent.add(mesh);
                }
                batch.geos.forEach((g) => g.dispose());
              }
            }
            const retained = new Set();
            root.traverse((n) => {
              if (n.isMesh) retained.add(n.geometry);
            });
            oldGeometry.forEach((g) => {
              if (!retained.has(g)) g.dispose();
            });
          }
          root.traverse((n) => {
            if (n.isMesh) {
              n.castShadow = !(
                Array.isArray(n.material) ? n.material : [n.material]
              ).some((m) => m.transparent);
              n.receiveShadow = true;
            }
          });
          return root;
        }),
      );
    return (await this.cache.get(path)).clone(true);
  }
  dispose() {
    Promise.allSettled([...this.cache.values()]).then((results) => {
      const geometries = new Set(),
        materials = new Set();
      for (const r of results)
        if (r.status === "fulfilled")
          r.value.traverse((n) => {
            if (n.isMesh) {
              geometries.add(n.geometry);
              for (const m of Array.isArray(n.material)
                ? n.material
                : [n.material])
                materials.add(m);
            }
          });
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    });
    this.cache.clear();
  }
}
