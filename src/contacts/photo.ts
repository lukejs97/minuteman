// Contacts' photos: any picture made into the small square JPEG Google keeps,
// as it comes (the middle of it) or as you frame it (Adjust photo: move,
// zoom and turn it inside the circle). iPhone photos (HEIC) open where the
// browser can open them (Safari); where it can't (Chrome, Edge, the Windows
// app) a HEIC decoder is loaded, only then, as it's large.
import { el } from "../dom";

/** The side of a contact's photo, in pixels: a square, as Google shows it. */
export const PHOTO_SIZE = 512;

export type Picture = ImageBitmap | HTMLImageElement;

/** `file` opened as a picture, whatever the browser can open, and HEIC anywhere. */
export async function openPicture(file: Blob): Promise<Picture> {
  try {
    // Turned the way the camera held it (an older browser that doesn't know the option uses the <img> below, which does).
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Not every browser makes bitmaps of every kind of picture.
  }
  try {
    return await viaImage(file);
  } catch {
    // Not a kind it can show: HEIC, perhaps.
  }
  const { heicTo, isHeic } = await import("heic-to/csp");
  const named = file instanceof File ? file : new File([file], "photo", { type: file.type });
  if (!(await isHeic(named))) throw new Error("not a picture this can open");
  return heicTo({ blob: named, type: "bitmap" });
}

/** An <img> of `file`, once it has loaded (not `decode()`, which some browsers turn down for big photos). */
function viaImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error("empty picture")));
    img.onerror = () => reject(new Error("not a picture"));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** `file` as a square photo (the middle of it), at most PHOTO_SIZE across, as base64 JPEG. */
export async function squarePhoto(file: Blob): Promise<string> {
  const picture = await openPicture(file);
  const width = picture instanceof HTMLImageElement ? picture.naturalWidth : picture.width;
  const height = picture instanceof HTMLImageElement ? picture.naturalHeight : picture.height;
  const side = Math.min(width, height);
  if (!side) throw new Error("no picture");
  const size = Math.min(PHOTO_SIZE, side);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.drawImage(picture, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  if ("close" in picture) picture.close();
  return canvas.toDataURL("image/jpeg", 0.88).split(",")[1];
}

const sizeOf = (picture: Picture) =>
  picture instanceof HTMLImageElement
    ? { width: picture.naturalWidth, height: picture.naturalHeight }
    : { width: picture.width, height: picture.height };

/** Where the picture sits in the square: zoom (1 = just fills it), its middle, and a quarter turn or more. */
interface Frame {
  zoom: number;
  /** The point of the turned picture at the square's middle, in its pixels. */
  x: number;
  y: number;
  /** Quarter turns clockwise, 0–3. */
  turns: number;
}

/** The turned picture's size. */
function turned(picture: Picture, turns: number) {
  const { width, height } = sizeOf(picture);
  return turns % 2 ? { width: height, height: width } : { width, height };
}

/** Pixels on screen for each of the picture's at `zoom`, in a square `side` across. */
const scaleFor = (picture: Picture, frame: Frame, side: number) => {
  const { width, height } = turned(picture, frame.turns);
  return (side / Math.min(width, height)) * frame.zoom;
};

/** Keeps the picture covering the whole square. */
function clamp(picture: Picture, frame: Frame, side: number): void {
  const { width, height } = turned(picture, frame.turns);
  const half = side / 2 / scaleFor(picture, frame, side);
  frame.x = Math.min(Math.max(frame.x, half), width - half);
  frame.y = Math.min(Math.max(frame.y, half), height - half);
}

/** Draws the picture framed by `frame` into a square canvas. */
function draw(context: CanvasRenderingContext2D, picture: Picture, frame: Frame, side: number): void {
  const { width, height } = sizeOf(picture);
  const turnedSize = turned(picture, frame.turns);
  context.save();
  context.fillStyle = "#fff"; // a see-through PNG on white, as a JPEG can't be see-through
  context.fillRect(0, 0, side, side);
  context.translate(side / 2, side / 2);
  const scale = scaleFor(picture, frame, side);
  context.scale(scale, scale);
  context.translate(-frame.x, -frame.y);
  context.translate(turnedSize.width / 2, turnedSize.height / 2);
  context.rotate((frame.turns * Math.PI) / 2);
  context.imageSmoothingQuality = "high";
  context.drawImage(picture, -width / 2, -height / 2);
  context.restore();
}

/** The framed square as base64 JPEG, at most PHOTO_SIZE across (no bigger than the picture has pixels for). */
function framedPhoto(picture: Picture, frame: Frame): string {
  const { width, height } = turned(picture, frame.turns);
  const shown = Math.min(width, height) / frame.zoom; // the picture's pixels across the square
  const size = Math.max(1, Math.min(PHOTO_SIZE, Math.round(shown)));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d")!, picture, frame, size);
  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
}

/** Most zoom: until about 64 of the picture's pixels fill the square. */
const maxZoom = (picture: Picture) => {
  const { width, height } = sizeOf(picture);
  return Math.max(1, Math.min(8, Math.min(width, height) / 64));
};

/**
 * Adjust photo: the picture in a circle (as contacts' photos are shown), to
 * drag into place, zoom (pinch, scroll, the slider, + and −) and turn.
 * Resolves to the square as base64 JPEG, or null if cancelled.
 */
export async function cropPhoto(file: Blob): Promise<string | null> {
  const picture = await openPicture(file);
  return new Promise((resolve) => {
    const dialog = el("dialog", "dialog crop-dialog");
    dialog.setAttribute("aria-labelledby", "crop-title");
    document.body.append(dialog);
    let result: string | null = null;
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    const title = el("h2", undefined, "Adjust photo");
    title.id = "crop-title";

    const stage = el("div", "crop-stage");
    const canvas = el("canvas", "crop-canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "The photo: drag to move it, or use the arrow keys; + and − zoom");
    stage.append(canvas, el("div", "crop-ring"));
    const context = canvas.getContext("2d")!;

    const start = turned(picture, 0);
    const frame: Frame = { zoom: 1, x: start.width / 2, y: start.height / 2, turns: 0 };
    /** The canvas's side in its own pixels (sharp on Retina screens). */
    let side = 1;
    const render = () => {
      const cssSide = stage.clientWidth || 280;
      const wanted = Math.round(cssSide * (window.devicePixelRatio || 1));
      if (canvas.width !== wanted) canvas.width = canvas.height = wanted;
      side = wanted;
      clamp(picture, frame, side);
      draw(context, picture, frame, side);
      slider.value = String(frame.zoom);
    };
    /** Zooms by `factor` about a point of the square (its middle unless given, in CSS pixels from its middle). */
    const zoomBy = (factor: number, around = { x: 0, y: 0 }) => {
      const ratio = side / (stage.clientWidth || side);
      const before = scaleFor(picture, frame, side);
      frame.zoom = Math.min(Math.max(frame.zoom * factor, 1), maxZoom(picture));
      const after = scaleFor(picture, frame, side);
      // The point under the fingers (or the pointer) stays put.
      frame.x += (around.x * ratio) / before - (around.x * ratio) / after;
      frame.y += (around.y * ratio) / before - (around.y * ratio) / after;
      render();
    };
    const moveBy = (dx: number, dy: number) => {
      const scale = scaleFor(picture, frame, side) / (side / (stage.clientWidth || side));
      frame.x -= dx / scale;
      frame.y -= dy / scale;
      render();
    };

    // Dragging with a finger or the mouse; two fingers pinch.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const middle = () => {
      const rect = stage.getBoundingClientRect();
      const points = [...pointers.values()];
      const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
      return { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 };
    };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) pinch = spread();
    });
    canvas.addEventListener("pointermove", (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const now = { x: e.clientX, y: e.clientY };
      if (pointers.size === 1) moveBy(now.x - last.x, now.y - last.y);
      pointers.set(e.pointerId, now);
      if (pointers.size === 2 && pinch) {
        const next = spread();
        zoomBy(next / pinch, middle());
        pinch = next;
      }
    });
    const lift = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinch = pointers.size === 2 ? spread() : 0;
    };
    canvas.addEventListener("pointerup", lift);
    canvas.addEventListener("pointercancel", lift);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        // A trackpad pinch comes as a wheel with Ctrl held, in small steps.
        zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), {
          x: e.clientX - rect.left - rect.width / 2,
          y: e.clientY - rect.top - rect.height / 2,
        });
      },
      { passive: false },
    );
    canvas.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 10;
      const keys: Record<string, () => void> = {
        ArrowLeft: () => moveBy(step, 0),
        ArrowRight: () => moveBy(-step, 0),
        ArrowUp: () => moveBy(0, step),
        ArrowDown: () => moveBy(0, -step),
        "+": () => zoomBy(1.1),
        "=": () => zoomBy(1.1),
        "-": () => zoomBy(1 / 1.1),
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      keys[e.key]();
    });

    const tools = el("div", "crop-tools");
    const smaller = el("button", "icon-button crop-zoom", "−");
    smaller.type = "button";
    smaller.setAttribute("aria-label", "Zoom out");
    smaller.addEventListener("click", () => zoomBy(1 / 1.2));
    const slider = el("input", "crop-slider");
    slider.type = "range";
    slider.min = "1";
    slider.max = String(maxZoom(picture));
    slider.step = "0.01";
    slider.setAttribute("aria-label", "Zoom");
    slider.addEventListener("input", () => zoomBy(Number(slider.value) / frame.zoom));
    const bigger = el("button", "icon-button crop-zoom", "+");
    bigger.type = "button";
    bigger.setAttribute("aria-label", "Zoom in");
    bigger.addEventListener("click", () => zoomBy(1.2));
    const turn = el("button", "text-button crop-turn", "Rotate");
    turn.type = "button";
    turn.title = "Turn it a quarter to the right";
    turn.addEventListener("click", () => {
      // The same point stays in the middle, turned with the picture.
      const before = turned(picture, frame.turns);
      const [x, y] = [frame.x, frame.y];
      frame.turns = (frame.turns + 1) % 4;
      frame.x = before.height - y;
      frame.y = x;
      render();
    });
    const reset = el("button", "text-button", "Reset");
    reset.type = "button";
    reset.addEventListener("click", () => {
      const size = turned(picture, frame.turns);
      Object.assign(frame, { zoom: 1, x: size.width / 2, y: size.height / 2 });
      render();
    });
    tools.append(smaller, slider, bigger, turn, reset);

    const hint = el("p", "form-notes crop-hint", "Drag to move it. Pinch, scroll or use the slider to zoom.");
    const cancel = el("button", "text-button", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    const use = el("button", "primary-button", "Use photo");
    use.type = "button";
    use.addEventListener("click", () => {
      result = framedPhoto(picture, frame);
      dialog.close();
    });
    const buttons = el("div", "dialog-buttons");
    buttons.append(cancel, use);
    dialog.append(title, stage, tools, hint, buttons);
    dialog.showModal();
    render();
    use.focus();
    new ResizeObserver(() => dialog.isConnected && render()).observe(stage);
  });
}
