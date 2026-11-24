//! Turning what `rook-scene` draws into the browser's structs.

use glam::{Mat3, Quat, Vec3};
use rook_engine::CameraView;
use rook_render::{
    DrawShape, ImagePlacement, Layer, Light, Lighting, MapAlpha, PartInstance, Tonemapper,
};
use rook_types::{PartShape, SurfacePattern, TilePattern};

use crate::assets::hex;
use crate::protocol::{
    CameraSnapshot, ImageLayerSnapshot, LightingSnapshot, MaterialMapsSnapshot, PartSnapshot, shape,
};

pub(crate) fn quaternion(rotation: Mat3) -> [f32; 4] {
    let q = Quat::from_mat3(&rotation).normalize();
    [q.x, q.y, q.z, q.w]
}

fn vec3(v: Vec3) -> [f32; 3] {
    [v.x, v.y, v.z]
}

fn shape_of(shape: DrawShape) -> (u8, Option<String>) {
    match shape {
        DrawShape::Part(PartShape::Block) => (shape::BLOCK, None),
        DrawShape::Part(PartShape::Ball) => (shape::BALL, None),
        DrawShape::Part(PartShape::Cylinder) => (shape::CYLINDER, None),
        DrawShape::Part(PartShape::Wedge) => (shape::WEDGE, None),
        DrawShape::Part(PartShape::CornerWedge) => (shape::CORNER_WEDGE, None),
        DrawShape::Head => (shape::HEAD, None),
        DrawShape::File(mesh) => (shape::FILE, Some(hex(&mesh.0))),
        DrawShape::Truss(_) => (shape::TRUSS, None),
        DrawShape::Adorn(_) => (shape::ADORN, None),
    }
}

fn pattern_of(pattern: Option<SurfacePattern>) -> u8 {
    match pattern {
        None => 255,
        Some(SurfacePattern::Studs) => 0,
        Some(SurfacePattern::Lattice) => 1,
        Some(SurfacePattern::Inlet) => 2,
        Some(SurfacePattern::Universal) => 3,
    }
}

fn tile_pattern(pattern: TilePattern) -> u8 {
    match pattern {
        TilePattern::Regular => 0,
        TilePattern::Organic => 1,
        TilePattern::Wang => 2,
    }
}

pub(crate) fn part_snapshot(
    id: u64,
    parent: Option<u64>,
    layer: u32,
    part: &PartInstance,
) -> PartSnapshot {
    let (shape, mesh) = shape_of(part.shape);
    let image = match part.layer {
        Layer::Base => None,
        Layer::Image {
            image,
            placement,
            z,
            on_transparent,
        } => Some(match placement {
            ImagePlacement::Face(face) => ImageLayerSnapshot {
                image: hex(&image.0),
                placement: crate::protocol::placement::FACE,
                face: face.index() as u8,
                studs_per_tile: [1.0; 2],
                offset: [0.0; 2],
                z,
                on_transparent,
            },
            ImagePlacement::Tiled(face, tiling) => ImageLayerSnapshot {
                image: hex(&image.0),
                placement: crate::protocol::placement::TILED,
                face: face.index() as u8,
                studs_per_tile: tiling.studs_per_tile.to_array(),
                offset: tiling.offset.to_array(),
                z,
                on_transparent,
            },
            ImagePlacement::MeshUv => ImageLayerSnapshot {
                image: hex(&image.0),
                placement: crate::protocol::placement::MESH_UV,
                face: 5,
                studs_per_tile: [1.0; 2],
                offset: [0.0; 2],
                z,
                on_transparent,
            },
        }),
    };
    PartSnapshot {
        id,
        parent,
        layer,
        shape,
        mesh,
        position: vec3(part.position),
        rotation: quaternion(part.rotation),
        size: vec3(part.size),
        color: part.color,
        transparency: part.transparency,
        material: u16::try_from(part.material.value()).unwrap_or(256),
        reflectance: part.reflectance,
        cast_shadow: part.cast_shadow,
        double_sided: part.double_sided,
        vertex_colors: part.vertex_colors,
        light: match part.light {
            Light::Lit => 0,
            Light::Unlit => 1,
            Light::Exact => 2,
        },
        on_top: part.on_top,
        over: part.over,
        texture: part.texture.map(|h| hex(&h.0)),
        maps: MaterialMapsSnapshot {
            color: part.maps.color.map(|h| hex(&h.0)),
            normal: part.maps.normal.map(|h| hex(&h.0)),
            roughness: part.maps.roughness.map(|h| hex(&h.0)),
            metalness: part.maps.metalness.map(|h| hex(&h.0)),
            detail_normal: part.maps.detail_normal.map(|h| hex(&h.0)),
            on_mesh_uv: part.maps.on_mesh_uv,
            studs_per_tile: part.maps.studs_per_tile.to_array(),
            pattern: tile_pattern(part.maps.pattern),
            seed: part.maps.seed,
            alpha: match part.maps.alpha {
                MapAlpha::Ignore => 0,
                MapAlpha::Overlay => 1,
                MapAlpha::Transparency => 2,
                MapAlpha::TintMask => 3,
            },
            tint: part.maps.tint,
        },
        image,
        surfaces: std::array::from_fn(|i| pattern_of(part.surfaces[i])),
    }
}

pub(crate) fn lighting_snapshot(lighting: &Lighting) -> LightingSnapshot {
    LightingSnapshot {
        sun_direction: vec3(lighting.sun_direction),
        ambient: lighting.ambient,
        outdoor_ambient: lighting.outdoor_ambient,
        sun_color: lighting.sun_color,
        fog_color: lighting.fog_color,
        fog_start: lighting.fog_start,
        fog_end: lighting.fog_end,
        sky_top: lighting.sky_top,
        sky_horizon: lighting.sky_horizon,
        sky_bottom: lighting.sky_bottom,
        sky_tint: lighting.sky_tint,
        skybox: lighting
            .skybox
            .map(|faces| std::array::from_fn(|i| hex(&faces[i].0))),
        global_shadows: lighting.global_shadows,
        prioritize_quality: lighting.prioritize_quality,
        environment_specular: lighting.environment_specular,
        environment_diffuse: lighting.environment_diffuse,
        exposure: lighting.exposure,
        tonemapper: match lighting.tonemapper {
            Tonemapper::Default => 0,
            Tonemapper::Retro => 1,
        },
    }
}

pub(crate) fn camera_snapshot(camera: &rook_render::Camera, scripted: bool) -> CameraSnapshot {
    CameraSnapshot {
        position: vec3(camera.position),
        rotation: quaternion(camera.rotation),
        fov: camera.fov_y,
        focus: vec3(camera.focus()),
        scripted,
    }
}

pub(crate) fn camera_view_snapshot(view: &CameraView) -> CameraSnapshot {
    CameraSnapshot {
        position: vec3(view.cframe.position),
        rotation: quaternion(view.cframe.rotation),
        fov: view.fov,
        focus: vec3(view.focus),
        scripted: true,
    }
}
