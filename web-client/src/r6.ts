//! The R6 animation player: the official clips' joint poses, sampled each
//! frame and composed into the six body parts' places.
//!
//! The clips are authored in each joint's own frame (the rotation its
//! Motor6D's C0 and C1 share). The server converts each pose into torso
//! space; here the rest offsets and pivots turn that into part transforms.
//!
//! Which clip plays comes from the root's velocity, not from differencing
//! snapshots: the browser renders at 90 or 120 Hz while positions arrive at
//! 60 Hz, so a per-frame delta alternates between zero and twice the real
//! speed and flips walk and idle on every other frame.

import * as THREE from "three";
import type { AnimationClip } from "./protocol";

export const R6_ROLES = ["Torso", "Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"] as const;

/** A joint's place in torso space. The animation turns the part around
 * `pivot`; `rest` is where its centre sits when every rotation is zero. */
export interface JointFrame {
  pivot: [number, number, number];
  rest: [number, number, number];
}

/** The standard R6 rig's joints, from Studio's measurements. */
export const R6_JOINTS: Record<string, JointFrame> = {
  Torso: { pivot: [0, 0, 0], rest: [0, 0, 0] },
  Head: { pivot: [0, 1, 0], rest: [0, 1.5, 0] },
  "Left Arm": { pivot: [-1, 0.5, 0], rest: [-1.5, 0, 0] },
  "Right Arm": { pivot: [1, 0.5, 0], rest: [1.5, 0, 0] },
  "Left Leg": { pivot: [-1, -1, 0], rest: [-0.5, -2, 0] },
  "Right Leg": { pivot: [1, -1, 0], rest: [0.5, -2, 0] },
};

interface Joint {
  /** `T(pivot)`: where the joint turns, in torso space. */
  pivot: THREE.Matrix4;
  /** `T(rest − pivot)`: the part's centre back from the pivot. */
  back: THREE.Matrix4;
}

function matrixJoint(frame: JointFrame): Joint {
  const [px, py, pz] = frame.pivot;
  const [rx, ry, rz] = frame.rest;
  return {
    pivot: new THREE.Matrix4().makeTranslation(px, py, pz),
    back: new THREE.Matrix4().makeTranslation(rx - px, ry - py, rz - pz),
  };
}

interface Pose {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
}

const FADE = 0.16;
const WALK_SPEED = 16;
/** How long a new state must be wanted before it plays, so one noisy
 * sample can't interrupt a walk or an idle. */
const DEBOUNCE = 0.08;
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_MATRIX = new THREE.Matrix4();

type WirePose = [number, number, number, number, number, number, number];

/** Fill `out` with `clip`'s pose at `time`, each role in torso space. */
function sample(clip: AnimationClip, time: number, out: Map<string, Pose>): void {
  const keys = clip.keys;
  let index = 0;
  while (index + 1 < keys.length && keys[index + 1].time <= time) index++;
  const first = keys[index];
  const second = keys[Math.min(index + 1, keys.length - 1)];
  const span = second.time - first.time;
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (time - first.time) / span)) : 0;
  for (const role of R6_ROLES) {
    const pose = out.get(role);
    if (!pose) continue;
    const a = first.poses.find(([name]) => name === role)?.[1];
    const b = second.poses.find(([name]) => name === role)?.[1];
    if (!a && !b) {
      pose.position.set(0, 0, 0);
      pose.rotation.identity();
      continue;
    }
    const from: WirePose = a ?? [0, 0, 0, 0, 0, 0, 1];
    const to: WirePose = b ?? from;
    pose.position.set(
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    );
    pose.rotation.set(from[3], from[4], from[5], from[6]);
    SCRATCH_QUAT.set(to[3], to[4], to[5], to[6]);
    pose.rotation.slerp(SCRATCH_QUAT, t);
  }
}

function lengthOf(clip: AnimationClip): number {
  if (clip.length > 0) return clip.length;
  return clip.keys.length > 0 ? clip.keys[clip.keys.length - 1].time : 0;
}

/** The R6 body's animation state: which clip is playing, how far into
 * it, and the blend from the one before. */
export class R6Animator {
  private clips = new Map<string, AnimationClip>();
  private joints = new Map<string, Joint>();
  private current = "idle";
  private time = 0;
  private previous: string | null = null;
  private previousTime = 0;
  private fade = 0;
  private candidate = "idle";
  private candidateTime = 0;
  private last = new THREE.Vector3();
  private started = false;
  private smoothSpeed = 0;
  private smoothVertical = 0;
  private lastRate = 1;
  private poses = new Map<string, Pose>();
  private previousPoses = new Map<string, Pose>();
  private locals = new Map<string, THREE.Matrix4>();

  constructor() {
    for (const role of R6_ROLES) {
      this.poses.set(role, { position: new THREE.Vector3(), rotation: new THREE.Quaternion() });
      this.previousPoses.set(role, {
        position: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
      });
      this.locals.set(role, new THREE.Matrix4());
    }
    this.setJoints();
  }

  /** Use joints read off a particular avatar's mesh. Missing roles keep
   * the standard R6 frame. */
  setJoints(frames?: Record<string, JointFrame>): void {
    this.joints.clear();
    for (const role of R6_ROLES) {
      this.joints.set(role, matrixJoint(frames?.[role] ?? R6_JOINTS[role]));
    }
  }

  setClips(clips: AnimationClip[]): void {
    this.clips.clear();
    for (const clip of clips) this.clips.set(clip.name, clip);
    this.current = "idle";
    this.time = 0;
    this.previous = null;
    this.fade = 0;
    this.started = false;
    this.candidate = "idle";
    this.candidateTime = 0;
    this.smoothSpeed = 0;
    this.smoothVertical = 0;
    this.lastRate = 1;
  }

  /** The clip being played, for tests and diagnostics. */
  get state(): string {
    return this.current;
  }

  /** How fast the walk clip runs relative to real time. */
  get rate(): number {
    return this.lastRate;
  }

  /** Pick a clip from the velocity. Walk and idle need different
   * thresholds so a speed hovering at the boundary can't flap. */
  private choose(speed: number, vertical: number): string {
    const walking = this.current === "walk" ? speed > 0.4 : speed > 1.1;
    if (this.current === "jump") return vertical < -1.5 ? "fall" : "jump";
    if (this.current === "fall") {
      if (vertical > 1.5) return "jump";
      if (Math.abs(vertical) <= 1.0) return walking ? "walk" : "idle";
      return "fall";
    }
    if (vertical > 2.5) return "jump";
    if (vertical < -2.5) return "fall";
    return walking ? "walk" : "idle";
  }

  /** Sample this frame. Returns each role's transform relative to the
   * torso, or `null` when there are no clips to play. */
  update(
    dt: number,
    root: THREE.Vector3,
    velocity?: [number, number, number],
  ): Map<string, THREE.Matrix4> | null {
    if (this.clips.size === 0) return null;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (!this.started) {
      this.last.copy(root);
      this.started = true;
    }
    const vx = root.x - this.last.x;
    const vy = root.y - this.last.y;
    const vz = root.z - this.last.z;
    this.last.copy(root);

    let speed: number;
    let vertical: number;
    if (velocity?.every(Number.isFinite)) {
      speed = Math.hypot(velocity[0], velocity[2]);
      vertical = velocity[1];
    } else {
      // Older servers send no velocity: smooth the snapshot deltas enough
      // that a 120 Hz render over 60 Hz positions doesn't alternate.
      const instantSpeed = dt > 0 ? Math.hypot(vx, vz) / dt : 0;
      const instantVertical = dt > 0 ? vy / dt : 0;
      const blend = dt > 0 ? Math.min(1, dt / 0.09) : 1;
      this.smoothSpeed += (instantSpeed - this.smoothSpeed) * blend;
      this.smoothVertical += (instantVertical - this.smoothVertical) * blend;
      speed = this.smoothSpeed;
      vertical = this.smoothVertical;
    }

    const next = this.choose(speed, vertical);
    if (next === this.candidate) this.candidateTime += dt;
    else {
      this.candidate = next;
      this.candidateTime = 0;
    }
    const urgent = next === "jump" || next === "fall";
    if (next !== this.current && (urgent || this.candidateTime >= DEBOUNCE)) {
      this.previous = this.current;
      this.previousTime = this.time;
      this.fade = FADE;
      this.current = next;
      this.time = 0;
      this.candidateTime = 0;
    }
    const clip = this.clips.get(this.current);
    if (!clip) return null;
    const length = lengthOf(clip);
    const loop = this.current === "walk" || this.current === "idle";
    const rate =
      this.current === "walk" ? Math.min(1.8, Math.max(0.7, speed / WALK_SPEED)) : 1;
    this.lastRate = rate;
    this.time += dt * rate;
    if (length > 0) {
      if (loop) this.time %= length;
      else this.time = Math.min(this.time, length);
    }

    sample(clip, this.time, this.poses);

    if (this.previous && this.fade > 0) {
      const before = this.clips.get(this.previous);
      if (before) {
        const beforeLength = lengthOf(before);
        this.previousTime += dt;
        if (beforeLength > 0) this.previousTime %= beforeLength;
        sample(before, this.previousTime, this.previousPoses);
        const weight = Math.min(1, Math.max(0, this.fade / FADE));
        for (const role of R6_ROLES) {
          const pose = this.poses.get(role)!;
          const old = this.previousPoses.get(role)!;
          pose.position.lerp(old.position, weight);
          pose.rotation.slerp(old.rotation, weight);
        }
      }
      this.fade -= dt;
      if (this.fade <= 0) this.previous = null;
    }

    for (const role of R6_ROLES) {
      const pose = this.poses.get(role)!;
      const local = this.locals.get(role)!;
      const frame = this.joints.get(role);
      if (!frame) continue;
      SCRATCH_MATRIX.compose(pose.position, pose.rotation, UNIT_SCALE);
      local.copy(frame.pivot).multiply(SCRATCH_MATRIX).multiply(frame.back);
    }
    return this.locals;
  }
}
