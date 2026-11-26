//! The classic R6 look: Roblox's 585×559 shirt and pants templates cut
//! into per-face UVs, the way the reference client's compositor does it.
//!
//! One atlas per body role is the whole template with the body colour
//! painted underneath the garments. Each face's UVs point into that
//! template's rectangle for the face (from `game.js`), so the shirt and
//! pants land on the right faces without any per-face cropping.

import * as THREE from "three";

const TEMPLATE_W = 585;
const TEMPLATE_H = 559;
/** Half a template pixel of inset, so mipmaps don't sample the seam. */
const INSET = 0.5;

type Face = "px" | "nx" | "py" | "ny" | "pz" | "nz";
type Rect = [number, number, number, number];

const TORSO: Record<Face, Rect> = {
  pz: [231, 74, 359, 202],
  nz: [427, 74, 555, 202],
  nx: [165, 74, 229, 202],
  px: [361, 74, 425, 202],
  py: [231, 8, 359, 72],
  ny: [231, 204, 359, 268],
};

const RIGHT_LIMB: Record<Face, Rect> = {
  pz: [217, 355, 281, 483],
  nz: [85, 355, 149, 483],
  nx: [151, 355, 215, 483],
  px: [19, 355, 83, 483],
  py: [217, 289, 281, 353],
  ny: [217, 485, 281, 549],
};

const LEFT_LIMB: Record<Face, Rect> = {
  pz: [308, 355, 372, 483],
  px: [374, 355, 438, 483],
  nz: [440, 355, 504, 483],
  nx: [506, 355, 570, 483],
  py: [308, 289, 372, 353],
  ny: [308, 485, 372, 549],
};

type Garment = "shirt" | "pants";

interface Role {
  rects: Record<Face, Rect>;
  /** Drawn in order; the shirt covers the pants where both exist. */
  garments: Garment[];
}

const ROLES: Record<string, Role> = {
  Torso: { rects: TORSO, garments: ["pants", "shirt"] },
  "Right Arm": { rects: RIGHT_LIMB, garments: ["shirt"] },
  "Left Arm": { rects: LEFT_LIMB, garments: ["shirt"] },
  "Right Leg": { rects: RIGHT_LIMB, garments: ["pants"] },
  "Left Leg": { rects: LEFT_LIMB, garments: ["pants"] },
};

/** BoxGeometry's face order: +X, −X, +Y, −Y, +Z, −Z. */
const FACES: Face[] = ["px", "nx", "py", "ny", "pz", "nz"];

function faceOf(nx: number, ny: number, nz: number): Face {
  const x = Math.abs(nx);
  const y = Math.abs(ny);
  const z = Math.abs(nz);
  if (y >= x && y >= z) return ny >= 0 ? "py" : "ny";
  if (x >= z) return nx >= 0 ? "px" : "nx";
  return nz >= 0 ? "pz" : "nz";
}

/** The normalized part coordinate the template samples for a face,
 * exactly as `game.js`'s `o_` maps them. */
function templatePoint(face: Face, x: number, y: number, z: number): [number, number] {
  switch (face) {
    case "pz":
      return [x, y];
    case "nz":
      return [1 - x, y];
    case "nx":
      return [z, y];
    case "px":
      return [1 - z, y];
    case "py":
      return [x, 1 - z];
    case "ny":
      return [x, z];
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The texture coordinate of a unit-cube vertex on a role's atlas. */
function uvOf(role: string, face: Face, x: number, y: number, z: number): [number, number] {
  const rect = ROLES[role].rects[face];
  const [u, v] = templatePoint(face, x, y, z);
  const insetU = INSET / (rect[2] - rect[0]);
  const insetV = INSET / (rect[3] - rect[1]);
  const cu = Math.min(1 - insetU, Math.max(insetU, u));
  const cv = Math.min(1 - insetV, Math.max(insetV, v));
  const px = rect[0] + INSET + (rect[2] - INSET - (rect[0] + INSET)) * cu;
  const py = rect[3] - INSET - (rect[3] - INSET - (rect[1] + INSET)) * cv;
  return [px / TEMPLATE_W, 1 - py / TEMPLATE_H];
}

const geometries = new Map<string, THREE.BufferGeometry>();

/** A unit cube whose UVs sample `role`'s template rectangles. */
export function avatarGeometry(role: string): THREE.BufferGeometry {
  let geometry = geometries.get(role);
  if (geometry) return geometry;
  geometry = new THREE.BoxGeometry(1, 1, 1);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const face = faceOf(normal.getX(i), normal.getY(i), normal.getZ(i));
    const [u, v] = uvOf(
      role,
      face,
      position.getX(i) + 0.5,
      position.getY(i) + 0.5,
      position.getZ(i) + 0.5,
    );
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  geometries.set(role, geometry);
  return geometry;
}

/** A face for the head's front, drawn over the head colour. */
function faceCanvas(color: [number, number, number]): HTMLCanvasElement {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = rgb(color);
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.ellipse(size * 0.34, size * 0.42, size * 0.07, size * 0.1, 0, 0, Math.PI * 2);
  ctx.ellipse(size * 0.66, size * 0.42, size * 0.07, size * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.55, size * 0.2, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
  return canvas;
}

function rgb(color: [number, number, number]): string {
  return `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(
    color[2] * 255,
  )})`;
}

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** The shirt and pants images, and the materials built from them. */
export class AvatarDresser {
  private shirt: HTMLImageElement | null = null;
  private pants: HTMLImageElement | null = null;
  private key = "";
  private token = 0;
  private atlases = new Map<string, THREE.CanvasTexture>();
  private faces = new Map<string, THREE.CanvasTexture>();

  /** Load a look's garments; `changed` runs once the images arrive, so
   * the caller can re-dress the body with the finished atlas. */
  set(shirt: string | null, pants: string | null, changed: () => void): void {
    const key = `${shirt ?? ""}|${pants ?? ""}`;
    if (key === this.key) return;
    this.key = key;
    this.token++;
    this.disposeAtlases();
    this.shirt = null;
    this.pants = null;
    const token = this.token;
    const load = (url: string | null, assign: (image: HTMLImageElement | null) => void) => {
      if (!url) return;
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        if (token !== this.token) return;
        assign(image);
        changed();
      };
      image.onerror = () => {
        if (token !== this.token) return;
        assign(null);
      };
      image.src = url;
    };
    load(shirt, (image) => (this.shirt = image));
    load(pants, (image) => (this.pants = image));
  }

  /** The materials for a body part. The head gets the face on its front
   * and body colour elsewhere; the rest sample the template. */
  materials(role: string, color: [number, number, number]): THREE.Material | THREE.Material[] {
    if (role === "Head") {
      const key = rgb(color);
      let face = this.faces.get(key);
      if (!face) {
        face = canvasTexture(faceCanvas(color));
        this.faces.set(key, face);
      }
      const plain = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace),
        roughness: 0.55,
        metalness: 0,
      });
      return FACES.map((faceName) =>
        faceName === "nz"
          ? new THREE.MeshStandardMaterial({ map: face, roughness: 0.55, metalness: 0 })
          : plain,
      );
    }
    const texture = this.atlas(role, color);
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.62, metalness: 0 });
  }

  private atlas(role: string, color: [number, number, number]): THREE.CanvasTexture {
    const key = `${role}|${rgb(color)}`;
    const cached = this.atlases.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = TEMPLATE_W;
    canvas.height = TEMPLATE_H;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = rgb(color);
      ctx.fillRect(0, 0, TEMPLATE_W, TEMPLATE_H);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      for (const garment of ROLES[role]?.garments ?? []) {
        const image = garment === "shirt" ? this.shirt : this.pants;
        if (!image) continue;
        try {
          ctx.drawImage(image, 0, 0, TEMPLATE_W, TEMPLATE_H);
        } catch {
          // A broken image just leaves the body colour showing.
        }
      }
    }
    const texture = canvasTexture(canvas);
    this.atlases.set(key, texture);
    return texture;
  }

  private disposeAtlases(): void {
    for (const texture of this.atlases.values()) texture.dispose();
    this.atlases.clear();
    for (const texture of this.faces.values()) texture.dispose();
    this.faces.clear();
  }
}
