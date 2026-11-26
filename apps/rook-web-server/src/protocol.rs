//! The wire format between the headless session and the browser.
//!
//! Every WebSocket frame is one MessagePack value. The browser never sees a
//! Rook type: these structs are the boundary, and names are camelCase so the
//! TypeScript client reads them without a mapping table.

use serde::{Deserialize, Serialize};

/// A part the browser draws.
///
/// `shape` is one of the [`shape`] constants. `mesh` names a file mesh to
/// fetch from `/api/mesh/{hash}`; `texture` and the material maps name images
/// to fetch from `/api/image/{hash}`. An image layer (`layer` 1) is a Decal
/// or Texture drawn over `parent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartSnapshot {
    pub(crate) id: u64,
    pub(crate) parent: Option<u64>,
    /// 0 for the part itself, 1.. for its image layers.
    pub(crate) layer: u32,
    /// `BasePart.Anchored` for a part; terrain is anchored and an image
    /// layer is not. The camera collision grid indexes anchored parts.
    pub(crate) anchored: bool,
    pub(crate) shape: u8,
    pub(crate) mesh: Option<String>,
    pub(crate) position: [f32; 3],
    /// Quaternion (x, y, z, w).
    pub(crate) rotation: [f32; 4],
    pub(crate) size: [f32; 3],
    pub(crate) color: [f32; 3],
    pub(crate) transparency: f32,
    /// `Enum.Material`'s value (see the client's material table).
    pub(crate) material: u16,
    pub(crate) reflectance: f32,
    pub(crate) cast_shadow: bool,
    pub(crate) double_sided: bool,
    pub(crate) vertex_colors: bool,
    pub(crate) light: u8,
    pub(crate) on_top: bool,
    pub(crate) over: bool,
    pub(crate) texture: Option<String>,
    pub(crate) maps: MaterialMapsSnapshot,
    pub(crate) image: Option<ImageLayerSnapshot>,
    /// Surface patterns by face (`NormalId` order): 0 studs, 1 lattice,
    /// 2 inlet, 3 universal, 255 none.
    pub(crate) surfaces: [u8; 6],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialMapsSnapshot {
    pub(crate) color: Option<String>,
    pub(crate) normal: Option<String>,
    pub(crate) roughness: Option<String>,
    pub(crate) metalness: Option<String>,
    pub(crate) detail_normal: Option<String>,
    pub(crate) on_mesh_uv: bool,
    pub(crate) studs_per_tile: [f32; 2],
    pub(crate) pattern: u8,
    pub(crate) seed: u64,
    pub(crate) alpha: u8,
    pub(crate) tint: [f32; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageLayerSnapshot {
    pub(crate) image: String,
    /// 0 face, 1 tiled, 2 mesh UV.
    pub(crate) placement: u8,
    /// `NormalId` for face and tiled placements.
    pub(crate) face: u8,
    pub(crate) studs_per_tile: [f32; 2],
    pub(crate) offset: [f32; 2],
    pub(crate) z: i32,
    pub(crate) on_transparent: bool,
}

pub(crate) mod shape {
    pub(crate) const BLOCK: u8 = 0;
    pub(crate) const BALL: u8 = 1;
    pub(crate) const CYLINDER: u8 = 2;
    pub(crate) const WEDGE: u8 = 3;
    pub(crate) const CORNER_WEDGE: u8 = 4;
    pub(crate) const HEAD: u8 = 5;
    pub(crate) const FILE: u8 = 6;
    pub(crate) const TRUSS: u8 = 7;
    pub(crate) const ADORN: u8 = 8;
}

pub(crate) mod placement {
    pub(crate) const FACE: u8 = 0;
    pub(crate) const TILED: u8 = 1;
    pub(crate) const MESH_UV: u8 = 2;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransformUpdate {
    pub(crate) id: u64,
    pub(crate) position: [f32; 3],
    pub(crate) rotation: [f32; 4],
    /// Sent only when the drawn size changed too (a resize is a prop
    /// change logically, but it arrives with motion often enough to keep
    /// here).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) size: Option<[f32; 3]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LightingSnapshot {
    pub(crate) sun_direction: [f32; 3],
    pub(crate) ambient: [f32; 3],
    pub(crate) outdoor_ambient: [f32; 3],
    pub(crate) sun_color: [f32; 3],
    pub(crate) fog_color: [f32; 3],
    pub(crate) fog_start: f32,
    pub(crate) fog_end: f32,
    pub(crate) sky_top: [f32; 3],
    pub(crate) sky_horizon: [f32; 3],
    pub(crate) sky_bottom: [f32; 3],
    pub(crate) sky_tint: [f32; 3],
    pub(crate) skybox: Option<[String; 6]>,
    pub(crate) global_shadows: bool,
    pub(crate) prioritize_quality: bool,
    pub(crate) environment_specular: f32,
    pub(crate) environment_diffuse: f32,
    pub(crate) exposure: f32,
    /// 0 Rook's default (Studio's), 1 retro (sqrt).
    pub(crate) tonemapper: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LightSnapshot {
    pub(crate) position: [f32; 3],
    /// 0 point, 1 spot, 2 surface.
    pub(crate) shape: u8,
    /// The direction a spot or surface light shines, unit length.
    pub(crate) direction: [f32; 3],
    /// The cone's full angle in degrees (`SpotLight.Angle`).
    pub(crate) angle: f32,
    pub(crate) color: [f32; 3],
    pub(crate) brightness: f32,
    pub(crate) range: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CameraSnapshot {
    pub(crate) position: [f32; 3],
    pub(crate) rotation: [f32; 4],
    pub(crate) fov: f32,
    pub(crate) focus: [f32; 3],
    /// Whether the game's scripts drive the camera (third person or a
    /// custom camera) rather than the browser's free camera.
    pub(crate) scripted: bool,
}

/// The local player's character as the browser needs it: what to follow
/// and what to hide in first person.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayerInfo {
    /// Net id of the `HumanoidRootPart`.
    pub(crate) root: Option<u64>,
    /// Net id of the `Head`.
    pub(crate) head: Option<u64>,
    /// Net ids of every drawn character part, image layers included.
    pub(crate) parts: Vec<u64>,
    /// The root's linear velocity, so the browser picks walk, jump and
    /// fall from the simulation rather than differentiating snapshots.
    pub(crate) velocity: [f32; 3],
    /// The standard R6 look the player chose, when they chose one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) avatar: Option<PlayerAvatar>,
}

/// A chosen Roblox avatar: the six R6 body parts by role, and the classic
/// shirt and pants the browser composites over their body colours.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayerAvatar {
    pub(crate) name: String,
    pub(crate) user_id: i64,
    /// The rig the 3D thumbnail was rendered with: `R6` or `R15`. R6 models
    /// use the standard joints; R15 models need joints read off the mesh.
    #[serde(default)]
    pub(crate) rig: String,
    /// Role (`Torso`, `Left Arm`, …) and the net id of that part.
    pub(crate) body: Vec<(String, u64)>,
    pub(crate) shirt: Option<String>,
    pub(crate) pants: Option<String>,
    /// Roblox's 3D avatar mesh, when it could be fetched.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) model: Option<AvatarModelInfo>,
    /// The official R6 clips, sent with the welcome and the panel's
    /// answer, never with every snapshot.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) animations: Option<Vec<AnimationClip>>,
}

/// Where the browser gets the avatar's OBJ, MTL and textures.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvatarModelInfo {
    pub(crate) obj: String,
    pub(crate) mtl: String,
}

/// One R6 animation: its length and the poses at each keyframe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnimationClip {
    pub(crate) name: String,
    pub(crate) length: f32,
    pub(crate) keys: Vec<AnimationKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnimationKey {
    pub(crate) time: f32,
    /// Pose name and its joint transform in torso space, as
    /// `[x, y, z, qx, qy, qz, qw]`.
    pub(crate) poses: Vec<(String, [f32; 7])>,
}

/// How the avatar panel's request is going.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvatarStatus {
    /// `loading`, `error` or `ready`.
    pub(crate) state: String,
    pub(crate) username: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) animations: Option<Vec<AnimationClip>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Welcome {
    pub(crate) place: String,
    pub(crate) tick: u64,
    pub(crate) parts: Vec<PartSnapshot>,
    pub(crate) meshes: Vec<String>,
    pub(crate) images: Vec<String>,
    pub(crate) lighting: LightingSnapshot,
    /// Every PointLight, SpotLight and SurfaceLight in Workspace.
    pub(crate) lights: Vec<LightSnapshot>,
    pub(crate) camera: CameraSnapshot,
    pub(crate) gui: Vec<GuiNode>,
    pub(crate) stats: SessionStats,
    pub(crate) player: Option<PlayerInfo>,
    /// Whether this session has a local player at all (`--run` has none).
    pub(crate) play: bool,
    /// Whether the injected movement controller is running. A place with
    /// its own `PlayerModule`, `ControlScript` or `CameraScript` keeps it,
    /// and the browser stays a spectator.
    pub(crate) controller: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionStats {
    pub(crate) parts: usize,
    pub(crate) meshes: usize,
    pub(crate) images: usize,
    pub(crate) server_tick: u64,
    pub(crate) simulated_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) tick: u64,
    pub(crate) time: f64,
    pub(crate) created: Vec<PartSnapshot>,
    pub(crate) updated_props: Vec<PartSnapshot>,
    pub(crate) updated_transforms: Vec<TransformUpdate>,
    pub(crate) destroyed: Vec<u64>,
    /// Hashes the browser hasn't been told about yet.
    pub(crate) meshes: Vec<String>,
    pub(crate) images: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) lighting: Option<LightingSnapshot>,
    /// The local lights, when any changed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) lights: Option<Vec<LightSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) camera: Option<CameraSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) gui: Option<Vec<GuiNode>>,
    /// The local character, or none while it is spawning or dead.
    pub(crate) player: Option<PlayerInfo>,
    pub(crate) stats: SessionStats,
}

/// One GUI object, already laid out in screen pixels by `rook-gui`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiNode {
    pub(crate) id: u64,
    pub(crate) class: String,
    pub(crate) name: String,
    pub(crate) position: [f32; 2],
    pub(crate) size: [f32; 2],
    pub(crate) anchor: [f32; 2],
    pub(crate) rotation: f32,
    pub(crate) visible: bool,
    pub(crate) z_index: i32,
    pub(crate) background_color: [f32; 3],
    pub(crate) background_transparency: f32,
    pub(crate) border_color: [f32; 3],
    pub(crate) border_size: f32,
    pub(crate) border_transparency: f32,
    pub(crate) corner_radius: f32,
    pub(crate) text: Option<String>,
    pub(crate) text_color: [f32; 3],
    pub(crate) text_size: f32,
    pub(crate) text_transparency: f32,
    pub(crate) text_scaled: bool,
    pub(crate) text_x_alignment: u8,
    pub(crate) text_y_alignment: u8,
    pub(crate) text_wrapped: bool,
    pub(crate) rich_text: bool,
    pub(crate) line_height: f32,
    pub(crate) font: String,
    pub(crate) text_stroke: Option<TextStroke>,
    pub(crate) image: Option<String>,
    /// The image's size in pixels, for `ScaleType` Fit and Crop.
    pub(crate) image_natural: Option<[u32; 2]>,
    /// The sub-rectangle of the image to show (offset x, y, size w, h).
    pub(crate) image_rect: Option<[f32; 4]>,
    pub(crate) image_color: [f32; 3],
    pub(crate) image_transparency: f32,
    pub(crate) image_scale_type: u8,
    pub(crate) clip: bool,
    pub(crate) scrollable: bool,
    pub(crate) button: bool,
    pub(crate) text_box: bool,
    /// Whether a press here would be taken by the GUI (an `Active` object,
    /// a button or a TextBox), so the browser knows not to lock the mouse
    /// for the camera.
    pub(crate) interactive: bool,
    pub(crate) placeholder: Option<String>,
    pub(crate) children: Vec<GuiNode>,
}

/// `Enum.ScaleType` as the client's constants.
pub(crate) mod scale_type {
    pub(crate) const STRETCH: u8 = 0;
    pub(crate) const SLICE: u8 = 1;
    pub(crate) const TILE: u8 = 2;
    pub(crate) const FIT: u8 = 3;
    pub(crate) const CROP: u8 = 4;
}

/// `TextXAlignment` and `TextYAlignment`.
pub(crate) mod align {
    pub(crate) const START: u8 = 0;
    pub(crate) const CENTER: u8 = 1;
    pub(crate) const END: u8 = 2;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextStroke {
    pub(crate) color: [f32; 3],
    pub(crate) transparency: f32,
    pub(crate) thickness: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ServerMessage {
    Welcome { welcome: Welcome },
    Snapshot { snapshot: Snapshot },
    Avatar { avatar: AvatarStatus },
    Pong { t: f64 },
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ClientMessage {
    Key {
        code: String,
        down: bool,
    },
    Text {
        text: String,
    },
    MouseMove {
        x: f32,
        y: f32,
    },
    MouseMotion {
        dx: f32,
        dy: f32,
    },
    MouseButton {
        button: u8,
        down: bool,
    },
    Wheel {
        delta: f32,
    },
    Focus {
        focused: bool,
    },
    Resize {
        width: u32,
        height: u32,
    },
    /// Where the browser's camera is, so terrain and content grow around
    /// it as the player flies.
    Camera {
        position: [f32; 3],
    },
    /// A world-space horizontal walk direction, at most 1 long. The browser
    /// sends it at 30 Hz while the player holds a direction and once as
    /// zero when they stop.
    Move {
        x: f32,
        z: f32,
    },
    /// The player typed a Roblox username in the avatar panel.
    Avatar {
        username: String,
    },
    Ping {
        t: f64,
    },
}
