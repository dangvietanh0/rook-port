//! Third-person orbit camera that follows the local character, with a
//! smooth zoom into first person.

import * as THREE from "three";
import type { World } from "./world";

const MIN_DISTANCE = 0.5;
const MAX_DISTANCE = 32;
const START_DISTANCE = 12.5;
/** Below this the character is hidden and the camera sits at the head;
 * above the wider threshold it comes back, so the edge doesn't flicker. */
const FIRST_PERSON_ENTER = 1.4;
const FIRST_PERSON_EXIT = 1.8;
const LOOK_SENSITIVITY = 0.0032;
const ZOOM_RATE = 12;
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);

export class PlayerCamera {
  private readonly target = new THREE.Vector3();
  private targetYaw = 0;
  private targetPitch = -0.12;
  private targetDistance = START_DISTANCE;
  private distance = START_DISTANCE;
  private hasTarget = false;
  private first = false;

  constructor(
    private readonly world: World,
    private readonly camera: THREE.PerspectiveCamera,
  ) {}

  get yaw(): number {
    return this.targetYaw;
  }

  get firstPerson(): boolean {
    return this.first;
  }

  /** Start from the character's own facing, as Roblox's camera does when a
   * character appears. */
  snap(): void {
    this.hasTarget = false;
    this.first = false;
    const root = this.world.player?.root;
    const pose = root !== null && root !== undefined ? this.world.partTransform(root, performance.now()) : undefined;
    if (!pose) return;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    this.targetYaw = Math.atan2(-forward.x, -forward.z);
  }

  look(dx: number, dy: number): void {
    this.targetYaw -= dx * LOOK_SENSITIVITY;
    this.targetPitch -= dy * LOOK_SENSITIVITY;
    this.targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.targetPitch));
  }

  /** Wheel pixels, down positive. */
  wheel(delta: number): void {
    this.zoom(Math.exp(delta * 0.0018));
  }

  /** Pinch scale: fingers apart (greater than 1) zoom in, as on Roblox. */
  pinch(scale: number): void {
    if (scale > 0) this.zoom(1 / scale);
  }

  private zoom(scale: number): void {
    this.targetDistance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.targetDistance * scale));
  }

  update(dt: number, now: number): void {
    const player = this.world.player;
    if (!player) return;
    const pose =
      (player.head !== null ? this.world.partTransform(player.head, now) : undefined) ??
      (player.root !== null ? this.world.partTransform(player.root, now) : undefined);
    if (!pose) return;
    const target = pose.position.clone();
    if (player.head === null) target.y += 1.5;

    // The local character is already drawn from the newest authoritative
    // transform, so the camera sits on it at once; smoothing here would
    // put the view behind the player again.
    this.target.copy(target);
    this.hasTarget = true;

    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * ZOOM_RATE));
    const offset = new THREE.Vector3(
      Math.sin(this.targetYaw) * Math.cos(this.targetPitch),
      -Math.sin(this.targetPitch),
      Math.cos(this.targetYaw) * Math.cos(this.targetPitch),
    );
    let distance = this.distance;
    if (this.world.collisionEnabled) {
      const hit = this.world.collisionRay(this.target, this.target.clone().addScaledVector(offset, distance));
      if (hit !== null) distance = Math.max(0.3, Math.min(distance, hit - 0.25));
    }
    this.first = this.first ? distance < FIRST_PERSON_EXIT : distance < FIRST_PERSON_ENTER;
    if (this.first) {
      this.camera.position.copy(this.target);
    } else {
      this.camera.position.copy(this.target).addScaledVector(offset, distance);
    }
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.targetPitch, this.targetYaw, 0, "YXZ"));
  }
}
