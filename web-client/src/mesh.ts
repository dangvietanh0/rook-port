//! Meshes and images from the server, and the geometry built from them.

import * as THREE from "three";

const MAGIC = 0x574d4b52; // "RKMW" little endian

/** A mesh file in the server's flat layout (see assets.rs). */
export function geometryFromBlob(buffer: ArrayBuffer): THREE.BufferGeometry {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== MAGIC) {
    throw new Error("not a Rook mesh");
  }
  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`mesh version ${version} isn't supported`);
  const vertices = view.getUint32(8, true);
  const indices = view.getUint32(12, true);
  const flags = view.getUint32(16, true);
  const hasNormals = (flags & 1) !== 0;
  const hasUvs = (flags & 2) !== 0;
  const hasColors = (flags & 4) !== 0;

  let offset = 20;
  const floatBytes = (count: number) => {
    const bytes = new Uint8Array(buffer, offset, count * 4);
    offset += count * 4;
    return new Float32Array(bytes.buffer, bytes.byteOffset, count).slice();
  };

  const positions = floatBytes(vertices * 3);
  const normals = hasNormals ? floatBytes(vertices * 3) : undefined;
  const uvs = hasUvs ? floatBytes(vertices * 2) : undefined;
  const colors = hasColors
    ? new Uint8Array(buffer, offset, vertices * 4).slice()
    : undefined;
  if (hasColors) offset += vertices * 4;
  const indexArray =
    indices > 0
      ? new Uint32Array(buffer, offset, indices).slice()
      : new Uint32Array(0);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (colors) {
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4, true));
  }
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/** Meshes fetched by content hash, shared by every part that draws them. */
export class MeshCache {
  private loaded = new Map<string, THREE.BufferGeometry>();
  private loading = new Map<string, Promise<void>>();
  private failed = new Set<string>();

  get(hash: string): THREE.BufferGeometry | undefined {
    return this.loaded.get(hash);
  }

  /** Load `hash`, calling `ready` once it's built. Retries a 404: a mesh
   * the session announces before its file has arrived is normal. */
  load(hash: string, ready: () => void): void {
    if (this.loaded.has(hash)) {
      ready();
      return;
    }
    if (this.loading.has(hash)) {
      void this.loading.get(hash)!.then(ready, () => {});
      return;
    }
    const promise = this.fetch(hash).then((geometry) => {
      if (geometry) {
        this.loaded.set(hash, geometry);
        this.failed.delete(hash);
      }
    });
    this.loading.set(hash, promise);
    void promise.finally(() => this.loading.delete(hash));
    void promise.then(ready, () => {});
  }

  private async fetch(hash: string): Promise<THREE.BufferGeometry | null> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`/api/mesh/${hash}`);
        if (response.ok) {
          return geometryFromBlob(await response.arrayBuffer());
        }
        if (response.status !== 404) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt === 29) {
          console.warn(`mesh ${hash}:`, error);
          this.failed.add(hash);
          return null;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 100));
    }
    return null;
  }

  clear(): void {
    for (const geometry of this.loaded.values()) geometry.dispose();
    this.loaded.clear();
    this.failed.clear();
  }
}

interface TextureEntry {
  texture: THREE.Texture;
  attempts: number;
  loaded: boolean;
}

/** Images from `/api/image/:hash`, with per-use colour space and flip. A
 * texture is handed out before its image arrives, so materials can be built
 * synchronously; the image fills in when the request finishes. */
export class Textures {
  private cache = new Map<string, TextureEntry>();
  private retryAt = new Map<string, number>();

  /** `flipY` off for UV-mapped mesh files (Roblox's V runs down the image);
   * on for the planes the client lays decals on. */
  get(hash: string, srgb: boolean, flipY: boolean): THREE.Texture {
    const key = `${hash}:${srgb ? "s" : "l"}:${flipY ? "f" : "u"}`;
    let entry = this.cache.get(key);
    if (!entry) {
      const texture = new THREE.Texture();
      texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.flipY = flipY;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 4;
      entry = { texture, attempts: 0, loaded: false };
      this.cache.set(key, entry);
      this.fetch(key, hash, entry);
    }
    return entry.texture;
  }

  private fetch(key: string, hash: string, entry: TextureEntry): void {
    const url = `/api/image/${hash}`;
    const image = new Image();
    image.onload = () => {
      entry.loaded = true;
      entry.texture.image = image;
      entry.texture.needsUpdate = true;
    };
    image.onerror = () => {
      entry.attempts++;
      // The session may announce an image before its file reaches the
      // server; keep asking for a while.
      if (entry.attempts < 40) {
        const delay = Math.min(1000 + entry.attempts * 250, 5000);
        if (this.cache.get(key) === entry) {
          this.retryAt.set(key, performance.now() + delay);
          setTimeout(() => {
            if (this.cache.get(key) === entry && !entry.loaded) {
              this.fetch(key, hash, entry);
            }
          }, delay);
        }
      }
    };
    image.src = url;
  }

  /** The six skybox faces, as a cube texture while they arrive. */
  skybox(hashes: string[]): THREE.CubeTexture {
    const cube = new THREE.CubeTexture();
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.generateMipmaps = false;
    cube.minFilter = THREE.LinearFilter;
    const images: HTMLImageElement[] = [];
    let arrived = 0;
    hashes.forEach((hash, i) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      images[i] = image;
      image.onload = () => {
        arrived++;
        if (arrived === 6) {
          cube.images = images;
          cube.needsUpdate = true;
        }
      };
      image.onerror = () => {
        // Try again later: skybox faces are ordinary assets.
        setTimeout(() => {
          image.src = `/api/image/${hash}?retry=${Date.now()}`;
        }, 1500);
      };
      image.src = `/api/image/${hash}`;
    });
    return cube;
  }

  clear(): void {
    for (const entry of this.cache.values()) entry.texture.dispose();
    this.cache.clear();
    this.retryAt.clear();
  }
}
