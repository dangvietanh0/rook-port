//! Roblox material presets and the Three materials built from a part's
//! look. Roblox's surfaces are approximated with a plausible metalness and
//! roughness; the built-in material maps (wood, metal, ...) arrive from the
//! server as images and override the preset where a pack is loaded.

import * as THREE from "three";
import type { PartSnapshot } from "./protocol";
import type { Textures } from "./mesh";

export const MATERIAL = {
  PLASTIC: 256,
  SMOOTH_PLASTIC: 272,
  NEON: 288,
  GLASS: 1568,
  FORCE_FIELD: 1584,
  WATER: 2048,
} as const;

interface Preset {
  metalness: number;
  roughness: number;
  emissive?: number;
  basic?: boolean;
}

function preset(material: number): Preset {
  switch (material) {
    case 272: // SmoothPlastic
      return { metalness: 0.0, roughness: 0.42 };
    case 288: // Neon
      return { metalness: 0.0, roughness: 0.25, emissive: 1.7 };
    case 512: // Wood
    case 528: // WoodPlanks
    case 2304: // Cardboard
    case 2309: // Leather
    case 2308: // RoofShingles
      return { metalness: 0.0, roughness: 0.78 };
    case 784: // Marble
    case 820: // Limestone
    case 832: // Granite
    case 836: // Pavement
    case 848: // Brick
    case 864: // Pebble
    case 880: // Cobblestone
    case 896: // Rock
    case 912: // Sandstone
      return { metalness: 0.0, roughness: 0.85 };
    case 800: // Slate
    case 816: // Concrete
    case 788: // Basalt
    case 804: // CrackedLava
      return { metalness: 0.0, roughness: 0.82 };
    case 1040: // CorrodedMetal
      return { metalness: 0.75, roughness: 0.62 };
    case 1056: // DiamondPlate
      return { metalness: 0.9, roughness: 0.45 };
    case 1072: // Foil
      return { metalness: 1.0, roughness: 0.35 };
    case 1088: // Metal
      return { metalness: 0.9, roughness: 0.38 };
    case 1280: // Grass
    case 1284: // LeafyGrass
    case 1344: // Mud
    case 1360: // Ground
      return { metalness: 0.0, roughness: 0.94 };
    case 1296: // Sand
    case 1392: // Salt
      return { metalness: 0.0, roughness: 0.92 };
    case 1312: // Fabric
    case 2305: // Carpet
      return { metalness: 0.0, roughness: 0.9 };
    case 1328: // Snow
      return { metalness: 0.0, roughness: 0.7 };
    case 1376: // Asphalt
      return { metalness: 0.0, roughness: 0.9 };
    case 1536: // Ice
      return { metalness: 0.0, roughness: 0.12 };
    case 1552: // Glacier
      return { metalness: 0.0, roughness: 0.3 };
    case 1568: // Glass
      return { metalness: 0.0, roughness: 0.05 };
    case 1584: // ForceField
      return { metalness: 0.0, roughness: 0.2 };
    case 1792: // Air
      return { metalness: 0.0, roughness: 0.0 };
    case 2048: // Water
      return { metalness: 0.0, roughness: 0.08 };
    case 2306: // CeramicTiles
    case 2307: // ClayRoofTiles
    case 2310: // Plaster
      return { metalness: 0.0, roughness: 0.55 };
    case 2311: // Rubber
      return { metalness: 0.0, roughness: 0.95 };
    default: // Plastic and anything newer
      return { metalness: 0.0, roughness: 0.55 };
  }
}

export function srgb(color: [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
}

export function tinted(color: [number, number, number], tint: [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(
    color[0] * tint[0],
    color[1] * tint[1],
    color[2] * tint[2],
    THREE.SRGBColorSpace,
  );
}

/** A material that can be shared by an InstancedMesh: white so the
 * instance colours show, with only the material class's shading. */
export function instancedMaterial(snap: PartSnapshot, textures: Textures): THREE.Material {
  const look = preset(snap.material);
  const opacity = 1 - Math.min(Math.max(snap.transparency, 0), 1);
  const side = snap.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  const transparent = opacity < 0.999;
  const depthWrite = opacity > 0.999;
  // Neon is unlit in practice; an unlit basic material keeps its glow
  // while the instance colour still comes from the part.
  if (snap.light >= 1 || look.emissive) {
    const basic = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side,
      transparent,
      opacity,
      depthWrite,
      toneMapped: snap.light < 2,
    });
    applyMaps(basic, snap, textures);
    return basic;
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: look.metalness,
    roughness: look.roughness,
    side,
    transparent,
    opacity,
    depthWrite,
    envMapIntensity: 0.4 + snap.reflectance * 1.4,
  });
  applyMaps(material, snap, textures);
  return material;
}

/** A part's own material: its colour, textures and transparency. */
export function partMaterial(snap: PartSnapshot, textures: Textures): THREE.Material {
  const look = preset(snap.material);
  const color = tinted(snap.color, snap.maps.tint);
  const opacity = 1 - Math.min(Math.max(snap.transparency, 0), 1);
  const side = snap.doubleSided ? THREE.DoubleSide : THREE.FrontSide;

  if (snap.light >= 1) {
    const basic = new THREE.MeshBasicMaterial({
      color,
      side,
      transparent: opacity < 0.999,
      opacity,
      toneMapped: snap.light < 2,
      depthWrite: opacity > 0.999,
    });
    applyMaps(basic, snap, textures);
    return basic;
  }

  const params: THREE.MeshStandardMaterialParameters = {
    color,
    metalness: look.metalness,
    roughness: look.roughness,
    side,
    transparent: opacity < 0.999,
    opacity,
    depthWrite: opacity > 0.999,
    envMapIntensity: 0.4 + snap.reflectance * 1.4,
  };
  if (look.emissive) {
    params.emissive = color.clone().multiplyScalar(look.emissive);
    params.emissiveIntensity = 1;
  }
  const material = new THREE.MeshStandardMaterial(params);
  applyMaps(material, snap, textures);
  return material;
}

function applyMaps(
  material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial,
  snap: PartSnapshot,
  textures: Textures,
): void {
  const maps = snap.maps;
  if (maps.color) {
    const texture = textures.get(maps.color, true, false);
    material.map = texture;
  }
  if (snap.texture) {
    material.map = textures.get(snap.texture, true, false);
  }
  if (material instanceof THREE.MeshStandardMaterial) {
    if (maps.normal) {
      material.normalMap = textures.get(maps.normal, false, false);
      material.normalScale.set(1, 1);
    }
    if (maps.roughness) material.roughnessMap = textures.get(maps.roughness, false, false);
    if (maps.metalness) material.metalnessMap = textures.get(maps.metalness, false, false);
  }
}

/** A decal's material: the image over a part's face or UVs, unlit enough to
 * read at any light level, and transparent by its own alpha. `meshUv` keeps
 * Roblox's V direction (down the image) for UV-mapped meshes; planes use
 * Three's flipped upload so the image stands upright. */
export function decalMaterial(
  snap: PartSnapshot,
  textures: Textures,
  meshUv: boolean,
): THREE.MeshStandardMaterial {
  const color = srgb(snap.color);
  const opacity = 1 - Math.min(Math.max(snap.transparency, 0), 1);
  const texture = textures.get(snap.image?.image ?? "", true, !meshUv);
  return new THREE.MeshStandardMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    roughness: 0.6,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.FrontSide,
  });
}
