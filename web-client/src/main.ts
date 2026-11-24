import "./style.css";
import { GuiOverlay } from "./gui";
import { FlyCamera, World } from "./world";
import { Net, type Status } from "./net";
import type { ClientMessage } from "./protocol";

const canvas = document.getElementById("viewport") as HTMLCanvasElement;
const guiRoot = document.getElementById("gui") as HTMLDivElement;
const loading = document.getElementById("loading") as HTMLDivElement;
const placeLabel = document.getElementById("place") as HTMLSpanElement;
const partsLabel = document.getElementById("parts") as HTMLSpanElement;
const fpsLabel = document.getElementById("fps") as HTMLSpanElement;
const pingLabel = document.getElementById("ping") as HTMLSpanElement;
const statusLabel = document.getElementById("status") as HTMLDivElement;

const world = new World(canvas);
const gui = new GuiOverlay(guiRoot);
let fly: FlyCamera | undefined;
let lastCameraSent = 0;
// A welcome is the scene at its tick; deltas queued from before it must
// not move parts back.
let lastTick = -1;

const net = new Net(
  (welcome) => {
    world.applyWelcome(welcome);
    gui.apply(welcome.gui);
    lastTick = welcome.tick;
    fly = new FlyCamera(world.camera);
    fly.setFromCamera(welcome.camera);
    placeLabel.textContent = welcome.place;
    partsLabel.textContent = welcome.stats.parts.toLocaleString();
    loading.classList.add("hidden");
    // The GUI was laid out at the server's viewport; match it to this one.
    send({ kind: "resize", width: window.innerWidth, height: window.innerHeight });
  },
  (snapshot) => {
    if (snapshot.tick < lastTick) return;
    lastTick = snapshot.tick;
    world.applySnapshot(snapshot);
    if (snapshot.gui) gui.apply(snapshot.gui);
    partsLabel.textContent = snapshot.stats.parts.toLocaleString();
  },
  (status, detail) => setStatus(status, detail),
  (t) => {
    pingLabel.textContent = `${Math.max(0, Math.round(performance.now() - t))} ms`;
  },
);

function setStatus(status: Status, detail: string): void {
  statusLabel.className = status === "connected" ? "ok" : status === "failed" ? "bad" : "warn";
  statusLabel.textContent = detail;
  statusLabel.title = detail;
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
  send({
    kind: "camera",
    position: [world.camera.position.x, world.camera.position.y, world.camera.position.z],
  });
}

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  const code = robloxCode(event);
  if (!code) return;
  if (code === "Escape" && document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
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
  fly?.key(code, false);
  send({ kind: "key", code, down: false });
});

window.addEventListener("blur", () => {
  send({ kind: "focus", focused: false });
});

window.addEventListener("focus", () => {
  send({ kind: "focus", focused: true });
});

// A click that stays put locks the pointer for camera look; a drag must
// not, or the release after every look-around would lock it.
let pressAt: { x: number; y: number } | null = null;

canvas.addEventListener("mousedown", (event) => {
  const button = event.button === 1 ? 3 : event.button === 2 ? 2 : 1;
  send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
  send({ kind: "mouseButton", button, down: true });
  if (event.button === 0) {
    pressAt = { x: event.clientX, y: event.clientY };
    if (document.pointerLockElement === canvas) return;
    fly?.beginDrag(event.clientX, event.clientY);
  }
});

window.addEventListener("mouseup", (event) => {
  const button = event.button === 1 ? 3 : event.button === 2 ? 2 : 1;
  send({ kind: "mouseButton", button, down: false });
  if (event.button === 0) fly?.endDrag();
});

canvas.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement === canvas) return;
  send({ kind: "mouseMove", x: event.clientX, y: event.clientY });
  fly?.drag(event.clientX, event.clientY);
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
    fly?.look(dx, dy);
    send({ kind: "mouseMotion", dx, dy });
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    fly?.wheel(event.deltaY);
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
  if (fly && !world.cameraScripted) {
    fly.update(dt);
    sendCamera();
  }
  world.update(now);
  frames++;
  if (now - shown > 500) {
    fpsLabel.textContent = Math.round((frames * 1000) / (now - shown)).toString();
    frames = 0;
    shown = now;
  }
  requestAnimationFrame(frame);
}

world.resize(window.innerWidth, window.innerHeight);
net.connect();
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
