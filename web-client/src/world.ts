//! The Three.js side: the scene the browser draws, its parts, lights, sky
//! and the free camera that flies while no script drives one.

import * as THREE from "three";
import type {
  CameraSnapshot,
  Lighting,
  PartSnapshot,
  Snapshot,
  Welcome,
} from "./protocol";
import { PLACEMENT, SHAPE } from "./protocol";
import { MeshCache, Textures } from "./mesh";
import { decalMaterial, instancedMaterial, partMaterial, srgb } from "./materials";

const SNAPSHOT_MS = 50;

interface Trs {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

function trsOf(snap: PartSnapshot): Trs {
  return {
    position: new THREE.Vector3(...snap.position),
    quaternion: new THREE.Quaternion(snap.rotation[0], snap.rotation[1], snap.rotation[2], snap.rotation[3]),
    scale: new THREE.Vector3(...snap.size),
  };
}

function copyTrs(trs: Trs): Trs {
  return {
    position: trs.position.clone(),
    quaternion: trs.quaternion.clone(),
    scale: trs.scale.clone(),
  };
}

interface Atom {
  snap: PartSnapshot;
  from: Trs;
  to: Trs;
  changedAt: number;
  pool?: Pool;
  slot?: number;
  object?: THREE.Object3D;
  ownedGeometry?: THREE.BufferGeometry;
  ownedMaterial?: THREE.Material;
  meshRequested?: string;
  /** A decal plane's face turn and local offset, in the part's axes. */
  plane?: { turn: THREE.Quaternion; offset: THREE.Vector3 };
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private used = 0;
  private readonly capacity: number;
  private colorDirty = false;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    readonly castShadow: boolean,
    capacity = 512,
  ) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, zero);
  }

  get full(): boolean {
    return this.free.length === 0 && this.used >= this.capacity;
  }

  alloc(): number {
    let slot: number;
    if (this.free.length > 0) {
      slot = this.free.pop()!;
    } else {
      slot = this.used++;
      this.mesh.count = this.used;
    }
    return slot;
  }

  release(slot: number): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.mesh.setMatrixAt(slot, zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.free.push(slot);
  }

  setColor(slot: number, color: THREE.Color): void {
    this.mesh.setColorAt(slot, color);
    this.colorDirty = true;
  }

  flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.colorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this.colorDirty = false;
    }
  }
}

function primitiveGeometry(shape: number): THREE.BufferGeometry | null {
  switch (shape) {
    case SHAPE.BLOCK:
      return new THREE.BoxGeometry(1, 1, 1);
    case SHAPE.BALL:
      return new THREE.SphereGeometry(0.5, 24, 16);
    case SHAPE.CYLINDER: {
      // Roblox's Cylinder lies along X; Three's is along Y.
      const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
      geometry.rotateZ(Math.PI / 2);
      return geometry;
    }
    case SHAPE.WEDGE:
      return wedgeGeometry(false);
    case SHAPE.CORNER_WEDGE:
      return wedgeGeometry(true);
    case SHAPE.HEAD:
      // Rook's own head is a sphere about 1.2 studs across.
      return new THREE.SphereGeometry(0.6012, 24, 16);
    default:
      return null;
  }
}

/** A flat-shaded polyhedron from faces, each a list of unit-cube corners. */
function polyhedron(faces: number[][][]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const face of faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      for (const point of [face[0], face[i], face[i + 1]]) {
        positions.push(point[0] * 0.5, point[1] * 0.5, point[2] * 0.5);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function wedgeGeometry(corner: boolean): THREE.BufferGeometry {
  const v = (x: number, y: number, z: number) => [x, y, z];
  if (corner) {
    return polyhedron([
      [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
      [v(1, -1, 1), v(1, -1, -1), v(1, 1, -1)],
      [v(1, -1, -1), v(-1, -1, -1), v(1, 1, -1)],
      [v(-1, -1, 1), v(1, -1, 1), v(1, 1, -1)],
      [v(-1, -1, -1), v(-1, -1, 1), v(1, 1, -1)],
    ]);
  }
  return polyhedron([
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
    [v(1, -1, -1), v(-1, -1, -1), v(-1, 1, 1), v(1, 1, 1)],
    [v(1, -1, 1), v(1, -1, -1), v(1, 1, 1)],
    [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)],
  ]);
}

const primitiveCache = new Map<number, THREE.BufferGeometry>();

function geometryForShape(shape: number): THREE.BufferGeometry | null {
  let geometry = primitiveCache.get(shape);
  if (!geometry) {
    const built = primitiveGeometry(shape);
    if (!built) return null;
    geometry = built;
    primitiveCache.set(shape, geometry);
  }
  return geometry;
}

/** A gradient sky with the place's top, horizon and bottom colours. */
class Sky {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = {
    top: { value: new THREE.Color(0.2, 0.4, 0.8) },
    horizon: { value: new THREE.Color(0.8, 0.85, 0.95) },
    bottom: { value: new THREE.Color(0.1, 0.12, 0.16) },
    tint: { value: new THREE.Color(1, 1, 1) },
  };

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        varying vec3 vDirection;
        uniform vec3 top;
        uniform vec3 horizon;
        uniform vec3 bottom;
        uniform vec3 tint;
        void main() {
          float h = vDirection.y;
          vec3 color = h >= 0.0
            ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55))
            : mix(horizon, bottom, pow(clamp(-h, 0.0, 1.0), 0.4));
          gl_FragColor = vec4(color * tint, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  update(lighting: Lighting): void {
    this.uniforms.top.value.setRGB(lighting.skyTop[0], lighting.skyTop[1], lighting.skyTop[2], THREE.SRGBColorSpace);
    this.uniforms.horizon.value.setRGB(
      lighting.skyHorizon[0],
      lighting.skyHorizon[1],
      lighting.skyHorizon[2],
      THREE.SRGBColorSpace,
    );
    this.uniforms.bottom.value.setRGB(
      lighting.skyBottom[0],
      lighting.skyBottom[1],
      lighting.skyBottom[2],
      THREE.SRGBColorSpace,
    );
    this.uniforms.tint.value.setRGB(
      lighting.skyTint[0],
      lighting.skyTint[1],
      lighting.skyTint[2],
      THREE.SRGBColorSpace,
    );
  }
}

export class World {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 10000);
  readonly renderer: THREE.WebGLRenderer;
  readonly textures = new Textures();
  readonly meshes = new MeshCache();
  cameraScripted = false;

  private parts = new Map<number, Atom>();
  private pools = new Map<string, Pool[]>();
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
  private ambient = new THREE.AmbientLight(0xffffff, 0.35);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private sky = new Sky();
  private skyboxKey = "";
  private lighting?: Lighting;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.add(this.sky.mesh);
    this.scene.add(this.hemisphere, this.ambient, this.sun);
    this.sun.castShadow = true;
    const shadow = this.sun.shadow;
    shadow.mapSize.set(2048, 2048);
    shadow.camera.left = -140;
    shadow.camera.right = 140;
    shadow.camera.top = 140;
    shadow.camera.bottom = -140;
    shadow.camera.near = 0.5;
    shadow.camera.far = 500;
    shadow.bias = -0.0004;
    shadow.normalBias = 0.02;
    this.scene.add(this.sun.target);
    this.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  applyWelcome(welcome: Welcome): void {
    this.clearParts();
    this.lighting = welcome.lighting;
    this.applyLighting(welcome.lighting);
    this.applyCamera(welcome.camera);
    for (const part of welcome.parts) this.addPart(part, performance.now());
  }

  applySnapshot(snapshot: Snapshot): void {
    if (snapshot.lighting) {
      this.lighting = snapshot.lighting;
      this.applyLighting(snapshot.lighting);
    }
    if (snapshot.camera) {
      this.cameraScripted = snapshot.camera.scripted;
      if (snapshot.camera.scripted) this.applyCamera(snapshot.camera);
    }
    for (const id of snapshot.destroyed) this.removePart(id);
    const now = performance.now();
    for (const part of snapshot.created) this.addPart(part, now);
    for (const update of snapshot.updatedTransforms) {
      const atom = this.parts.get(update.id);
      if (!atom) continue;
      const current = this.trsAt(atom, now);
      // `size` only rides along when it changed; remember it, so the next
      // move of an unchanged part still scales to the server's size.
      if (update.size) atom.snap.size = update.size;
      atom.from = current;
      atom.to = {
        position: new THREE.Vector3(...update.position),
        quaternion: new THREE.Quaternion(update.rotation[0], update.rotation[1], update.rotation[2], update.rotation[3]),
        scale: new THREE.Vector3(...atom.snap.size),
      };
      atom.changedAt = now;
    }
    for (const part of snapshot.updatedProps) this.updatePart(part, now);
  }

  private applyCamera(camera: CameraSnapshot): void {
    this.camera.position.set(...camera.position);
    this.camera.quaternion.set(camera.rotation[0], camera.rotation[1], camera.rotation[2], camera.rotation[3]);
    this.camera.fov = camera.fov || 70;
    this.camera.updateProjectionMatrix();
  }

  private applyLighting(lighting: Lighting): void {
    this.sun.color.copy(srgb(lighting.sunColor));
    this.sun.intensity = 2.2 * (lighting.environmentDiffuse > 0 ? Math.max(0.6, lighting.environmentDiffuse + 0.4) : 1);
    this.sun.castShadow = lighting.globalShadows;
    this.sun.visible = lighting.sunColor.some((v) => v > 0.01);
    const sun = new THREE.Vector3(...lighting.sunDirection);
    this.sunPosition(sun);

    this.hemisphere.color.copy(srgb(lighting.skyHorizon));
    this.hemisphere.groundColor.copy(srgb(lighting.skyBottom));
    this.hemisphere.intensity = 0.9 + 0.6 * lighting.environmentDiffuse;
    this.ambient.color.copy(srgb([
      Math.max(lighting.ambient[0], lighting.outdoorAmbient[0]),
      Math.max(lighting.ambient[1], lighting.outdoorAmbient[1]),
      Math.max(lighting.ambient[2], lighting.outdoorAmbient[2]),
    ]));
    this.ambient.intensity = 0.5;

    this.renderer.toneMappingExposure = Math.max(0.05, lighting.exposure);
    this.renderer.toneMapping =
      lighting.tonemapper === 1 ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;

    this.sky.update(lighting);
    this.scene.fog =
      lighting.fogEnd > lighting.fogStart && lighting.fogEnd < 1e6
        ? new THREE.Fog(srgb(lighting.fogColor), lighting.fogStart, lighting.fogEnd)
        : null;

    this.applySkybox(lighting);
  }

  private applySkybox(lighting: Lighting): void {
    const faces = lighting.skybox;
    if (!faces || faces.length !== 6) {
      this.skyboxKey = "";
      this.scene.background = null;
      this.sky.mesh.visible = true;
      return;
    }
    const key = faces.join(",");
    if (key === this.skyboxKey) return;
    this.skyboxKey = key;
    // [Up, Back, Front, Left, Right, Down] -> [+X, -X, +Y, -Y, +Z, -Z].
    const order = [faces[4], faces[3], faces[0], faces[5], faces[1], faces[2]];
    this.scene.background = this.textures.skybox(order);
    this.sky.mesh.visible = false;
  }

  private sunPosition(direction: THREE.Vector3): void {
    this.sun.position.copy(this.camera.position).addScaledVector(direction, 220);
    this.sun.target.position.copy(this.camera.position);
    this.sun.target.updateMatrixWorld();
  }

  private clearParts(): void {
    for (const id of [...this.parts.keys()]) this.removePart(id);
    for (const pools of this.pools.values()) {
      for (const pool of pools) this.scene.remove(pool.mesh);
    }
    this.pools.clear();
  }

  private addPart(snap: PartSnapshot, now: number): void {
    // A delta queued around a welcome may name an entry the welcome already
    // has; replace it instead of leaking its pool slot.
    if (this.parts.has(snap.id)) this.removePart(snap.id);
    const trs = trsOf(snap);
    const atom: Atom = {
      snap,
      from: copyTrs(trs),
      to: trs,
      changedAt: now,
    };
    this.parts.set(snap.id, atom);
    this.createVisual(atom);
  }

  private updatePart(snap: PartSnapshot, now: number): void {
    const atom = this.parts.get(snap.id);
    if (!atom) {
      this.addPart(snap, now);
      return;
    }
    const current = this.trsAt(atom, now);
    this.removeVisual(atom);
    atom.snap = snap;
    atom.from = current;
    atom.to = trsOf(snap);
    atom.changedAt = now;
    this.createVisual(atom);
  }

  private removePart(id: number): void {
    const atom = this.parts.get(id);
    if (!atom) return;
    this.parts.delete(id);
    this.removeVisual(atom);
  }

  private removeVisual(atom: Atom): void {
    if (atom.pool && atom.slot !== undefined) {
      atom.pool.release(atom.slot);
      atom.pool = undefined;
      atom.slot = undefined;
    }
    if (atom.object) {
      this.scene.remove(atom.object);
      atom.object = undefined;
    }
    atom.ownedGeometry?.dispose();
    atom.ownedGeometry = undefined;
    atom.ownedMaterial?.dispose();
    atom.ownedMaterial = undefined;
    atom.plane = undefined;
    atom.meshRequested = undefined;
  }

  private canInstance(snap: PartSnapshot): boolean {
    if (snap.shape === SHAPE.FILE || snap.shape === SHAPE.TRUSS || snap.shape === SHAPE.ADORN) {
      return false;
    }
    if (snap.transparency > 0.001) return false;
    // `over` parts blend into what they cover (terrain seams); they need a
    // blended material, not an opaque instance.
    if (snap.over) return false;
    if (snap.texture) return false;
    const maps = snap.maps;
    if (maps.color || maps.normal || maps.roughness || maps.metalness) return false;
    if (snap.material === 288) return false; // Neon's glow is per colour
    if (snap.vertexColors) return false;
    return true;
  }

  private createVisual(atom: Atom): void {
    if (atom.snap.layer > 0) {
      this.createOverlay(atom);
      return;
    }
    if (atom.snap.shape === SHAPE.TRUSS) {
      // Trusses are streams of bars; the browser draws a box for now.
      return;
    }
    if (atom.snap.shape === SHAPE.FILE) {
      this.createFile(atom);
      return;
    }
    if (this.canInstance(atom.snap)) {
      this.createInstanced(atom);
      return;
    }
    this.createIndividual(atom);
  }

  private createInstanced(atom: Atom): void {
    const snap = atom.snap;
    const geometry = geometryForShape(snap.shape);
    if (!geometry) return;
    const key = [
      snap.shape,
      snap.material,
      snap.castShadow ? 1 : 0,
      snap.doubleSided ? 1 : 0,
      snap.light,
      snap.onTop ? 1 : 0,
    ].join("|");
    let list = this.pools.get(key);
    if (!list) {
      list = [];
      this.pools.set(key, list);
    }
    let pool = list.find((candidate) => !candidate.full);
    if (!pool) {
      const material = instancedMaterial(snap);
      pool = new Pool(geometry, material, snap.castShadow);
      pool.mesh.renderOrder = snap.onTop ? 1000 : 0;
      list.push(pool);
      this.scene.add(pool.mesh);
    }
    const slot = pool.alloc();
    atom.pool = pool;
    atom.slot = slot;
    pool.setColor(slot, srgb(snap.color));
    pool.flush();
  }

  private createIndividual(atom: Atom): void {
    const snap = atom.snap;
    const geometry = geometryForShape(snap.shape);
    if (!geometry) return;
    const material = partMaterial(snap, this.textures);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = snap.castShadow && snap.transparency < 0.999;
    mesh.receiveShadow = snap.transparency < 0.999;
    mesh.renderOrder = snap.onTop ? 1000 : 0;
    atom.object = mesh;
    atom.ownedMaterial = material;
    this.scene.add(mesh);
  }

  private createFile(atom: Atom): void {
    const hash = atom.snap.mesh;
    if (!hash) return;
    const ready = () => {
      const current = this.parts.get(atom.snap.id);
      if (current !== atom || atom.snap.mesh !== hash || atom.object) return;
      const geometry = this.meshes.get(hash);
      if (!geometry) return;
      const material = partMaterial(atom.snap, this.textures);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = atom.snap.castShadow && atom.snap.transparency < 0.999;
      mesh.receiveShadow = atom.snap.transparency < 0.999;
      mesh.renderOrder = atom.snap.onTop ? 1000 : 0;
      atom.object = mesh;
      atom.ownedMaterial = material;
      this.scene.add(mesh);
    };
    atom.meshRequested = hash;
    this.meshes.load(hash, ready);
  }

  private createOverlay(atom: Atom): void {
    const snap = atom.snap;
    const image = snap.image;
    if (!image) return;
    if (image.placement === PLACEMENT.MESH_UV) {
      const parent = snap.parent ? this.parts.get(snap.parent) : undefined;
      const hash = parent?.snap.mesh;
      const build = () => {
        const current = this.parts.get(snap.id);
        if (current !== atom || atom.object) return;
        const geometry = hash
          ? this.meshes.get(hash)
          : parent
            ? geometryForShape(parent.snap.shape)
            : null;
        if (!geometry) return;
        const material = decalMaterial(snap, this.textures, true);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 1100 + (image.z || 0);
        atom.object = mesh;
        atom.ownedMaterial = material;
        this.scene.add(mesh);
      };
      if (hash && !this.meshes.get(hash)) {
        this.meshes.load(hash, build);
      } else {
        build();
      }
      return;
    }
    // A decal or tiled texture on a face: a plane in the part's axes,
    // slightly outside the surface.
    const [sx, sy, sz] = snap.size;
    let width = sx;
    let height = sy;
    if (image.face === 0 || image.face === 3) {
      width = sz;
      height = sy;
    } else if (image.face === 1 || image.face === 4) {
      width = sx;
      height = sz;
    }
    const tiled = image.placement === PLACEMENT.TILED;
    const material = decalMaterial(snap, this.textures, false);
    if (tiled && material.map) {
      const texture = material.map.clone();
      texture.needsUpdate = true;
      const repeat = Math.max(image.studsPerTile[0], 0.01);
      const down = Math.max(image.studsPerTile[1], 0.01);
      texture.repeat.set(width / repeat, height / down);
      texture.offset.set(-image.offset[0] / repeat, image.offset[1] / down);
      material.map = texture;
    }
    const geometry = new THREE.PlaneGeometry(Math.max(width, 0.01), Math.max(height, 0.01));
    const mesh = new THREE.Mesh(geometry, material);
    const turn = new THREE.Quaternion();
    const offset = new THREE.Vector3();
    const gap = 0.008;
    switch (image.face) {
      case 0: // Right, +X
        turn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        offset.set(sx / 2 + gap, 0, 0);
        break;
      case 3: // Left, -X
        turn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
        offset.set(-sx / 2 - gap, 0, 0);
        break;
      case 1: // Top, +Y
        turn.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        offset.set(0, sy / 2 + gap, 0);
        break;
      case 4: // Bottom, -Y
        turn.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        offset.set(0, -sy / 2 - gap, 0);
        break;
      case 2: // Back, +Z
        offset.set(0, 0, sz / 2 + gap);
        break;
      default: // Front, -Z
        turn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        offset.set(0, 0, -sz / 2 - gap);
        break;
    }
    atom.plane = { turn, offset };
    mesh.renderOrder = 1100 + (image.z || 0);
    mesh.castShadow = false;
    atom.object = mesh;
    atom.ownedGeometry = geometry;
    atom.ownedMaterial = material;
    this.scene.add(mesh);
  }

  private trsAt(atom: Atom, now: number): Trs {
    const t = Math.min(Math.max((now - atom.changedAt) / SNAPSHOT_MS, 0), 1);
    return {
      position: atom.from.position.clone().lerp(atom.to.position, t),
      quaternion: atom.from.quaternion.clone().slerp(atom.to.quaternion, t),
      scale: atom.from.scale.clone().lerp(atom.to.scale, t),
    };
  }

  /** Give every part its transform for this frame, then light the sun
   * around the camera and draw. */
  update(now: number): void {
    for (const atom of this.parts.values()) {
      const trs = this.trsAt(atom, now);
      if (atom.pool && atom.slot !== undefined) {
        const matrix = new THREE.Matrix4().compose(trs.position, trs.quaternion, trs.scale);
        atom.pool.mesh.setMatrixAt(atom.slot, matrix);
      } else if (atom.object) {
        if (atom.plane) {
          const offset = atom.plane.offset.clone().applyQuaternion(trs.quaternion);
          atom.object.position.copy(trs.position).add(offset);
          atom.object.quaternion.copy(trs.quaternion).multiply(atom.plane.turn);
          atom.object.scale.set(1, 1, 1);
        } else {
          atom.object.position.copy(trs.position);
          atom.object.quaternion.copy(trs.quaternion);
          atom.object.scale.copy(trs.scale);
        }
      }
    }
    for (const list of this.pools.values()) {
      for (const pool of list) pool.flush();
    }
    if (this.lighting) this.sunPosition(new THREE.Vector3(...this.lighting.sunDirection));
    this.sky.mesh.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}

/** The window's free camera: Rook's fly camera, as the player uses it. */
export class FlyCamera {
  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  speed = 40;

  constructor(readonly camera: THREE.PerspectiveCamera) {
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    this.yaw = euler.y;
    this.pitch = euler.x;
  }

  setFromCamera(camera: CameraSnapshot): void {
    this.camera.position.set(...camera.position);
    this.camera.quaternion.set(camera.rotation[0], camera.rotation[1], camera.rotation[2], camera.rotation[3]);
    this.camera.fov = camera.fov || 70;
    this.camera.updateProjectionMatrix();
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = euler.y;
    this.pitch = euler.x;
  }

  key(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx * 0.0022;
    this.pitch -= dy * 0.0022;
    this.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch));
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  beginDrag(x: number, y: number): void {
    this.dragging = true;
    this.lastX = x;
    this.lastY = y;
  }

  endDrag(): void {
    this.dragging = false;
  }

  drag(x: number, y: number): void {
    if (!this.dragging) return;
    this.look(x - this.lastX, y - this.lastY);
    this.lastX = x;
    this.lastY = y;
  }

  wheel(delta: number): void {
    this.speed = Math.max(4, Math.min(600, this.speed * Math.exp(-delta * 0.12)));
  }

  update(dt: number): void {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const move = new THREE.Vector3();
    if (this.keys.has("W")) move.add(forward);
    if (this.keys.has("S")) move.sub(forward);
    if (this.keys.has("D")) move.add(right);
    if (this.keys.has("A")) move.sub(right);
    if (this.keys.has("E")) move.y += 1;
    if (this.keys.has("Q")) move.y -= 1;
    if (move.lengthSq() > 0) {
      const speed = this.keys.has("LeftShift") ? this.speed * 3 : this.speed;
      this.camera.position.addScaledVector(move.normalize(), speed * dt);
    }
  }
}
