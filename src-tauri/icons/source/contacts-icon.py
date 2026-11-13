"""Draws Minuteman Contacts' icons, in the app icon's style (a navy rounded
square with a gold rim) with a minuteman: an ivory figure in a tricorn hat,
a red cross-strap (his cartridge box's sling) and a gold musket with its
bayonet fixed, shouldered. The menu bar / tray image
(contacts-tray.png, 72 px, as tray.png), the Mac launcher's contacts.icns and
the Windows Start menu shortcut's contacts.ico, and the website's home
screen icons for the Contacts page (public/contacts-*.png).

    python3 src-tauri/icons/source/contacts-icon.py   (needs Pillow)
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ICONS = Path(__file__).resolve().parent.parent
S = 1024  # drawn at this size, then made smaller
NAVY_TOP, NAVY_BOTTOM = (34, 57, 95), (15, 26, 51)
GOLD = (212, 171, 79)
IVORY = (246, 239, 222)
RED = (184, 50, 58)


def draw(size: int, margin: float, full: bool = False) -> Image.Image:
    """The icon, `size` across. `full`: the whole square navy, no rim or round
    corners (a phone rounds them itself), the figure inside the middle 80%,
    as the website's home screen icons are."""
    big = 4 * size  # drawn larger, for smooth edges
    m = 0 if full else margin * big
    box = (m, m, big - m, big - m)
    radius = 0.22 * (big - 2 * m)
    rim = 0.035 * (big - 2 * m)

    # The navy square, top to bottom lighter to darker.
    gradient = Image.new("RGBA", (big, big))
    pixels = gradient.load()
    for y in range(big):
        t = y / big
        color = tuple(round(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOTTOM)) + (255,)
        for x in range(big):
            pixels[x, y] = color
    mask = Image.new("L", (big, big), 255 if full else 0)
    if not full:
        ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(gradient, (0, 0), mask)

    # The minuteman, drawn on the square's inside (0 to 1 across and down).
    person = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(person)
    inner = big - 2 * m
    # Full bleed: the figure in the middle 80% (his shoulders still run off the bottom).
    pad = 0.1 * big if full else m
    figure = big - 2 * pad if full else inner

    def at(x: float, y: float) -> tuple[float, float]:
        return (pad + x * figure, pad + y * figure)

    # His musket, shouldered, behind him; then its bayonet.
    d.polygon([at(0.705, 0.86), at(0.745, 0.86), at(0.835, 0.17), at(0.80, 0.165)], fill=GOLD)
    d.polygon([at(0.80, 0.165), at(0.835, 0.17), at(0.835, 0.07), at(0.822, 0.07)], fill=IVORY)
    # Shoulders, cut off by the square, and his head.
    body = [at(0.20, 0.66), at(0.80, 1.36)]
    d.ellipse(body, fill=IVORY)
    d.ellipse([at(0.375, 0.39), at(0.605, 0.62)], fill=IVORY)
    # Tricorn: a wide, low hat, the brim turned up into two side corners and
    # a front point, the crown just showing above it.
    d.ellipse([at(0.385, 0.215), at(0.595, 0.355)], fill=IVORY)
    d.polygon(
        [at(0.20, 0.335), at(0.27, 0.285), at(0.36, 0.265), at(0.49, 0.29), at(0.62, 0.265),
         at(0.71, 0.285), at(0.78, 0.335), at(0.70, 0.36), at(0.49, 0.44), at(0.28, 0.36)],
        fill=IVORY,
    )
    # The cross-strap: from his shoulder across his chest, on him to the
    # edge of his body (or of the square), however much of him shows.
    strap = Image.new("L", (big, big), 0)
    ImageDraw.Draw(strap).polygon([at(0.30, 0.72), at(0.36, 0.69), at(1.18, 1.38), at(1.12, 1.40)], fill=255)
    on_him = Image.new("L", (big, big), 0)
    ImageDraw.Draw(on_him).ellipse(body, fill=255)
    person.paste(RED + (255,), (0, 0), ImageChops.multiply(strap, on_him))
    inside = Image.new("L", (big, big), 255 if full else 0)
    if not full:
        ImageDraw.Draw(inside).rounded_rectangle(
            (m + rim, m + rim, big - m - rim, big - m - rim), max(radius - rim, 1), fill=255
        )
    out.paste(person, (0, 0), ImageChops.multiply(person.getchannel("A"), inside))

    # The gold rim.
    if not full:
        ImageDraw.Draw(out).rounded_rectangle(box, radius, outline=GOLD + (255,), width=round(rim))
    return out.resize((size, size), Image.LANCZOS)


def write_icns(path: Path) -> None:
    """An .icns of PNGs (macOS 10.7 and later read these as they are)."""
    chunks = b""
    for kind, size in [(b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)]:
        png = io.BytesIO()
        draw(size, 0.1).save(png, "PNG")
        data = png.getvalue()
        chunks += kind + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


if __name__ == "__main__":
    # The tray: as tray.png, the square nearly fills it.
    draw(72, 0.06).save(ICONS / "contacts-tray.png")
    write_icns(ICONS / "contacts.icns")
    draw(256, 0.02).save(ICONS / "contacts.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # The website's Contacts page, added to a phone's home screen (contacts.webmanifest).
    public = ICONS.parent.parent / "public"
    draw(180, 0, full=True).convert("RGB").save(public / "contacts-touch-icon.png")
    draw(192, 0, full=True).convert("RGB").save(public / "contacts-192.png")
    draw(512, 0, full=True).convert("RGB").save(public / "contacts-512.png")
    print("wrote contacts-tray.png, contacts.icns, contacts.ico and public/contacts-*.png")
