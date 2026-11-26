//! Roblox's own avatar mesh, attached to the six R6 joints.
//!
//! The 3D thumbnail API renders the avatar with its real package shapes,
//! clothing and accessories. R6 avatars come back as exactly the six R6
//! parts. R15 avatars come back as fifteen parts and their accessories;
//! they are grouped by body region and each region turns around a joint
//! read from the mesh, so the R6 clips still move a body that looks like
//! the player's own avatar.

import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AvatarModelInfo } from "./protocol";
import { R6_JOINTS, R6_ROLES, type JointFrame } from "./r6";

/** The classic R6 visual is 5.1 studs from its feet to the top of its
 * 1.2-stud head. Scaling every avatar to that height keeps the model on
 * the simulation's body. */
const R6_HEIGHT = 5.1;
const R6_FEET = -3;

interface Piece {
  mesh: THREE.Mesh;
  /** Bounds after the avatar was scaled and centred on the R6 body. */
  box: THREE.Box3;
  role: string;
  /** A `Player` group: part of the body, not a `Handle` accessory. */
  body: boolean;
}

export interface RoleModel {
  geometry: THREE.BufferGeometry;
  /** One per geometry group, in the same order. */
  materials: THREE.Material[];
  /** The frame the geometry was offset for. */
  joint: JointFrame;
}

export interface AvatarModel {
  roles: Map<string, RoleModel>;
  /** Non-standard joints (R15); `undefined` means the R6 rig's own. */
  joints?: Record<string, JointFrame>;
  dispose(): void;
}

/** Roblox's MTL lists the colour map again as `map_d`. Dropping the
 * repeat keeps opaque parts in the opaque pass and loads each PNG once;
 * hair still cuts out with the alpha test below. */
function withoutRepeatedAlpha(mtl: string): string {
  return mtl
    .split(/(?=^newmtl )/m)
    .map((block) => {
      const color = /^map_Kd\s+(.+)$/m.exec(block)?.[1]?.trim();
      if (!color) return block;
      return block
        .split("\n")
        .filter((line) => {
          const alpha = /^map_d\s+(.+)$/.exec(line.trim());
          return !alpha || alpha[1].trim() !== color;
        })
        .join("\n");
    })
    .join("\n");
}

/** Load and prepare one avatar's mesh. `null` leaves the standard body. */
export async function loadAvatarModel(
  info: AvatarModelInfo,
  rig: string | undefined,
): Promise<AvatarModel | null> {
  try {
    const url = new URL(info.mtl, window.location.href);
    const answer = await fetch(url);
    if (!answer.ok) throw new Error(`materials answered ${answer.status}`);
    const text = await answer.text();
    const base = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    const materials = new MTLLoader().parse(withoutRepeatedAlpha(text), base);
    materials.wrap = THREE.ClampToEdgeWrapping;
    materials.preload();
    const object = await new OBJLoader().setMaterials(materials).loadAsync(info.obj);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshPhongMaterial;
      if (material?.map && !material.alphaMap && material.opacity >= 0.999) {
        material.transparent = false;
        material.alphaTest = 0.5;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
    });
    return buildAvatarModel(object, rig === "R6");
  } catch (error) {
    console.warn("avatar model:", error);
    return null;
  }
}

/** Attach an already-parsed OBJ to the six R6 roles. Exported so the
 * classification can be checked without a browser. */
export function buildAvatarModel(object: THREE.Group, standard: boolean): AvatarModel | null {
  const pieces: Piece[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    pieces.push({
      mesh,
      box: geometry.boundingBox.clone(),
      role: "Torso",
      body: mesh.name.startsWith("Player"),
    });
  });
  if (pieces.length === 0) return null;
  let reference = pieces.filter((piece) => piece.body);
  if (reference.length === 0) {
    for (const piece of pieces) piece.body = true;
    reference = pieces;
  }

  const bodyBox = new THREE.Box3();
  for (const piece of reference) bodyBox.union(piece.box);
  if (bodyBox.isEmpty()) return null;

  // The head is the body piece reaching highest. Its bbox gives the
  // neck line, the centre line and the top of the body.
  let head = reference[0];
  for (const piece of reference) {
    if (piece.box.max.y > head.box.max.y + 1e-4) {
      head = piece;
    } else if (
      Math.abs(piece.box.max.y - head.box.max.y) <= 1e-4 &&
      piece.box.getCenter(new THREE.Vector3()).y > head.box.getCenter(new THREE.Vector3()).y
    ) {
      head = piece;
    }
  }
  const headCenter = head.box.getCenter(new THREE.Vector3());
  const size = bodyBox.getSize(new THREE.Vector3());
  const scale = R6_HEIGHT / Math.max(size.y, 1e-3);
  const normalise = new THREE.Matrix4()
    .makeTranslation(0, R6_FEET, 0)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(
      new THREE.Matrix4().makeTranslation(-headCenter.x, -bodyBox.min.y, -headCenter.z),
    );
  for (const piece of pieces) piece.box.applyMatrix4(normalise);

  const bodyBoxNorm = bodyBox.clone().applyMatrix4(normalise);
  const bodyWidth = bodyBoxNorm.max.x - bodyBoxNorm.min.x;
  const armX = bodyWidth * 0.24;
  const legX = bodyWidth * 0.04;
  const neckY = head.box.min.y;

  // Legs are the off-centre pieces below the neck; their highest point is
  // the hip line. Arms are further out than any leg.
  let hipY = -Infinity;
  for (const piece of reference) {
    const centre = piece.box.getCenter(new THREE.Vector3());
    if (Math.abs(centre.x) > legX && Math.abs(centre.x) <= armX && centre.y < neckY) {
      hipY = Math.max(hipY, piece.box.max.y);
    }
  }
  if (!Number.isFinite(hipY)) {
    hipY = bodyBoxNorm.min.y + (bodyBoxNorm.max.y - bodyBoxNorm.min.y) * 0.45;
  }
  for (const piece of reference) {
    const centre = piece.box.getCenter(new THREE.Vector3());
    if (centre.y > neckY) piece.role = "Head";
    else if (Math.abs(centre.x) > armX) {
      piece.role = centre.x < 0 ? "Left Arm" : "Right Arm";
    } else if (centre.y < hipY && Math.abs(centre.x) > legX) {
      piece.role = centre.x < 0 ? "Left Leg" : "Right Leg";
    } else {
      piece.role = "Torso";
    }
  }

  // Accessories follow the body piece they sit on: a hat the head, a
  // shoulder pad the arm, a dress the torso. Overlap is more reliable
  // than distance for clothing that spans a whole region.
  for (const piece of pieces) {
    if (piece.body) continue;
    let nearest = reference[0];
    let best = -Infinity;
    for (const body of reference) {
      const overlap = overlapVolume(piece.box, body.box);
      if (overlap > best) {
        best = overlap;
        nearest = body;
      }
    }
    if (best <= 0) {
      const centre = piece.box.getCenter(new THREE.Vector3());
      let nearestDistance = Infinity;
      for (const body of reference) {
        const distance = centre.distanceToSquared(body.box.getCenter(new THREE.Vector3()));
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = body;
        }
      }
    }
    piece.role = nearest.role;
  }

  const joints: Record<string, JointFrame> = {};
  if (standard) {
    for (const role of R6_ROLES) joints[role] = R6_JOINTS[role];
  } else {
    const headNorm = head.box.getCenter(new THREE.Vector3());
    joints.Torso = { pivot: [0, 0, 0], rest: [0, 0, 0] };
    joints.Head = {
      pivot: [headNorm.x, head.box.min.y, headNorm.z],
      rest: [headNorm.x, headNorm.y, headNorm.z],
    };
    for (const side of ["Left", "Right"] as const) {
      const arm = `${side} Arm`;
      const leg = `${side} Leg`;
      joints[arm] = limbJoint(arm, pieces.filter((piece) => piece.role === arm), true);
      joints[leg] = limbJoint(leg, pieces.filter((piece) => piece.role === leg), false);
    }
  }

  const roles = new Map<string, RoleModel>();
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials = new Set<THREE.Material>();
  const ownedTextures = new Set<THREE.Texture>();
  for (const role of R6_ROLES) {
    const parts = pieces.filter((piece) => piece.role === role);
    if (parts.length === 0) continue;
    const joint = joints[role];
    const offset = new THREE.Matrix4().makeTranslation(
      -joint.rest[0],
      -joint.rest[1],
      -joint.rest[2],
    );
    const matrix = offset.multiply(normalise);
    const sources: THREE.BufferGeometry[] = [];
    const roleMaterials: THREE.Material[] = [];
    for (const piece of parts) {
      const geometry = piece.mesh.geometry.clone();
      geometry.applyMatrix4(matrix);
      sources.push(geometry);
      const material = piece.mesh.material as THREE.Material;
      roleMaterials.push(material);
      ownedMaterials.add(material);
      // MTLLoader makes a texture for every map_* line, not just the
      // colour map; collect them all so an avatar change frees them.
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) ownedTextures.add(value);
      }
    }
    const geometry = mergeGeometries(sources, true);
    for (const source of sources) {
      if (source !== geometry) source.dispose();
    }
    if (!geometry) continue;
    geometry.computeBoundingSphere();
    roles.set(role, { geometry, materials: roleMaterials, joint });
    ownedGeometries.push(geometry);
  }
  if (roles.size === 0) return null;

  return {
    roles,
    joints: standard ? undefined : joints,
    dispose(): void {
      for (const geometry of ownedGeometries) geometry.dispose();
      for (const material of ownedMaterials) material.dispose();
      for (const texture of ownedTextures) texture.dispose();
    },
  };
}

/** The volume two boxes share; zero when they only touch or are apart. */
function overlapVolume(a: THREE.Box3, b: THREE.Box3): number {
  const x = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const y = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const z = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return x > 0 && y > 0 && z > 0 ? x * y * z : 0;
}

/** A shoulder or hip: the highest body part in the region, at its inner
 * top corner. Accessories don't move the pivot. */
function limbJoint(role: string, pieces: Piece[], arm: boolean): JointFrame {
  if (pieces.length === 0) return R6_JOINTS[role];
  const restBox = new THREE.Box3();
  for (const piece of pieces) restBox.union(piece.box);
  const rest = restBox.getCenter(new THREE.Vector3());
  const body = pieces.filter((piece) => piece.body);
  const source = body.length > 0 ? body : pieces;
  let upper = source[0];
  for (const piece of source) {
    if (piece.box.max.y > upper.box.max.y) upper = piece;
  }
  const centre = upper.box.getCenter(new THREE.Vector3());
  const x = arm ? (centre.x < 0 ? upper.box.max.x : upper.box.min.x) : centre.x;
  return {
    pivot: [x, upper.box.max.y - 0.02, centre.z],
    rest: [rest.x, rest.y, rest.z],
  };
}
