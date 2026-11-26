//! A regression check for the walk/idle flapping: the server sends 60
//! root updates a second while the browser may draw 120 frames, so a
//! state chosen from per-frame position deltas alternates between zero
//! and double speed. The animator must take the server's velocity and
//! still hold a state through noisy samples.
//!
//! Run with: node --experimental-strip-types test/r6-animation.test.ts

import * as THREE from "three";
import { R6Animator } from "../src/r6.ts";
import type { AnimationClip } from "../src/protocol.ts";

function clip(name: string, length: number): AnimationClip {
  const pose: [string, [number, number, number, number, number, number, number]] = [
    "Torso",
    [0, 0, 0, 0, 0, 0, 1],
  ];
  return {
    name,
    length,
    keys: [
      { time: 0, poses: [pose] },
      { time: length, poses: [pose] },
    ],
  };
}

function makeAnimator(): R6Animator {
  const animator = new R6Animator();
  animator.setClips([clip("idle", 1), clip("walk", 0.666667), clip("jump", 0.625), clip("fall", 0.65)]);
  return animator;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

/** Two seconds of 120 Hz frames over 60 Hz positions. */
function run(
  velocity: [number, number, number] | undefined,
  speed: number,
  frames = 240,
): { states: string[]; transitions: number } {
  const animator = makeAnimator();
  const root = new THREE.Vector3();
  const dt = 1 / 120;
  const states: string[] = [];
  let transitions = 0;
  let last = animator.state;
  for (let frame = 0; frame < frames; frame++) {
    // The root moves `speed` studs a second, but the snapshot only
    // arrives on every other frame.
    if (frame % 2 === 0) root.z -= speed / 60;
    animator.update(dt, root, velocity);
    if (animator.state !== last) {
      transitions++;
      last = animator.state;
      states.push(last);
    }
  }
  return { states, transitions };
}

// With the server's velocity the walk state must be chosen once and held.
const walking = run([0, 0, -8], 8);
assert(walking.transitions <= 1, `velocity walk holds state (transitions=${walking.transitions})`);
assert(walking.states.every((state) => state === "walk"), `velocity walk ends walking (${walking.states.join(" → ")})`);

// Without velocity (an older server), the smoothed fallback still must not
// flip on every other frame. A handful of transitions at the start is fine.
const fallback = run(undefined, 8);
assert(fallback.transitions <= 3, `fallback walk does not flap (transitions=${fallback.transitions})`);

// A standstill stays idle.
const idle = run([0, 0, 0], 0);
assert(idle.transitions === 0, `standstill stays idle (transitions=${idle.transitions})`);

// Jump and fall react immediately, then settle back.
{
  const animator = makeAnimator();
  const root = new THREE.Vector3();
  const dt = 1 / 120;
  animator.update(dt, root, [0, 10, 0]);
  assert(animator.state === "jump", `upward velocity jumps (state=${animator.state})`);
  animator.update(dt, root, [0, -10, 0]);
  assert(animator.state === "fall", `downward velocity falls (state=${animator.state})`);
  for (let frame = 0; frame < 30; frame++) animator.update(dt, root, [0, 0, 0]);
  assert(animator.state === "idle", `landing returns to idle (state=${animator.state})`);
}

console.log("r6 animation: all checks passed");
