//! Meshes and images kept for the browser: the session collects what
//! `rook-scene` decoded, and the HTTP endpoints serve either Rook's own
//! layout (meshes) or a PNG the browser can draw (images).

use std::sync::Arc;

use rook_content::decode::image::Image;
use rook_content::decode::mesh::Mesh;
use rustc_hash::FxHashMap;

/// A hash as the URL- and JavaScript-friendly lowercase hex.
pub(crate) fn hex(bytes: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for &b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 0xf)]));
    }
    out
}

/// The meshes a session has decoded, by hash. Clones are cheap: the
/// session and the HTTP handlers share the `Arc`.
#[derive(Debug, Default)]
pub(crate) struct MeshStore {
    meshes: FxHashMap<[u8; 32], Arc<Mesh>>,
}

impl MeshStore {
    pub(crate) fn insert(&mut self, hash: [u8; 32], mesh: Arc<Mesh>) {
        self.meshes.insert(hash, mesh);
    }

    pub(crate) fn remove(&mut self, hash: &[u8; 32]) {
        self.meshes.remove(hash);
    }

    pub(crate) fn get(&self, hash: &[u8; 32]) -> Option<Arc<Mesh>> {
        self.meshes.get(hash).cloned()
    }

    pub(crate) fn hashes(&self) -> Vec<String> {
        self.meshes.keys().map(hex).collect()
    }

    pub(crate) fn count(&self) -> usize {
        self.meshes.len()
    }
}

/// The images a session has loaded, by the hash of their file.
#[derive(Debug, Default)]
pub(crate) struct ImageStore {
    images: FxHashMap<[u8; 32], Arc<Image>>,
    /// PNGs made from them, so a repeated request for a decal is a read
    /// rather than a re-encode.
    png: FxHashMap<[u8; 32], Arc<[u8]>>,
}

impl ImageStore {
    pub(crate) fn insert(&mut self, hash: [u8; 32], image: Arc<Image>) {
        self.images.insert(hash, image);
    }

    pub(crate) fn png(&self, hash: &[u8; 32]) -> Option<Arc<[u8]>> {
        self.png.get(hash).cloned()
    }

    pub(crate) fn put_png(&mut self, hash: [u8; 32], bytes: Arc<[u8]>) {
        self.png.insert(hash, bytes);
    }

    pub(crate) fn hashes(&self) -> Vec<String> {
        self.images.keys().map(hex).collect()
    }

    pub(crate) fn count(&self) -> usize {
        self.images.len()
    }
}

/// A mesh in the browser's flat layout:
///
/// ```text
/// "RKMW" | u32 version | u32 vertices | u32 indices | u32 flags
/// f32 positions[3n] | f32 normals[3n]? | f32 uvs[2n]? |
/// u8 colors[4n]? | u32 indices[m]
/// ```
///
/// The full-detail triangle range is `indices`' first level; lower levels
/// are not streamed yet, so the browser draws every triangle the file has
/// at its full detail.
pub(crate) fn mesh_blob(mesh: &Mesh) -> Vec<u8> {
    const FLAG_NORMALS: u32 = 1;
    const FLAG_UVS: u32 = 2;
    const FLAG_COLORS: u32 = 4;

    let n = mesh.positions.len();
    let has_normals = mesh.normals.len() == n;
    let has_uvs = mesh.uvs.len() == n;
    let has_colors = mesh.colors.len() == n;
    let flags = u32::from(has_normals) * FLAG_NORMALS
        | u32::from(has_uvs) * FLAG_UVS
        | u32::from(has_colors) * FLAG_COLORS;

    let floats = n * 3 + if has_normals { n * 3 } else { 0 } + if has_uvs { n * 2 } else { 0 };
    let mut out = Vec::with_capacity(
        20 + floats * 4 + if has_colors { n * 4 } else { 0 } + mesh.indices.len() * 4,
    );
    out.extend_from_slice(b"RKMW");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(n as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.indices.len() as u32).to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    for p in &mesh.positions {
        for v in p {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    if has_normals {
        for v in &mesh.normals {
            for f in v {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
    }
    if has_uvs {
        for v in &mesh.uvs {
            for f in v {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
    }
    if has_colors {
        for c in &mesh.colors {
            out.extend_from_slice(c);
        }
    }
    for i in &mesh.indices {
        out.extend_from_slice(&i.to_le_bytes());
    }
    out
}

/// An image as PNG for the browser, at the first mip level no larger than
/// 1024 (the largest Studio uploads); block-compressed material maps are
/// expanded first.
pub(crate) fn image_png(image: &Image) -> anyhow::Result<Vec<u8>> {
    let image = image.decompressed(1024);
    let level = image.mips.first().expect("at least one mip");
    let rgba = ::image::RgbaImage::from_raw(image.width, image.height, level.clone())
        .ok_or_else(|| anyhow::anyhow!("image {0}x{1} isn't RGBA", image.width, image.height))?;
    let mut out = Vec::new();
    let encoder = ::image::codecs::png::PngEncoder::new(&mut out);
    use ::image::ImageEncoder;
    encoder.write_image(
        rgba.as_raw(),
        image.width,
        image.height,
        ::image::ExtendedColorType::Rgba8,
    )?;
    Ok(out)
}
