//! The wire format shared with `apps/rook-web-server/src/protocol.rs`.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface MaterialMaps {
  color: string | null;
  normal: string | null;
  roughness: string | null;
  metalness: string | null;
  detailNormal: string | null;
  onMeshUv: boolean;
  studsPerTile: Vec2;
  pattern: number;
  seed: number;
  alpha: number;
  tint: Vec3;
}

export interface ImageLayer {
  image: string;
  placement: number;
  face: number;
  studsPerTile: Vec2;
  offset: Vec2;
  z: number;
  onTransparent: boolean;
}

export interface PartSnapshot {
  id: number;
  parent: number | null;
  layer: number;
  /** `BasePart.Anchored`; terrain is anchored, image layers are not. */
  anchored: boolean;
  shape: number;
  mesh: string | null;
  position: Vec3;
  rotation: Quat;
  size: Vec3;
  color: Vec3;
  transparency: number;
  material: number;
  reflectance: number;
  castShadow: boolean;
  doubleSided: boolean;
  vertexColors: boolean;
  light: number;
  onTop: boolean;
  over: boolean;
  texture: string | null;
  maps: MaterialMaps;
  image: ImageLayer | null;
  surfaces: number[];
}

export interface Lighting {
  sunDirection: Vec3;
  ambient: Vec3;
  outdoorAmbient: Vec3;
  sunColor: Vec3;
  fogColor: Vec3;
  fogStart: number;
  fogEnd: number;
  skyTop: Vec3;
  skyHorizon: Vec3;
  skyBottom: Vec3;
  skyTint: Vec3;
  skybox: string[] | null;
  globalShadows: boolean;
  prioritizeQuality: boolean;
  environmentSpecular: number;
  environmentDiffuse: number;
  exposure: number;
  tonemapper: number;
}

export interface LightSnapshot {
  position: Vec3;
  /** 0 point, 1 spot, 2 surface. */
  shape: number;
  direction: Vec3;
  /** The cone's full angle in degrees. */
  angle: number;
  color: Vec3;
  brightness: number;
  range: number;
}

export interface CameraSnapshot {
  position: Vec3;
  rotation: Quat;
  fov: number;
  focus: Vec3;
  scripted: boolean;
}

export interface TextStroke {
  color: Vec3;
  transparency: number;
  thickness: number;
}

export interface GuiNode {
  id: number;
  class: string;
  name: string;
  position: Vec2;
  size: Vec2;
  anchor: Vec2;
  rotation: number;
  visible: boolean;
  zIndex: number;
  backgroundColor: Vec3;
  backgroundTransparency: number;
  borderColor: Vec3;
  borderSize: number;
  borderTransparency: number;
  cornerRadius: number;
  text: string | null;
  textColor: Vec3;
  textSize: number;
  textTransparency: number;
  textScaled: boolean;
  textXAlignment: number;
  textYAlignment: number;
  textWrapped: boolean;
  richText: boolean;
  lineHeight: number;
  font: string;
  textStroke: TextStroke | null;
  image: string | null;
  imageNatural: [number, number] | null;
  imageRect: [number, number, number, number] | null;
  imageColor: Vec3;
  imageTransparency: number;
  imageScaleType: number;
  clip: boolean;
  scrollable: boolean;
  button: boolean;
  textBox: boolean;
  /** A press here is taken by the GUI (Active, a button or a TextBox). */
  interactive: boolean;
  placeholder: string | null;
  children: GuiNode[];
}

export interface SessionStats {
  parts: number;
  meshes: number;
  images: number;
  serverTick: number;
  simulatedSeconds: number;
}

export interface PlayerAvatar {
  name: string;
  userId: number;
  /** Role (`Torso`, `Left Arm`, …) and the net id of that part. */
  body: [string, number][];
  shirt: string | null;
  pants: string | null;
  /** The official R6 clips, present on the welcome and the panel's answer. */
  animations?: AnimationClip[];
}

export interface AnimationKey {
  time: number;
  /** Pose name and its joint transform, `[x, y, z, qx, qy, qz, qw]`. */
  poses: [string, [number, number, number, number, number, number, number]][];
}

export interface AnimationClip {
  name: string;
  length: number;
  keys: AnimationKey[];
}

export interface AvatarStatus {
  /** `loading`, `error` or `ready`. */
  state: string;
  username: string;
  name?: string;
  message?: string;
  animations?: AnimationClip[];
}

export interface PlayerInfo {
  /** Net id of the HumanoidRootPart. */
  root: number | null;
  /** Net id of the Head. */
  head: number | null;
  /** Every drawn character part, image layers included. */
  parts: number[];
  avatar?: PlayerAvatar;
}

export interface Welcome {
  place: string;
  tick: number;
  parts: PartSnapshot[];
  meshes: string[];
  images: string[];
  lighting: Lighting;
  /** Every PointLight, SpotLight and SurfaceLight in Workspace. */
  lights: LightSnapshot[];
  camera: CameraSnapshot;
  gui: GuiNode[];
  stats: SessionStats;
  player: PlayerInfo | null;
  /** This session has a local player at all; `--run` has none. */
  play: boolean;
  /** The injected movement controller is running. */
  controller: boolean;
}

export interface TransformUpdate {
  id: number;
  position: Vec3;
  rotation: Quat;
  size?: Vec3;
}

export interface Snapshot {
  tick: number;
  time: number;
  created: PartSnapshot[];
  updatedProps: PartSnapshot[];
  updatedTransforms: TransformUpdate[];
  destroyed: number[];
  meshes: string[];
  images: string[];
  lighting?: Lighting;
  lights?: LightSnapshot[];
  camera?: CameraSnapshot;
  gui?: GuiNode[] | null;
  player: PlayerInfo | null;
  stats: SessionStats;
}

export type ServerMessage =
  | { kind: "welcome"; welcome: Welcome }
  | { kind: "snapshot"; snapshot: Snapshot }
  | { kind: "avatar"; avatar: AvatarStatus }
  | { kind: "pong"; t: number }
  | { kind: "error"; message: string };

export type ClientMessage =
  | { kind: "key"; code: string; down: boolean }
  | { kind: "text"; text: string }
  | { kind: "mouseMove"; x: number; y: number }
  | { kind: "mouseMotion"; dx: number; dy: number }
  | { kind: "mouseButton"; button: number; down: boolean }
  | { kind: "wheel"; delta: number }
  | { kind: "focus"; focused: boolean }
  | { kind: "resize"; width: number; height: number }
  | { kind: "camera"; position: Vec3 }
  | { kind: "move"; x: number; z: number }
  | { kind: "avatar"; username: string }
  | { kind: "ping"; t: number };

export const SHAPE = {
  BLOCK: 0,
  BALL: 1,
  CYLINDER: 2,
  WEDGE: 3,
  CORNER_WEDGE: 4,
  HEAD: 5,
  FILE: 6,
  TRUSS: 7,
  ADORN: 8,
} as const;

export const PLACEMENT = {
  FACE: 0,
  TILED: 1,
  MESH_UV: 2,
} as const;

export const NORMAL_ID = {
  Right: 0,
  Top: 1,
  Back: 2,
  Left: 3,
  Bottom: 4,
  Front: 5,
} as const;
