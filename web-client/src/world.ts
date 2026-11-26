//! The Three.js side: the scene the browser draws, its parts, lights, sky
//! and the free camera that flies while no script drives one.

import * as THREE from "three";
import type {
  CameraSnapshot,
  LightSnapshot,
  Lighting,
  PartSnapshot,
  PlayerAvatar,
  PlayerInfo,
  Snapshot,
  Welcome,
} from "./protocol";
import { PLACEMENT, SHAPE } from "./protocol";
import { MeshCache, Textures } from "./mesh";
import { decalMaterial, instancedMaterial, partMaterial, srgb, tinted } from "./materials";
import { AvatarDresser, avatarGeometry } from "./avatar";
import { loadAvatarModel, type AvatarModel } from "./avatar-model";
import { R6_ROLES, R6Animator } from "./r6";

const SNAPSHOT_MS = 50;
/** Camera collision cell size in studs, and the span past which a box is
 * checked on every ray instead of being filed into cells. */
const COLLISION_CELL = 8;
const COLLISION_MAX_CELLS = 8;
const UNIT_BOX = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5),
);
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

export interface Trs {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/** The axis-aligned box around a part's oriented box. */
function boxOf(trs: Trs): THREE.Box3 {
  const matrix = new THREE.Matrix4().compose(trs.position, trs.quaternion, trs.scale);
  return UNIT_BOX.clone().applyMatrix4(matrix);
}

/** How far along `direction` a box is first hit, or null. */
function rayBox(origin: THREE.Vector3, direction: THREE.Vector3, length: number, box: THREE.Box3): number | null {
  let near = 0;
  let far = length;
  for (const axis of ["x", "y", "z"] as const) {
    const start = origin[axis];
    const delta = direction[axis];
    if (Math.abs(delta) < 1e-8) {
      if (start < box.min[axis] || start > box.max[axis]) return null;
      continue;
    }
    let t1 = (box.min[axis] - start) / delta;
    let t2 = (box.max[axis] - start) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near;
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
  /** Whether the transform is still interpolating toward `to`. */
  moving: boolean;
  pool?: Pool;
  slot?: number;
  object?: THREE.Object3D;
  ownedGeometry?: THREE.BufferGeometry;
  ownedMaterial?: THREE.Material;
  ownedMaterials?: THREE.Material[];
  meshRequested?: string;
  /** The visual is Roblox's mesh, already in studs: don't scale it again. */
  modelPart?: boolean;
  /** A decal plane's face turn and local offset, in the part's axes. */
  plane?: { turn: THREE.Quaternion; offset: THREE.Vector3 };
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private used = 0;
  private readonly capacity: number;
  private colorDirty = false;
  private matrixDirty = false;

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
    this.matrixDirty = true;
    this.free.push(slot);
  }

  setMatrix(slot: number, matrix: THREE.Matrix4): void {
    this.mesh.setMatrixAt(slot, matrix);
    this.matrixDirty = true;
  }

  setColor(slot: number, color: THREE.Color): void {
    this.mesh.setColorAt(slot, color);
    this.colorDirty = true;
  }

  flush(): void {
    if (this.matrixDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.matrixDirty = false;
    }
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
  /** The local character as the last welcome or snapshot described it. */
  player: PlayerInfo | null = null;
  readonly collisionEnabled: boolean;

  private parts = new Map<number, Atom>();
  private localParts = new Set<number>();
  private hidden = new Set<number>();
  private collisionCells = new Map<string, Set<number>>();
  private collisionBoxes = new Map<number, THREE.Box3>();
  private collisionCellsOf = new Map<number, string[]>();
  private collisionLarge = new Map<number, THREE.Box3>();
  private pools = new Map<string, Pool[]>();
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
  private ambient = new THREE.AmbientLight(0xffffff, 0.35);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private sky = new Sky();
  private skyboxKey = "";
  private lighting?: Lighting;
  private lights: LightSnapshot[] = [];
  private lightObjects = new Map<number, THREE.Light>();
  private dresser = new AvatarDresser();
  private animator = new R6Animator();
  private avatarParts = new Map<string, number>();
  private avatarRoles = new Map<number, string>();
  private avatarKey = "";
  private model: AvatarModel | null = null;
  private modelKey = "";
  private modelRequest = 0;
  private animationKey = "";
  private readonly maxPixelRatio: number;
  private readonly nativePixelRatio: number;
  private adaptive: boolean;
  private pixelRatio: number;
  private renderScale: number | null = null;
  private qualityFrames = 0;
  private qualitySince = performance.now();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const params = new URLSearchParams(window.location.search);
    this.collisionEnabled = params.get("cameraCollision") !== "0";
    const mobile =
      window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    this.nativePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const requested = Number(params.get("pixelRatio") ?? "");
    const forced = Number.isFinite(requested) && requested > 0;
    let saved: number | null = null;
    try {
      const stored = Number(localStorage.getItem("rook.renderScale") ?? "");
      if (Number.isFinite(stored) && stored >= 25 && stored <= 200) saved = stored;
    } catch {
      // Storage can be unavailable; the slider still works for this visit.
    }
    this.renderScale = saved;
    this.adaptive = !forced && saved === null;
    this.maxPixelRatio = Math.max(this.nativePixelRatio, forced ? requested : 0);
    this.pixelRatio = forced
      ? requested
      : saved !== null
        ? this.ratioForScale(saved)
        : mobile
          ? Math.min(this.nativePixelRatio, 2)
          : this.nativePixelRatio;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA is expensive at phone pixel ratios, and the resolution scale
      // already provides some smoothing.
      antialias: !mobile || this.nativePixelRatio <= 1.5,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = params.get("shadows") !== "0";
    this.renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(this.pixelRatio);

    this.scene.add(this.sky.mesh);
    this.scene.add(this.hemisphere, this.ambient, this.sun);
    this.sun.castShadow = true;
    const shadow = this.sun.shadow;
    shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
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
    this.setPlayer(welcome.player);
    this.lighting = welcome.lighting;
    this.applyLighting(welcome.lighting);
    this.applyLights(welcome.lights);
    this.applyCamera(welcome.camera);
    for (const part of welcome.parts) this.addPart(part, performance.now());
    // The welcome's transfer time shouldn't count against the frame rate.
    this.qualityFrames = 0;
    this.qualitySince = performance.now();
  }

  applySnapshot(snapshot: Snapshot): void {
    // The exclusion must be current before this snapshot's new parts are
    // filed into the camera collision grid.
    this.setPlayer(snapshot.player);
    if (snapshot.lighting) {
      this.lighting = snapshot.lighting;
      this.applyLighting(snapshot.lighting);
    }
    if (snapshot.lights) this.applyLights(snapshot.lights);
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
      // A moved box's cached cells would be stale; it can be indexed
      // again once a full prop update arrives.
      this.unindexCollision(update.id);
      const current = atom.moving ? this.trsAt(atom, now) : atom.to;
      // `size` only rides along when it changed; remember it, so the next
      // move of an unchanged part still scales to the server's size.
      if (update.size) atom.snap.size = update.size;
      atom.to = {
        position: new THREE.Vector3(...update.position),
        quaternion: new THREE.Quaternion(update.rotation[0], update.rotation[1], update.rotation[2], update.rotation[3]),
        scale: new THREE.Vector3(...atom.snap.size),
      };
      atom.changedAt = now;
      if (this.localParts.has(update.id)) {
        // The local player's own body is never shown a tick behind: the
        // server already stepped before this snapshot was sent.
        atom.from = copyTrs(atom.to);
        atom.moving = false;
        this.place(atom, atom.to);
      } else {
        atom.from = current;
        atom.moving = true;
      }
    }
    for (const part of snapshot.updatedProps) this.updatePart(part, now);
  }

  private applyCamera(camera: CameraSnapshot): void {
    this.camera.position.set(...camera.position);
    this.camera.quaternion.set(camera.rotation[0], camera.rotation[1], camera.rotation[2], camera.rotation[3]);
    this.camera.fov = camera.fov || 70;
    this.camera.updateProjectionMatrix();
  }

  /** Follow a new local character (or none), keeping its parts out of the
   * camera collision grid. */
  private setPlayer(player: PlayerInfo | null): void {
    this.player = player;
    this.localParts.clear();
    if (!player) {
      this.setAvatar(null);
      return;
    }
    if (player.root !== null) this.localParts.add(player.root);
    if (player.head !== null) this.localParts.add(player.head);
    for (const id of player.parts) this.localParts.add(id);
    for (const id of this.localParts) this.unindexCollision(id);
    this.setAvatar(player.avatar ?? null);
  }

  /** Take a chosen look: its six body parts, its garment images, Roblox's
   * mesh and its animation clips. Only a change rebuilds anything. */
  private setAvatar(avatar: PlayerAvatar | null): void {
    const key = avatar
      ? `${avatar.userId}|${avatar.shirt ?? ""}|${avatar.pants ?? ""}|${avatar.body
          .map(([role, id]) => `${role}:${id}`)
          .join(",")}`
      : "";
    const modelKey = avatar?.model
      ? `${avatar.userId}|${avatar.model.obj}|${avatar.model.mtl}`
      : "";
    const bodyChanged = key !== this.avatarKey;
    const modelChanged = modelKey !== this.modelKey;

    if (bodyChanged) {
      this.avatarKey = key;
      this.avatarParts.clear();
      this.avatarRoles.clear();
      if (avatar) {
        for (const [role, id] of avatar.body) {
          this.avatarParts.set(role, id);
          this.avatarRoles.set(id, role);
        }
      }
    }

    let previous: AvatarModel | null = null;
    if (modelChanged) {
      this.modelKey = modelKey;
      this.modelRequest++;
      previous = this.model;
      this.model = null;
      this.animator.setJoints();
    }

    if (bodyChanged) {
      this.dresser.set(avatar?.shirt ?? null, avatar?.pants ?? null, () => this.redressAvatar());
    }
    if (bodyChanged || modelChanged) this.redressAvatar();

    if (modelChanged) {
      previous?.dispose();
      if (avatar?.model) {
        const request = this.modelRequest;
        loadAvatarModel(avatar.model, avatar.rig).then((model) => {
          if (request !== this.modelRequest) {
            model?.dispose();
            return;
          }
          this.model = model;
          this.animator.setJoints(model?.joints);
          this.redressAvatar();
        });
      }
    }

    if (avatar?.animations?.length) {
      const animationKey = `${avatar.userId}|${avatar.animations.length}|${avatar.animations[0]?.keys.length ?? 0}`;
      if (animationKey !== this.animationKey) {
        this.animationKey = animationKey;
        this.animator.setClips(avatar.animations);
      }
    }
  }

  /** Rebuild the six body parts after their garments or face arrived. */
  private redressAvatar(): void {
    for (const id of this.avatarRoles.keys()) {
      const atom = this.parts.get(id);
      if (!atom) continue;
      this.removeVisual(atom);
      this.createVisual(atom);
      this.place(atom, atom.to);
      atom.moving = false;
    }
  }

  /** Hide the local character, or restore it. Zero-scaling pool slots and
   * toggling individual meshes keeps the batching path unchanged. */
  setHiddenParts(ids: Iterable<number>): void {
    const next = new Set(ids);
    const previous = this.hidden;
    this.hidden = next;
    for (const id of previous) {
      if (next.has(id)) continue;
      const atom = this.parts.get(id);
      if (atom) this.place(atom, atom.moving ? this.trsAt(atom, performance.now()) : atom.to);
    }
    for (const id of next) {
      if (previous.has(id)) continue;
      const atom = this.parts.get(id);
      if (atom) this.place(atom, atom.to);
    }
    // The frame's step already flushed; hiding runs after it, so upload
    // the zeroed slots before this frame draws.
    for (const list of this.pools.values()) {
      for (const pool of list) pool.flush();
    }
  }

  /** A part's drawn pose this frame, interpolated like `step` draws it. */
  partTransform(id: number, now: number): Trs | undefined {
    const atom = this.parts.get(id);
    if (!atom) return undefined;
    if (this.localParts.has(id)) return atom.to;
    return atom.moving ? this.trsAt(atom, now) : atom.to;
  }

  /** Distance from `from` to the nearest anchored geometry toward `to`, or
   * null when the segment is clear. */
  collisionRay(from: THREE.Vector3, to: THREE.Vector3): number | null {
    if (!this.collisionEnabled) return null;
    const direction = to.clone().sub(from);
    const length = direction.length();
    if (length < 1e-4) return null;
    direction.divideScalar(length);
    let best: number | null = null;
    for (const box of this.collisionLarge.values()) {
      const hit = rayBox(from, direction, length, box);
      if (hit !== null && (best === null || hit < best)) best = hit;
    }

    const cell = COLLISION_CELL;
    let cx = Math.floor(from.x / cell);
    let cy = Math.floor(from.y / cell);
    let cz = Math.floor(from.z / cell);
    const stepX = direction.x > 0 ? 1 : direction.x < 0 ? -1 : 0;
    const stepY = direction.y > 0 ? 1 : direction.y < 0 ? -1 : 0;
    const stepZ = direction.z > 0 ? 1 : direction.z < 0 ? -1 : 0;
    const deltaX = stepX === 0 ? Infinity : cell / Math.abs(direction.x);
    const deltaY = stepY === 0 ? Infinity : cell / Math.abs(direction.y);
    const deltaZ = stepZ === 0 ? Infinity : cell / Math.abs(direction.z);
    const boundX = (x: number) => (stepX > 0 ? (x + 1) * cell : x * cell);
    const boundY = (y: number) => (stepY > 0 ? (y + 1) * cell : y * cell);
    const boundZ = (z: number) => (stepZ > 0 ? (z + 1) * cell : z * cell);
    let maxX = stepX === 0 ? Infinity : (boundX(cx) - from.x) / direction.x;
    let maxY = stepY === 0 ? Infinity : (boundY(cy) - from.y) / direction.y;
    let maxZ = stepZ === 0 ? Infinity : (boundZ(cz) - from.z) / direction.z;
    let travelled = 0;
    for (let visited = 0; visited < 512; visited++) {
      const ids = this.collisionCells.get(`${cx},${cy},${cz}`);
      if (ids) {
        for (const id of ids) {
          const box = this.collisionBoxes.get(id);
          if (!box) continue;
          const hit = rayBox(from, direction, length, box);
          if (hit !== null && (best === null || hit < best)) best = hit;
        }
      }
      const next = Math.min(maxX, maxY, maxZ);
      if (!(next <= length)) break;
      travelled = next;
      if (maxX <= maxY && maxX <= maxZ) {
        cx += stepX;
        maxX += deltaX;
      } else if (maxY <= maxZ) {
        cy += stepY;
        maxY += deltaY;
      } else {
        cz += stepZ;
        maxZ += deltaZ;
      }
      if (best !== null && best <= travelled) break;
    }
    return best;
  }

  private indexCollision(snap: PartSnapshot, trs: Trs): void {
    if (!snap.anchored || snap.layer !== 0 || snap.transparency >= 0.9 || snap.onTop || snap.over) {
      return;
    }
    if (Math.max(snap.size[0], snap.size[1], snap.size[2]) < 0.5) return;
    if (this.localParts.has(snap.id)) return;
    const box = boxOf(trs);
    this.unindexCollision(snap.id);
    const span = (low: number, high: number) => (high - low) / COLLISION_CELL;
    if (
      span(box.min.x, box.max.x) > COLLISION_MAX_CELLS ||
      span(box.min.y, box.max.y) > COLLISION_MAX_CELLS ||
      span(box.min.z, box.max.z) > COLLISION_MAX_CELLS
    ) {
      this.collisionLarge.set(snap.id, box);
      return;
    }
    const cells: string[] = [];
    const x0 = Math.floor(box.min.x / COLLISION_CELL);
    const x1 = Math.floor(box.max.x / COLLISION_CELL);
    const y0 = Math.floor(box.min.y / COLLISION_CELL);
    const y1 = Math.floor(box.max.y / COLLISION_CELL);
    const z0 = Math.floor(box.min.z / COLLISION_CELL);
    const z1 = Math.floor(box.max.z / COLLISION_CELL);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x},${y},${z}`;
          let ids = this.collisionCells.get(key);
          if (!ids) {
            ids = new Set();
            this.collisionCells.set(key, ids);
          }
          ids.add(snap.id);
          cells.push(key);
        }
      }
    }
    this.collisionBoxes.set(snap.id, box);
    this.collisionCellsOf.set(snap.id, cells);
  }

  private unindexCollision(id: number): void {
    const cells = this.collisionCellsOf.get(id);
    if (cells) {
      for (const key of cells) {
        const ids = this.collisionCells.get(key);
        if (!ids) continue;
        ids.delete(id);
        if (ids.size === 0) this.collisionCells.delete(key);
      }
      this.collisionCellsOf.delete(id);
    }
    this.collisionBoxes.delete(id);
    this.collisionLarge.delete(id);
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
    this.collisionCells.clear();
    this.collisionBoxes.clear();
    this.collisionCellsOf.clear();
    this.collisionLarge.clear();
    this.hidden.clear();
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
      moving: false,
    };
    this.parts.set(snap.id, atom);
    this.createVisual(atom);
    this.indexCollision(snap, trs);
  }

  private updatePart(snap: PartSnapshot, now: number): void {
    const atom = this.parts.get(snap.id);
    if (!atom) {
      this.addPart(snap, now);
      return;
    }
    this.unindexCollision(snap.id);
    const current = atom.moving ? this.trsAt(atom, now) : atom.to;
    this.removeVisual(atom);
    atom.snap = snap;
    atom.from = current;
    atom.to = trsOf(snap);
    atom.changedAt = now;
    atom.moving = !this.localParts.has(snap.id);
    this.createVisual(atom);
    this.indexCollision(snap, atom.to);
  }

  private removePart(id: number): void {
    const atom = this.parts.get(id);
    if (!atom) return;
    this.unindexCollision(id);
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
    if (atom.ownedMaterials) {
      for (const material of atom.ownedMaterials) material.dispose();
      atom.ownedMaterials = undefined;
    }
    atom.plane = undefined;
    atom.meshRequested = undefined;
    atom.modelPart = false;
  }

  private canInstance(snap: PartSnapshot): boolean {
    if (snap.shape === SHAPE.FILE || snap.shape === SHAPE.TRUSS || snap.shape === SHAPE.ADORN) {
      return false;
    }
    // Primitive geometry has no colour attribute; keep these as meshes.
    if (snap.vertexColors) return false;
    return true;
  }

  /** Everything that changes the shared material or its draw state. Two
   * parts may share a pool only when every one of these matches. */
  private poolKey(snap: PartSnapshot, geometry: string): string {
    const maps = snap.maps;
    const opacity = Math.round((1 - Math.min(Math.max(snap.transparency, 0), 1)) * 100);
    return [
      geometry,
      snap.material,
      snap.castShadow && opacity > 0 ? 1 : 0,
      snap.doubleSided ? 1 : 0,
      snap.light,
      snap.onTop ? 1 : 0,
      opacity,
      snap.over ? 1 : 0,
      snap.texture ?? "",
      maps.color ?? "",
      maps.normal ?? "",
      maps.roughness ?? "",
      maps.metalness ?? "",
      Math.round(snap.reflectance * 10),
    ].join("|");
  }

  private createVisual(atom: Atom): void {
    if (atom.snap.layer > 0) {
      this.createOverlay(atom);
      return;
    }
    if (atom.snap.transparency >= 0.999) return;
    if (atom.snap.shape === SHAPE.TRUSS) {
      // Trusses are streams of bars; the browser draws a box for now.
      return;
    }
    if (atom.snap.shape === SHAPE.FILE) {
      this.createFile(atom);
      return;
    }
    if (this.avatarRoles.has(atom.snap.id)) {
      this.createAvatarPart(atom);
      return;
    }
    if (this.canInstance(atom.snap)) {
      this.createInstanced(atom);
      return;
    }
    this.createIndividual(atom);
  }

  private createInstanced(atom: Atom, geometry = geometryForShape(atom.snap.shape), prefix?: string): void {
    const snap = atom.snap;
    if (!geometry) return;
    const key = this.poolKey(snap, prefix ?? String(snap.shape));
    let list = this.pools.get(key);
    if (!list) {
      list = [];
      this.pools.set(key, list);
    }
    let pool = list.find((candidate) => !candidate.full);
    if (!pool) {
      const material = instancedMaterial(snap, this.textures);
      pool = new Pool(geometry, material, snap.castShadow);
      pool.mesh.renderOrder = snap.onTop ? 1000 : 0;
      list.push(pool);
      this.scene.add(pool.mesh);
    }
    const slot = pool.alloc();
    atom.pool = pool;
    atom.slot = slot;
    this.place(atom, atom.from);
    pool.setColor(slot, tinted(snap.color, snap.maps.tint));
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
    this.place(atom, atom.from);
  }

  /** A standard R6 body part: the template atlas on the torso and limbs,
   * the default face on the head's front. Drawn on its own because the
   * clothing needs its own geometry and material. */
  private createAvatarPart(atom: Atom): void {
    const snap = atom.snap;
    const role = this.avatarRoles.get(snap.id);
    if (!role) return;
    const model = this.model?.roles.get(role);
    if (model) {
      const mesh = new THREE.Mesh(model.geometry, model.materials);
      mesh.castShadow = snap.castShadow && snap.transparency < 0.999;
      mesh.receiveShadow = snap.transparency < 0.999;
      mesh.renderOrder = snap.onTop ? 1000 : 0;
      atom.object = mesh;
      atom.modelPart = true;
      this.scene.add(mesh);
      this.place(atom, atom.from);
      return;
    }
    const geometry =
      role === "Head" ? geometryForShape(snap.shape) : avatarGeometry(role);
    if (!geometry) return;
    const materials = this.dresser.materials(role, snap.color);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.castShadow = snap.castShadow && snap.transparency < 0.999;
    mesh.receiveShadow = snap.transparency < 0.999;
    mesh.renderOrder = snap.onTop ? 1000 : 0;
    atom.object = mesh;
    atom.modelPart = false;
    atom.ownedMaterials = Array.isArray(materials) ? materials : [materials];
    this.scene.add(mesh);
    this.place(atom, atom.from);
  }

  private createFile(atom: Atom): void {
    const hash = atom.snap.mesh;
    if (!hash) return;
    const ready = () => {
      const current = this.parts.get(atom.snap.id);
      if (current !== atom || atom.snap.mesh !== hash || atom.pool || atom.object) return;
      const geometry = this.meshes.get(hash);
      if (!geometry) return;
      if (atom.snap.vertexColors) {
        const material = partMaterial(atom.snap, this.textures);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = atom.snap.castShadow && atom.snap.transparency < 0.999;
        mesh.receiveShadow = atom.snap.transparency < 0.999;
        mesh.renderOrder = atom.snap.onTop ? 1000 : 0;
        atom.object = mesh;
        atom.ownedMaterial = material;
        this.scene.add(mesh);
        this.place(atom, atom.from);
        return;
      }
      this.createInstanced(atom, geometry, `file:${hash}`);
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
        this.place(atom, atom.from);
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
    this.place(atom, atom.from);
  }

  private trsAt(atom: Atom, now: number): Trs {
    const t = Math.min(Math.max((now - atom.changedAt) / SNAPSHOT_MS, 0), 1);
    return {
      position: atom.from.position.clone().lerp(atom.to.position, t),
      quaternion: atom.from.quaternion.clone().slerp(atom.to.quaternion, t),
      scale: atom.from.scale.clone().lerp(atom.to.scale, t),
    };
  }

  private place(atom: Atom, trs: Trs): void {
    const hidden = this.hidden.has(atom.snap.id);
    if (atom.pool && atom.slot !== undefined) {
      atom.pool.setMatrix(
        atom.slot,
        hidden
          ? ZERO_MATRIX
          : new THREE.Matrix4().compose(trs.position, trs.quaternion, trs.scale),
      );
    } else if (atom.object) {
      atom.object.visible = !hidden;
      if (hidden) return;
      if (atom.plane) {
        const offset = atom.plane.offset.clone().applyQuaternion(trs.quaternion);
        atom.object.position.copy(trs.position).add(offset);
        atom.object.quaternion.copy(trs.quaternion).multiply(atom.plane.turn);
        atom.object.scale.set(1, 1, 1);
      } else {
        atom.object.position.copy(trs.position);
        atom.object.quaternion.copy(trs.quaternion);
        if (atom.modelPart) atom.object.scale.set(1, 1, 1);
        else atom.object.scale.copy(trs.scale);
      }
    }
  }

  /** Give moving parts their transform for this frame. Static parts
   * already hold their final matrix, so they cost nothing per frame. */
  step(now: number): void {
    for (const atom of this.parts.values()) {
      if (!atom.moving) continue;
      let trs: Trs;
      if (now - atom.changedAt >= SNAPSHOT_MS) {
        trs = atom.to;
        atom.moving = false;
      } else {
        trs = this.trsAt(atom, now);
      }
      this.place(atom, trs);
    }
    for (const list of this.pools.values()) {
      for (const pool of list) pool.flush();
    }
  }

  /** The panel's answer carries the clips; the snapshots that follow
   * only carry the body. */
  setAvatarAnimations(clips: import("./protocol").AnimationClip[]): void {
    if (clips.length === 0) return;
    this.animationKey = "panel";
    this.animator.setClips(clips);
  }

  /** Replace the local lights. They change rarely, so rebuilding the
   * Three lights here keeps the per-frame work to picking the nearest. */
  private applyLights(lights: LightSnapshot[]): void {
    for (const light of this.lightObjects.values()) {
      light.removeFromParent();
      if (light instanceof THREE.SpotLight) light.target.removeFromParent();
      light.dispose();
    }
    this.lightObjects.clear();
    this.lights = lights;
  }

  /** Keep at most 24 local lights alive around the camera: a room's lamp
   * must reach the browser, but a place with hundreds must not stall it. */
  private updateLights(): void {
    if (this.lights.length === 0) {
      for (const light of this.lightObjects.values()) light.visible = false;
      return;
    }
    const eye = this.camera.position;
    const nearest = this.lights
      .map((light, index) => {
        const dx = light.position[0] - eye.x;
        const dy = light.position[1] - eye.y;
        const dz = light.position[2] - eye.z;
        return [index, dx * dx + dy * dy + dz * dz] as const;
      })
      .sort((a, b) => a[1] - b[1])
      .slice(0, 24)
      .map(([index]) => index);
    const keep = new Set(nearest);
    for (const [index, light] of this.lightObjects) {
      if (!keep.has(index)) light.visible = false;
    }
    for (const index of nearest) {
      const snap = this.lights[index];
      let light = this.lightObjects.get(index);
      if (!light) {
        light = this.makeLight(snap);
        this.lightObjects.set(index, light);
        this.scene.add(light);
        if (light instanceof THREE.SpotLight) this.scene.add(light.target);
      }
      light.visible = snap.brightness > 0;
      light.color.copy(srgb(snap.color));
      light.intensity = Math.max(0, snap.brightness) * 4;
      light.position.set(snap.position[0], snap.position[1], snap.position[2]);
      if (light instanceof THREE.SpotLight) {
        light.distance = Math.max(0.1, snap.range);
        const angle = Math.max(0.02, Math.min(Math.PI / 2 - 0.01, (snap.angle * Math.PI) / 360));
        light.angle = angle;
        light.target.position.set(
          snap.position[0] + snap.direction[0] * snap.range,
          snap.position[1] + snap.direction[1] * snap.range,
          snap.position[2] + snap.direction[2] * snap.range,
        );
        light.target.updateMatrixWorld();
      } else if (light instanceof THREE.PointLight) {
        light.distance = Math.max(0.1, snap.range);
      }
    }
  }

  private makeLight(snap: LightSnapshot): THREE.Light {
    if (snap.shape === 0) {
      return new THREE.PointLight(0xffffff, 1, 8, 1);
    }
    const light = new THREE.SpotLight(0xffffff, 1, 8, Math.PI / 4, 0.2, 1);
    light.target = new THREE.Object3D();
    return light;
  }

  /** Put the six body parts where the current clip says they are. The
   * server's root is authoritative; the limbs hang from it. */
  private animateAvatar(dt: number): void {
    const root = this.player?.root;
    if (root == null || this.avatarParts.size === 0) return;
    const rootAtom = this.parts.get(root);
    if (!rootAtom) return;
    const locals = this.animator.update(dt, rootAtom.to.position, this.player?.velocity);
    if (!locals) return;
    const rootMatrix = new THREE.Matrix4().compose(
      rootAtom.to.position,
      rootAtom.to.quaternion,
      UNIT_SCALE,
    );
    const torso = rootMatrix.multiply(locals.get("Torso")!);
    for (const role of R6_ROLES) {
      const id = this.avatarParts.get(role);
      if (id === undefined) continue;
      const atom = this.parts.get(id);
      if (!atom?.object) continue;
      // The torso's own local already includes its pose; the limbs are
      // relative to the torso, so only they get a second multiplication.
      const world =
        role === "Torso" ? torso.clone() : torso.clone().multiply(locals.get(role)!);
      atom.object.position.setFromMatrixPosition(world);
      atom.object.quaternion.setFromRotationMatrix(world);
    }
  }

  /** Light the sun and sky around this frame's camera, then draw. */
  render(now: number, dt: number): void {
    if (this.lighting) this.sunPosition(new THREE.Vector3(...this.lighting.sunDirection));
    this.sky.mesh.position.copy(this.camera.position);
    this.animateAvatar(dt);
    this.updateLights();
    this.renderer.render(this.scene, this.camera);
    this.adapt(now);
  }

  /** The drawing buffer's current scale, as a percentage of the device's
   * own pixel ratio. */
  get renderScalePercent(): number {
    return Math.round((this.pixelRatio / this.nativePixelRatio) * 100);
  }

  /** The slider's top: at most four device pixels per CSS pixel. */
  get maxRenderScale(): number {
    return Math.min(200, Math.floor(((4 / this.nativePixelRatio) * 100) / 5) * 5);
  }

  /** Pick a resolution as a percentage of the device's pixel ratio. A
   * manual choice stops adaptive scaling until "Auto" is pressed. */
  setRenderScale(percent: number, persist = true): void {
    if (!Number.isFinite(percent)) return;
    const value = Math.min(this.maxRenderScale, Math.max(25, percent));
    this.renderScale = value;
    this.adaptive = false;
    this.setPixelRatio(this.ratioForScale(value));
    if (persist) {
      try {
        localStorage.setItem("rook.renderScale", String(value));
      } catch {
        // Storage can be unavailable; the setting lasts for this visit.
      }
    }
  }

  /** Return to the frame-rate-driven resolution. */
  setAutoResolution(): void {
    this.renderScale = null;
    this.adaptive = true;
    this.qualityFrames = 0;
    this.qualitySince = performance.now();
    this.setPixelRatio(Math.min(this.pixelRatio, this.maxPixelRatio));
    try {
      localStorage.removeItem("rook.renderScale");
    } catch {
      // Storage can be unavailable; nothing was stored.
    }
  }

  private ratioForScale(percent: number): number {
    return Math.min(4, Math.max(0.5, (this.nativePixelRatio * percent) / 100));
  }

  /** Trade resolution for frame rate, within the device's pixel ratio and
   * a floor that keeps the image readable. */
  private adapt(now: number): void {
    if (!this.adaptive) return;
    if (document.hidden) {
      this.qualityFrames = 0;
      this.qualitySince = now;
      return;
    }
    this.qualityFrames++;
    const elapsed = now - this.qualitySince;
    if (elapsed < 2000) return;
    const fps = (this.qualityFrames * 1000) / elapsed;
    this.qualityFrames = 0;
    this.qualitySince = now;
    const floor = 1;
    if (fps < 48 && this.pixelRatio > floor + 0.001) {
      this.setPixelRatio(Math.max(floor, this.pixelRatio - 0.15));
    } else if (fps > 57 && this.pixelRatio < this.maxPixelRatio - 0.001) {
      this.setPixelRatio(Math.min(this.maxPixelRatio, this.pixelRatio + 0.1));
    }
  }

  private setPixelRatio(value: number): void {
    this.pixelRatio = value;
    this.renderer.setPixelRatio(value);
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
