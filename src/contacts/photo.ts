// Contacts' photos: any picture made into the small square JPEG Google keeps.
// iPhone photos (HEIC) open where the browser can open them (Safari); where
// it can't (Chrome, Edge, the Windows app) a HEIC decoder is loaded, only
// then, as it's large.

/** The side of a contact's photo, in pixels: a square, as Google shows it. */
export const PHOTO_SIZE = 512;

type Picture = ImageBitmap | HTMLImageElement;

/** `file` opened as a picture, whatever the browser can open, and HEIC anywhere. */
async function openPicture(file: Blob): Promise<Picture> {
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
