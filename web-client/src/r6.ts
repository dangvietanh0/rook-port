//! The R6 animation player: the official clips' joint poses, sampled each
//! frame and composed into the six body parts' places.
//!
//! The clips are authored in each joint's own frame (the rotation its
//! Motor6D's C0 and C1 share). The server converts each pose into torso
//! space; here the rest offsets and pivots turn that into part transforms.

import * as THREE from "three";
import type { AnimationClip } from "./protocol";

export const R6_ROLES = ["Torso", "Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"] as const;

interface Joint {
  /** `T(pivot)`: where the joint turns, in torso space. */
  pivot: THREE.Matrix4;
  /** `T(rest − pivot)`: the part's centre back from the pivot. */
  back: THREE.Matrix4;
}

function joint(rest: [number, number, number], pivot: [number, number, number]): Joint {
  return {
    pivot: new THREE.Matrix4().makeTranslation(pivot[0], pivot[1], pivot[2]),
    back: new THREE.Matrix4().makeTranslation(
      rest[0] - pivot[0],
      rest[1] - pivot[1],
      rest[2] - pivot[2],
    ),
  };
}

const JOINTS: Record<string, Joint> = {
  Torso: joint([0, 0, 0], [0, 0, 0]),
  Head: joint([0, 1.5, 0], [0, 1, 0]),
  "Left Arm": joint([-1.5, 0, 0], [-1, 0.5, 0]),
  "Right Arm": joint([1.5, 0, 0], [1, 0.5, 0]),
  "Left Leg": joint([-0.5, -2, 0], [-1, -1, 0]),
  "Right Leg": joint([0.5, -2, 0], [1, -1, 0]),
};

interface Pose {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
}

const FADE = 0.16;
const WALK_SPEED = 16;
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
  private current = "idle";
  private time = 0;
  private previous: string | null = null;
  private previousTime = 0;
  private fade = 0;
  private last = new THREE.Vector3();
  private started = false;
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
  }

  setClips(clips: AnimationClip[]): void {
    this.clips.clear();
    for (const clip of clips) this.clips.set(clip.name, clip);
    this.current = "idle";
    this.time = 0;
    this.previous = null;
    this.fade = 0;
    this.started = false;
  }

  /** Sample this frame. Returns each role's transform relative to the
   * torso, or `null` when there are no clips to play. */
  update(dt: number, root: THREE.Vector3): Map<string, THREE.Matrix4> | null {
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
    const speed = dt > 0 ? Math.hypot(vx, vz) / dt : 0;
    const vertical = dt > 0 ? vy / dt : 0;
    let next = "idle";
    if (vertical > 2.5) next = "jump";
    else if (vertical < -2.5) next = "fall";
    else if (speed > 0.6) next = "walk";
    if (!this.clips.has(next)) next = "idle";

    if (next !== this.current) {
      this.previous = this.current;
      this.previousTime = this.time;
      this.fade = FADE;
      this.current = next;
      this.time = 0;
    }
    const clip = this.clips.get(this.current);
    if (!clip) return null;
    const length = lengthOf(clip);
    const loop = this.current === "walk" || this.current === "idle";
    const rate = this.current === "walk" ? Math.min(2, Math.max(0.6, speed / WALK_SPEED)) : 1;
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
      const frame = JOINTS[role];
      SCRATCH_MATRIX.compose(pose.position, pose.rotation, UNIT_SCALE);
      local.copy(frame.pivot).multiply(SCRATCH_MATRIX).multiply(frame.back);
    }
    return this.locals;
  }
}
