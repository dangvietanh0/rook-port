import "./style.css";
import * as THREE from "three";
import { GuiOverlay } from "./gui";
import { FlyCamera, World } from "./world";
import { PlayerCamera } from "./player-camera";
import { Net, type Status } from "./net";
import type { AnimationClip, ClientMessage, Vec3 } from "./protocol";

const canvas = document.getElementById("viewport") as HTMLCanvasElement;
const guiRoot = document.getElementById("gui") as HTMLDivElement;
const loading = document.getElementById("loading") as HTMLDivElement;
const placeLabel = document.getElementById("place") as HTMLSpanElement;
const partsLabel = document.getElementById("parts") as HTMLSpanElement;
const fpsLabel = document.getElementById("fps") as HTMLSpanElement;
const pingLabel = document.getElementById("ping") as HTMLSpanElement;
const statusLabel = document.getElementById("status") as HTMLDivElement;
const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const statsButton = document.getElementById("stats-button") as HTMLButtonElement;
const statsPanel = document.getElementById("stats-panel") as HTMLDivElement;
const resolution = document.getElementById("resolution") as HTMLInputElement;
const resolutionValue = document.getElementById("resolution-value") as HTMLSpanElement;
const resolutionAuto = document.getElementById("resolution-auto") as HTMLButtonElement;
const avatarButton = document.getElementById("avatar-button") as HTMLButtonElement;
const avatarPanel = document.getElementById("avatar-panel") as HTMLDivElement;
const avatarForm = document.getElementById("avatar-form") as HTMLFormElement;
const avatarUsername = document.getElementById("avatar-username") as HTMLInputElement;
const avatarSubmit = document.getElementById("avatar-submit") as HTMLButtonElement;
const avatarStatus = document.getElementById("avatar-status") as HTMLDivElement;
const fullscreenButton = document.getElementById("fullscreen-button") as HTMLButtonElement;
const joystick = document.getElementById("joystick") as HTMLDivElement;
const joystickThumb = document.getElementById("joystick-thumb") as HTMLDivElement;
const jump = document.getElementById("jump") as HTMLButtonElement;
const hint = document.getElementById("hint") as HTMLDivElement;
const toast = document.getElementById("toast") as HTMLDivElement;

const params = new URLSearchParams(window.location.search);
const touchCapable =
  params.get("touch") === "1" ||
  window.matchMedia("(pointer: coarse)").matches ||
  navigator.maxTouchPoints > 0;
if (touchCapable) document.body.classList.add("touch");

const world = new World(canvas);
const gui = new GuiOverlay(guiRoot);
let fly: FlyCamera | undefined;
let playerCamera: PlayerCamera | undefined;
/** Play mode with Rook's own controller: the browser drives the character. */
let playMode = false;
let statsOpen = false;
let avatarOpen = false;
let welcomed = false;
let lastCameraSent = 0;
// A welcome is the scene at its tick; deltas queued from before it must
// not move parts back.
let lastTick = -1;
let hadCharacter = false;
let lastHidden = false;
let lastPlayer = world.player;
let scriptedYaw = 0;
let placeText = "-";
let partsText = "0";
let pingMs: number | null = null;
let fps = 0;

const keys = new Set<string>();
let joyX = 0;
let joyY = 0;
let lastMove = { x: 0, z: 0 };
let lastMoveSent = 0;

const net = new Net(
  (welcome) => {
    world.applyWelcome(welcome);
    gui.apply(welcome.gui);
    lastTick = welcome.tick;
    playMode = welcome.play && welcome.controller;
    fly = new FlyCamera(world.camera);
    fly.setFromCamera(welcome.camera);
    playerCamera = playMode ? new PlayerCamera(world, world.camera) : undefined;
    hadCharacter = false;
    if (playMode && world.player?.root != null) {
      hadCharacter = true;
      playerCamera?.snap();
    }
    placeText = welcome.place;
    partsText = welcome.stats.parts.toLocaleString();
    updateStats();
    showTouchControls(playMode && touchCapable);
    updateHint();
    loading.classList.add("hidden");
    welcomed = true;
    // The GUI was laid out at the server's viewport; match it to this one.
    send({ kind: "resize", width: window.innerWidth, height: window.innerHeight });
  },
  (snapshot) => {
    if (snapshot.tick < lastTick) return;
    lastTick = snapshot.tick;
    world.applySnapshot(snapshot);
    if (snapshot.gui) gui.apply(snapshot.gui);
    partsText = snapshot.stats.parts.toLocaleString();
    if (snapshot.camera?.scripted) {
      scriptedYaw = yawOf(snapshot.camera.rotation);
    }
    if (playMode) {
      if (world.player?.root != null) {
        if (!hadCharacter) {
          hadCharacter = true;
          playerCamera?.snap();
        }
      } else {
        hadCharacter = false;
      }
    }
  },
  (status, detail) => setStatus(status, detail),
  (status) => {
    avatarStatus.className = status.state === "ready" ? "ok" : status.state === "error" ? "bad" : "warn";
    if (status.state === "loading") {
      avatarSubmit.disabled = true;
      avatarStatus.textContent = `Looking up ${status.username}…`;
    } else if (status.state === "ready") {
      avatarSubmit.disabled = false;
      avatarStatus.textContent = status.name
        ? `Wearing ${status.name}'s avatar.`
        : "Avatar ready.";
      if (status.animations?.length) world.setAvatarAnimations(status.animations);
    } else {
      avatarSubmit.disabled = false;
      avatarStatus.textContent = status.message ?? `Couldn't find ${status.username}.`;
    }
  },
  (t) => {
    pingMs = Math.max(0, Math.round(performance.now() - t));
  },
);

function yawOf(rotation: [number, number, number, number]): number {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
  );
  return Math.atan2(-forward.x, -forward.z);
}

function setStatus(status: Status, detail: string): void {
  statusLabel.className = status === "connected" ? "ok" : status === "failed" ? "bad" : "warn";
  statusLabel.textContent = detail;
  statusDot.className = status === "connected" ? "dot ok" : status === "failed" ? "dot bad" : "dot";
  // Before the first welcome the loading screen carries the message.
  toast.hidden = !welcomed || status === "connected";
  toast.textContent = status === "failed" ? detail : "Reconnecting…";
  updateStats();
}

function showTouchControls(show: boolean): void {
  joystick.hidden = !show;
  jump.hidden = !show;
}

function updateHint(): void {
  hint.textContent = playMode
    ? touchCapable
      ? "Drag to look · Joystick to move"
      : "Drag to look · WASD to move · Space to jump"
    : touchCapable
      ? "Drag to look"
      : "WASD/QE fly · drag to look · Shift fast";
}

function setStatsOpen(open: boolean): void {
  statsOpen = open;
  statsPanel.hidden = !open;
  statsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    setAvatarOpen(false);
    updateStats();
  }
}

function setAvatarOpen(open: boolean): void {
  avatarOpen = open;
  avatarPanel.hidden = !open;
  avatarButton.setAttribute("aria-expanded", String(open));
  if (open) {
    setStatsOpen(false);
    stopMoving();
    // Opening the panel stops the character; the field takes the keyboard.
    window.setTimeout(() => avatarUsername.focus(), 0);
  } else {
    avatarUsername.blur();
  }
}

function updateResolution(): void {
  const percent = world.renderScalePercent;
  resolution.max = String(world.maxRenderScale);
  resolution.value = String(percent);
  resolutionValue.textContent = `${percent}%`;
}

function updateStats(): void {
  if (!statsOpen) return;
  fpsLabel.textContent = fps > 0 ? String(Math.round(fps)) : "-";
  pingLabel.textContent = pingMs === null ? "-" : `${pingMs} ms`;
  placeLabel.textContent = placeText;
  partsLabel.textContent = partsText;
  updateResolution();
}

function dismissHint(): void {
  hint.classList.add("gone");
}

const special: Record<string, string> = {
  ShiftLeft: "LeftShift",
  ShiftRight: "RightShift",
  ControlLeft: "LeftControl",
  ControlRight: "RightControl",
  AltLeft: "LeftAlt",
  AltRight: "RightAlt",
  MetaLeft: "LeftSuper",
  MetaRight: "RightSuper",
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  Enter: "Return",
  NumpadEnter: "KeypadEnter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  CapsLock: "CapsLock",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Backslash: "BackSlash",
  BracketLeft: "LeftBracket",
  BracketRight: "RightBracket",
  Minus: "Minus",
  Equal: "Equals",
  Backquote: "Backquote",
  NumpadAdd: "KeypadPlus",
  NumpadSubtract: "KeypadMinus",
  NumpadMultiply: "KeypadMultiply",
  NumpadDivide: "KeypadDivide",
  NumpadDecimal: "KeypadPeriod",
  Numpad0: "KeypadZero",
  Numpad1: "KeypadOne",
  Numpad2: "KeypadTwo",
  Numpad3: "KeypadThree",
  Numpad4: "KeypadFour",
  Numpad5: "KeypadFive",
  Numpad6: "KeypadSix",
  Numpad7: "KeypadSeven",
  Numpad8: "KeypadEight",
  Numpad9: "KeypadNine",
};

const digits = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

function robloxCode(event: KeyboardEvent): string | undefined {
  if (special[event.code]) return special[event.code];
  if (event.code.startsWith("Key")) return event.code.slice(3);
  if (event.code.startsWith("Digit")) return digits[Number(event.code.slice(5))];
  if (/^F([1-9]|1[0-2])$/.test(event.code)) return event.code;
  return undefined;
}

function send(message: ClientMessage): void {
  net.send(message);
}

function sendCamera(): void {
  const now = performance.now();
  if (now - lastCameraSent < 250) return;
  lastCameraSent = now;
  const position: Vec3 = [world.camera.position.x, world.camera.position.y, world.camera.position.z];
  send({ kind: "camera", position });
}

function look(dx: number, dy: number): void {
  dismissHint();
  if (playMode && playerCamera && !world.cameraScripted) playerCamera.look(dx, dy);
  else fly?.look(dx, dy);
}

function movementYaw(): number {
  if (world.cameraScripted) return scriptedYaw;
  if (playMode && playerCamera) return playerCamera.yaw;
  return yawOf(world.camera.quaternion.toArray() as [number, number, number, number]);
}

function desiredMove(): { x: number; z: number } {
  let forward = 0;
  let right = 0;
  if (keys.has("W") || keys.has("Up")) forward += 1;
  if (keys.has("S") || keys.has("Down")) forward -= 1;
  if (keys.has("D") || keys.has("Right")) right += 1;
  if (keys.has("A") || keys.has("Left")) right -= 1;
  forward -= joyY;
  right += joyX;
  let length = Math.hypot(forward, right);
  if (length > 1) {
    forward /= length;
    right /= length;
    length = 1;
  }
  if (length < 0.12) return { x: 0, z: 0 };
  const yaw = movementYaw();
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return { x: fx * forward + rx * right, z: fz * forward + rz * right };
}

function updateMovement(now: number): void {
  const canMove = playMode && !avatarOpen && world.player?.root != null;
  const move = canMove ? desiredMove() : { x: 0, z: 0 };
  const moving = move.x !== 0 || move.z !== 0;
  const changed = Math.abs(move.x - lastMove.x) > 1e-4 || Math.abs(move.z - lastMove.z) > 1e-4;
  if (moving) {
    // Every drawn frame, capped at 60 Hz: the server is local, so the
    // shortest practical path is one send per tick.
    if (changed || now - lastMoveSent >= 16) {
      send({ kind: "move", x: move.x, z: move.z });
      lastMove = move;
      lastMoveSent = now;
    }
  } else if (lastMove.x !== 0 || lastMove.z !== 0) {
    send({ kind: "move", x: 0, z: 0 });
    lastMove = { x: 0, z: 0 };
    lastMoveSent = now;
  }
}

function stopMoving(): void {
  keys.clear();
  joyX = 0;
  joyY = 0;
  joystick.classList.remove("active");
  joystickThumb.style.transform = "";
  if (lastMove.x !== 0 || lastMove.z !== 0) {
    send({ kind: "move", x: 0, z: 0 });
    lastMove = { x: 0, z: 0 };
  }
}

function hideCharacter(hide: boolean): void {
  if (hide === lastHidden && (!hide || lastPlayer === world.player)) return;
  lastHidden = hide;
  lastPlayer = world.player;
  world.setHiddenParts(hide && world.player ? world.player.parts : []);
}

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    if (event.code === "Escape") setAvatarOpen(false);
    return;
  }
  if (avatarOpen) {
    if (event.code === "Escape") setAvatarOpen(false);
    return;
  }
  if (event.repeat) return;
  const code = robloxCode(event);
  if (!code) return;
  dismissHint();
  keys.add(code);
  if (code === "Escape" && document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
  if (statsOpen && code === "Escape") setStatsOpen(false);
  if (avatarOpen && code === "Escape") setAvatarOpen(false);
  fly?.key(code, true);
  send({ kind: "key", code, down: true });
  // Typing reaches a focused TextBox; with none focused the engine
  // ignores it.
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    send({ kind: "text", text: event.key });
  }
  if (["Space", "Up", "Down", "Left", "Right", "Tab"].includes(code)) event.preventDefault();
});

window.addEventListener("keyup", (event) => {
  const code = robloxCode(event);
  if (!code) return;
  keys.delete(code);
  fly?.key(code, false);
  send({ kind: "key", code, down: false });
});

window.addEventListener("blur", () => {
  stopMoving();
  send({ kind: "focus", focused: false });
});

window.addEventListener("focus", () => {
  send({ kind: "focus", focused: true });
});

window.addEventListener("pagehide", stopMoving);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopMoving();
  else send({ kind: "focus", focused: true });
});

// A click that stays put locks the pointer for camera look; a drag must
// not, or the release after every look-around would lock it.
let pressAt: { x: number; y: number } | null = null;
let dragging = false;
let dragAt = { x: 0, y: 0 };

canvas.addEventListener("mousedown", (event) => {
  const button = event.button === 1 ? 3 : event.button === 2 ? 2 : 1;
  send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
  send({ kind: "mouseButton", button, down: true });
  if (event.button === 0) pressAt = { x: event.clientX, y: event.clientY };
  if (event.button === 0 || event.button === 2) {
    dragging = true;
    dragAt = { x: event.clientX, y: event.clientY };
  }
});

window.addEventListener("mouseup", (event) => {
  const button = event.button === 1 ? 3 : event.button === 2 ? 2 : 1;
  send({ kind: "mouseButton", button, down: false });
  if (event.button === 0 || event.button === 2) dragging = false;
});

canvas.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement === canvas) return;
  send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
  if (!dragging) return;
  look(event.clientX - dragAt.x, event.clientY - dragAt.y);
  dragAt = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener("click", (event) => {
  const moved = pressAt
    ? Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y)
    : Infinity;
  pressAt = null;
  if (moved < 5 && document.pointerLockElement !== canvas) {
    void canvas.requestPointerLock();
  }
});

document.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== canvas) return;
  const dx = event.movementX;
  const dy = event.movementY;
  if (dx !== 0 || dy !== 0) {
    look(dx, dy);
    send({ kind: "mouseMotion", dx, dy });
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (playMode && playerCamera) playerCamera.wheel(event.deltaY);
    else fly?.wheel(event.deltaY);
    // Rook's wheel is in notches, up positive; browsers report pixels
    // down positive.
    send({ kind: "wheel", delta: -event.deltaY / 40 });
  },
  { passive: false },
);

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

// GUI elements sit above the canvas and take the pointer, so a click on
// one never locks the mouse. The click still goes to the engine, whose
// own layout decides what the object under it does.
guiRoot.addEventListener("mousedown", (event) => {
  const button = event.button === 1 ? 3 : event.button === 2 ? 2 : 1;
  send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
  send({ kind: "mouseButton", button, down: true });
});

guiRoot.addEventListener("mousemove", (event) => {
  send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
});

guiRoot.addEventListener("mouseup", (event) => {
  const button = event.button === 1 ? 3 : event.button === 2 ? 2 : 1;
  send({ kind: "mouseButton", button, down: false });
});

guiRoot.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    send({ kind: "wheel", delta: -event.deltaY / 40 });
  },
  { passive: false },
);

guiRoot.addEventListener("contextmenu", (event) => event.preventDefault());

// While the mouse is locked the pointer has no screen position, so park
// the engine's cursor off-screen: clicks go to the world, not to whatever
// GUI happened to be under it last.
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement === canvas) {
    send({ kind: "mouseMove", x: -1, y: -1 });
  }
});

// Touch look: one finger orbits, two pinch. A near-stationary touch also
// becomes a click so ClickDetectors and tools still work.
const touches = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number } | null = null;
let touchDragged = false;
let pinchSpan = 0;

function touchSpan(): number {
  const points = [...touches.values()];
  return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse") return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touches.size === 1) {
    dragStart = { x: event.clientX, y: event.clientY };
    touchDragged = false;
  } else if (touches.size === 2) {
    touchDragged = true;
    pinchSpan = touchSpan();
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse") return;
  const previous = touches.get(event.pointerId);
  if (!previous) return;
  const dx = event.clientX - previous.x;
  const dy = event.clientY - previous.y;
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (touches.size === 1) {
    if (dragStart && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 8) {
      touchDragged = true;
    }
    look(dx * 1.5, dy * 1.5);
  } else if (touches.size === 2) {
    const span = touchSpan();
    if (pinchSpan > 0 && span > 0) playerCamera?.pinch(span / pinchSpan);
    pinchSpan = span;
  }
});

function endTouch(event: PointerEvent, cancelled: boolean): void {
  if (!touches.has(event.pointerId)) return;
  const wasOne = touches.size === 1;
  touches.delete(event.pointerId);
  if (touches.size < 2) pinchSpan = 0;
  if (!wasOne || cancelled) return;
  const start = dragStart;
  dragStart = null;
  if (!touchDragged && start) {
    send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
    send({ kind: "mouseButton", button: 1, down: true });
    send({ kind: "mouseButton", button: 1, down: false });
  }
}

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerType === "mouse") return;
  endTouch(event, false);
});
canvas.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "mouse") return;
  endTouch(event, true);
});

// Joystick.
let joyPointer: number | null = null;
let joyRadius = 40;

function moveJoystick(event: PointerEvent): void {
  const rect = joystick.getBoundingClientRect();
  let dx = event.clientX - (rect.left + rect.width / 2);
  let dy = event.clientY - (rect.top + rect.height / 2);
  const length = Math.hypot(dx, dy);
  if (length > joyRadius) {
    dx = (dx / length) * joyRadius;
    dy = (dy / length) * joyRadius;
  }
  joystickThumb.style.transform = `translate(${dx}px, ${dy}px)`;
  joyX = dx / joyRadius;
  joyY = dy / joyRadius;
}

function resetJoystick(): void {
  joyPointer = null;
  joyX = 0;
  joyY = 0;
  joystick.classList.remove("active");
  joystickThumb.style.transform = "";
}

joystick.addEventListener("pointerdown", (event) => {
  if (joyPointer !== null) return;
  event.preventDefault();
  joyPointer = event.pointerId;
  joystick.setPointerCapture(event.pointerId);
  joystick.classList.add("active");
  joyRadius = joystick.getBoundingClientRect().width * 0.26;
  dismissHint();
  moveJoystick(event);
});

joystick.addEventListener("pointermove", (event) => {
  if (event.pointerId !== joyPointer) return;
  event.preventDefault();
  moveJoystick(event);
});

for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
  joystick.addEventListener(type, (event) => {
    if (event.pointerId !== joyPointer) return;
    resetJoystick();
  });
}

// Jump sends the same Space key the engine's controller listens for.
let jumpPointer: number | null = null;

jump.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (jumpPointer !== null) return;
  jumpPointer = event.pointerId;
  jump.setPointerCapture(event.pointerId);
  jump.classList.add("pressed");
  send({ kind: "key", code: "Space", down: true });
});

for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
  jump.addEventListener(type, (event) => {
    if (event.pointerId !== jumpPointer) return;
    jumpPointer = null;
    jump.classList.remove("pressed");
    send({ kind: "key", code: "Space", down: false });
  });
}

statsButton.addEventListener("click", () => setStatsOpen(!statsOpen));
avatarButton.addEventListener("click", () => setAvatarOpen(!avatarOpen));

resolution.max = String(world.maxRenderScale);
resolution.addEventListener("input", () => {
  world.setRenderScale(Number(resolution.value), false);
  updateResolution();
});
resolution.addEventListener("change", () => {
  world.setRenderScale(Number(resolution.value));
  updateResolution();
});
resolutionAuto.addEventListener("click", () => {
  world.setAutoResolution();
  updateResolution();
});

avatarForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = avatarUsername.value.trim();
  if (!username) return;
  avatarSubmit.disabled = true;
  avatarStatus.className = "warn";
  avatarStatus.textContent = `Looking up ${username}…`;
  send({ kind: "avatar", username });
  avatarUsername.blur();
});

document.addEventListener("pointerdown", (event) => {
  if (!statsOpen && !avatarOpen) return;
  const target = event.target as Node;
  if (statsOpen && !statsPanel.contains(target) && !statsButton.contains(target)) {
    setStatsOpen(false);
  }
  if (avatarOpen && !avatarPanel.contains(target) && !avatarButton.contains(target)) {
    setAvatarOpen(false);
  }
});

if (document.fullscreenEnabled) {
  fullscreenButton.hidden = false;
  fullscreenButton.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  });
  const syncFullscreen = () => {
    const active = document.fullscreenElement !== null;
    fullscreenButton.title = active ? "Exit fullscreen" : "Fullscreen";
    fullscreenButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Fullscreen");
  };
  document.addEventListener("fullscreenchange", syncFullscreen);
}

window.addEventListener("resize", () => {
  world.resize(window.innerWidth, window.innerHeight);
  send({ kind: "resize", width: window.innerWidth, height: window.innerHeight });
});

let previous = performance.now();
let frames = 0;
let shown = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - previous) / 1000, 0.1);
  previous = now;
  world.step(now);

  if (world.cameraScripted) {
    hideCharacter(false);
  } else if (playMode) {
    if (playerCamera && world.player?.root != null) {
      playerCamera.update(dt, now);
      hideCharacter(playerCamera.firstPerson);
    } else {
      hideCharacter(false);
    }
  } else if (fly) {
    hideCharacter(false);
    fly.update(dt);
    sendCamera();
  }

  updateMovement(now);
  world.render(now, dt);

  frames++;
  if (now - shown > 500) {
    fps = (frames * 1000) / (now - shown);
    frames = 0;
    shown = now;
    updateStats();
  }
  requestAnimationFrame(frame);
}

world.resize(window.innerWidth, window.innerHeight);
net.connect();
// The official R6 clips are static and large: fetch them once here so
// the default body animates before the player picks a username.
void fetch("/api/animations")
  .then((response) => (response.ok ? response.json() : []))
  .then((clips: unknown) => {
    if (Array.isArray(clips) && clips.length > 0) {
      world.setAvatarAnimations(clips as AnimationClip[]);
    }
  })
  .catch(() => {});
requestAnimationFrame(frame);

window.setInterval(() => {
  send({ kind: "ping", t: performance.now() });
}, 2000);

// The server sends the welcome as soon as the place is loaded; if the
// connection fails outright, say so instead of showing a spinner forever.
window.setTimeout(() => {
  if (!loading.classList.contains("hidden") && statusLabel.className !== "bad") {
    setStatus("connecting", "waiting for the session…");
  }
}, 8000);
