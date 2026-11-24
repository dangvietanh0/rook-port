//! The local player's ScreenGuis, drawn with HTML and CSS over the canvas
//! rather than in Three.js: Rook lays every object out in screen pixels and
//! the session sends the tree; this module builds the matching elements.
//!
//! The tree is rebuilt when the session says the GUI changed. Elements are
//! `pointer-events: none`: clicks go to the canvas and from there to the
//! engine, whose own layout decides what a GUI object does with them, so
//! the DOM never disagrees with the hit-testing.

import type { GuiNode } from "./protocol";

/// `Enum.Font` as a CSS stack, with the weight and style its legacy item
/// stands for (Rook reads the same table from Roblox's install).
const FONTS: Record<string, [string, number, string]> = {
  Legacy: [`Arial, Helvetica, sans-serif`, 400, "normal"],
  Arial: [`Arial, Helvetica, sans-serif`, 400, "normal"],
  ArialBold: [`Arial, Helvetica, sans-serif`, 700, "normal"],
  SourceSans: [`"Source Sans Pro", "Segoe UI", sans-serif`, 400, "normal"],
  SourceSansBold: [`"Source Sans Pro", "Segoe UI", sans-serif`, 700, "normal"],
  SourceSansLight: [`"Source Sans Pro", "Segoe UI", sans-serif`, 300, "normal"],
  SourceSansItalic: [`"Source Sans Pro", "Segoe UI", sans-serif`, 400, "italic"],
  SourceSansSemibold: [`"Source Sans Pro", "Segoe UI", sans-serif`, 600, "normal"],
  Bodoni: [`"Bodoni MT", Didot, serif`, 400, "normal"],
  Garamond: [`Garamond, "EB Garamond", serif`, 400, "normal"],
  Cartoon: [`"Comic Sans MS", "Comic Neue", cursive`, 400, "normal"],
  Code: [`Inconsolata, "Courier New", monospace`, 400, "normal"],
  Highway: [`"Highway Gothic", "Arial Narrow", sans-serif`, 400, "normal"],
  SciFi: [`Zekton, Orbitron, sans-serif`, 400, "normal"],
  Arcade: [`"Press Start 2P", monospace`, 400, "normal"],
  Fantasy: [`Balthazar, "Palatino Linotype", serif`, 400, "normal"],
  Antique: [`"Roman Antique", "Times New Roman", serif`, 400, "normal"],
  Gotham: [`Gotham, Montserrat, sans-serif`, 400, "normal"],
  GothamMedium: [`Gotham, Montserrat, sans-serif`, 500, "normal"],
  GothamBold: [`Gotham, Montserrat, sans-serif`, 700, "normal"],
  GothamBlack: [`Gotham, Montserrat, sans-serif`, 900, "normal"],
  AmaticSC: [`"Amatic SC", cursive`, 400, "normal"],
  Bangers: [`Bangers, cursive`, 400, "normal"],
  Creepster: [`Creepster, cursive`, 400, "normal"],
  DenkOne: [`"Denk One", sans-serif`, 400, "normal"],
  Fondamento: [`Fondamento, cursive`, 400, "normal"],
  FredokaOne: [`"Fredoka One", cursive`, 400, "normal"],
  GrenzeGotisch: [`"Grenze Gotisch", serif`, 400, "normal"],
  IndieFlower: [`"Indie Flower", cursive`, 400, "normal"],
  JosefinSans: [`"Josefin Sans", sans-serif`, 400, "normal"],
  Jura: [`Jura, sans-serif`, 400, "normal"],
  Kalam: [`Kalam, cursive`, 400, "normal"],
  LuckiestGuy: [`"Luckiest Guy", cursive`, 400, "normal"],
  Merriweather: [`Merriweather, serif`, 400, "normal"],
  Michroma: [`Michroma, sans-serif`, 400, "normal"],
  Nunito: [`Nunito, sans-serif`, 400, "normal"],
  Oswald: [`Oswald, sans-serif`, 400, "normal"],
  PatrickHand: [`"Patrick Hand", cursive`, 400, "normal"],
  PermanentMarker: [`"Permanent Marker", cursive`, 400, "normal"],
  Roboto: [`Roboto, sans-serif`, 400, "normal"],
  RobotoCondensed: [`"Roboto Condensed", sans-serif`, 400, "normal"],
  RobotoMono: [`"Roboto Mono", monospace`, 400, "normal"],
  Sarpanch: [`Sarpanch, sans-serif`, 400, "normal"],
  SpecialElite: [`"Special Elite", cursive`, 400, "normal"],
  TitilliumWeb: [`"Titillium Web", sans-serif`, 400, "normal"],
  Ubuntu: [`Ubuntu, sans-serif`, 400, "normal"],
  BuilderSans: [`"Builder Sans", "Segoe UI", sans-serif`, 400, "normal"],
  BuilderSansMedium: [`"Builder Sans", "Segoe UI", sans-serif`, 500, "normal"],
  BuilderSansBold: [`"Builder Sans", "Segoe UI", sans-serif`, 700, "normal"],
  BuilderSansExtraBold: [`"Builder Sans", "Segoe UI", sans-serif`, 800, "normal"],
  Arimo: [`Arimo, Arial, sans-serif`, 400, "normal"],
  ArimoBold: [`Arimo, Arial, sans-serif`, 700, "normal"],
};

const SCALE_TYPE = {
  STRETCH: 0,
  SLICE: 1,
  TILE: 2,
  FIT: 3,
  CROP: 4,
};

function rgba(color: number[], transparency: number): string {
  const [r, g, b] = color;
  const a = Math.max(0, Math.min(1, 1 - transparency));
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/// A colour's alpha with its own transparency and any inherited group
/// transparency (a CanvasGroup fades everything inside it).
function multiplied(transparency: number, inherited: number): number {
  return 1 - (1 - transparency) * (1 - inherited);
}

export class GuiOverlay {
  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /// Replace the overlay with `nodes` (one per ScreenGui, bottom first).
  apply(nodes: GuiNode[]): void {
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      if (node.visible) fragment.appendChild(this.element(node, 0));
    }
    this.root.replaceChildren(fragment);
  }

  clear(): void {
    this.root.replaceChildren();
  }

  private element(node: GuiNode, inheritedTransparency: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "gui-node";
    el.dataset.class = node.class;
    if (node.name) el.dataset.name = node.name;

    const style = el.style;
    style.left = `${node.position[0]}px`;
    style.top = `${node.position[1]}px`;
    style.width = `${Math.max(0, node.size[0])}px`;
    style.height = `${Math.max(0, node.size[1])}px`;
    style.zIndex = String(node.zIndex);
    if (node.rotation !== 0) style.transform = `rotate(${node.rotation}deg)`;
    if (node.clip) style.overflow = "hidden";

    const transparency = multiplied(node.backgroundTransparency, inheritedTransparency);
    if (transparency < 1 && node.class !== "ScreenGui") {
      style.background = rgba(node.backgroundColor, transparency);
    }
    // Only objects Rook would give a press take the pointer, which keeps a
    // click on one from locking the camera. An inactive Frame lets the
    // world through, and a ScreenGui is only a container.
    if (node.interactive || node.scrollable) style.pointerEvents = "auto";
    if (node.cornerRadius > 0) {
      style.borderRadius = `${node.cornerRadius}px`;
    }
    if (node.borderSize > 0 && node.borderTransparency < 1) {
      // An outline draws on the edge without taking layout space, like
      // Rook's default BorderMode (Outline); a CSS border would inset
      // absolutely positioned children by its width.
      style.outline = `${node.borderSize}px solid ${rgba(node.borderColor, node.borderTransparency)}`;
    }

    // A ScreenGui is a bare container; its children carry the look.
    if (node.class !== "ScreenGui") {
      if (node.image) this.image(el, node, inheritedTransparency);
      if (node.text !== null) this.text(el, node, inheritedTransparency);
    }

    // Roblox fades each object by its own transparency only; a Frame's
    // BackgroundTransparency does not fade its children (a CanvasGroup's
    // GroupTransparency does, which the session does not send yet).
    for (const child of node.children) {
      if (child.visible) el.appendChild(this.element(child, inheritedTransparency));
    }
    return el;
  }

  private text(el: HTMLElement, node: GuiNode, inheritedTransparency: number): void {
    const [family, weight, fontStyle] = FONTS[node.font] ?? FONTS.SourceSans;
    const color = rgba(node.textColor, multiplied(node.textTransparency, inheritedTransparency));
    const layer = document.createElement("div");
    layer.className = "gui-text";
    layer.textContent = node.text ?? "";
    const style = layer.style;
    style.fontFamily = family;
    style.fontWeight = String(weight);
    style.fontStyle = fontStyle;
    style.color = color;
    style.lineHeight = String(node.lineHeight || 1);
    style.whiteSpace = node.textWrapped ? "pre-wrap" : "pre";
    style.overflowWrap = node.textWrapped ? "break-word" : "normal";
    style.textAlign = ["left", "center", "right"][node.textXAlignment] ?? "center";
    style.justifyContent = ["flex-start", "center", "flex-end"][node.textXAlignment] ?? "center";
    style.alignItems = ["flex-start", "center", "flex-end"][node.textYAlignment] ?? "center";

    // TextScaled: fit the text to the box, as Rook's layout does with the
    // font's real metrics. A width estimate per glyph keeps it close.
    let size = node.textSize;
    if (node.textScaled) {
      const text = node.text ?? "";
      const lines = text.split("\n");
      const longest = Math.max(1, ...lines.map((line) => line.length));
      const byHeight = node.size[1] / (lines.length * (node.lineHeight || 1) * 1.2);
      const byWidth = (node.size[0] * 1.8) / longest;
      size = Math.max(1, Math.min(byHeight, byWidth));
    }
    style.fontSize = `${size}px`;

    if (node.textStroke) {
      const stroke = node.textStroke;
      const width = Math.max(1, Math.round(stroke.thickness));
      const c = rgba(stroke.color, stroke.transparency);
      const shadows: string[] = [];
      for (let dx = -width; dx <= width; dx += 1) {
        for (let dy = -width; dy <= width; dy += 1) {
          if (dx !== 0 || dy !== 0) shadows.push(`${dx}px ${dy}px 0 ${c}`);
        }
      }
      style.textShadow = shadows.join(", ");
    }

    el.appendChild(layer);
  }

  private image(el: HTMLElement, node: GuiNode, inheritedTransparency: number): void {
    const layer = document.createElement("div");
    layer.className = "gui-image";
    const style = layer.style;
    const transparency = multiplied(node.imageTransparency, inheritedTransparency);
    const url = `url(/api/image/${node.image})`;
    style.opacity = String(1 - transparency);

    // ScaleType and a sprite-sheet rectangle, in CSS background terms.
    const natural = node.imageNatural;
    const rect = node.imageRect;
    const [w, h] = node.size;
    const scale = node.imageScaleType;
    let size = "100% 100%";
    let position = "0 0";
    let repeat = "no-repeat";
    if (natural && rect) {
      const [rx, ry, rw, rh] = rect;
      if (scale === SCALE_TYPE.TILE) {
        size = `${rw}px ${rh}px`;
        position = `${-rx}px ${-ry}px`;
        repeat = "repeat";
      } else if (scale === SCALE_TYPE.FIT || scale === SCALE_TYPE.CROP) {
        const fit = scale === SCALE_TYPE.FIT ? Math.min : Math.max;
        const k = fit(w / rw, h / rh);
        size = `${natural[0] * k}px ${natural[1] * k}px`;
        position = `${(w - rw * k) / 2 - rx * k}px ${(h - rh * k) / 2 - ry * k}px`;
      } else {
        const kx = w / rw;
        const ky = h / rh;
        size = `${natural[0] * kx}px ${natural[1] * ky}px`;
        position = `${-rx * kx}px ${-ry * ky}px`;
      }
    } else if (scale === SCALE_TYPE.FIT) {
      size = "contain";
      position = "center";
    } else if (scale === SCALE_TYPE.CROP) {
      size = "cover";
      position = "center";
    } else if (scale === SCALE_TYPE.TILE) {
      size = "auto";
      repeat = "repeat";
    }

    // Roblox's ImageColor3 multiplies the image. A white tint (the
    // default) leaves it alone; any other colour draws the picture as a
    // mask over that colour, which is what tinted icons are.
    const [r, g, b] = node.imageColor;
    if (r > 0.99 && g > 0.99 && b > 0.99) {
      style.backgroundImage = url;
      style.backgroundSize = size;
      style.backgroundPosition = position;
      style.backgroundRepeat = repeat;
    } else {
      style.backgroundColor = rgba(node.imageColor, 0);
      style.maskImage = url;
      style.webkitMaskImage = url;
      style.maskSize = size;
      style.webkitMaskSize = size;
      style.maskPosition = position;
      style.webkitMaskPosition = position;
      style.maskRepeat = repeat;
      style.webkitMaskRepeat = repeat;
    }
    el.appendChild(layer);
  }
}
