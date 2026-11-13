"""Draws Minuteman Contacts' icons, in the app icon's style (a navy rounded
square with a gold rim) with an ivory person: the menu bar / tray image
(contacts-tray.png, 72 px, as tray.png), the Mac launcher's contacts.icns and
the Windows Start menu shortcut's contacts.ico.

    python3 src-tauri/icons/source/contacts-icon.py   (needs Pillow)
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent
S = 1024  # drawn at this size, then made smaller
NAVY_TOP, NAVY_BOTTOM = (34, 57, 95), (15, 26, 51)
GOLD = (212, 171, 79)
IVORY = (246, 239, 222)
RED = (184, 50, 58)


def draw(size: int, margin: float) -> Image.Image:
    big = 4 * size  # drawn larger, for smooth edges
    m = margin * big
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
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(gradient, (0, 0), mask)

    # The person: a head, and shoulders cut off by the square.
    person = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(person)
    inner = big - 2 * m
    cx = big / 2
    head_r = 0.17 * inner
    head_cy = m + 0.40 * inner
    d.ellipse((cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r), fill=IVORY)
    body_w, body_top = 0.36 * inner, m + 0.64 * inner
    d.ellipse((cx - body_w, body_top, cx + body_w, body_top + 0.75 * inner), fill=IVORY)
    # A red star on the chest, as the logo's red star.
    star_r = 0.055 * inner
    sy = body_top + 0.17 * inner
    d.regular_polygon((cx, sy, star_r), 5, rotation=0, fill=RED)
    inside = Image.new("L", (big, big), 0)
    ImageDraw.Draw(inside).rounded_rectangle(
        (m + rim, m + rim, big - m - rim, big - m - rim), max(radius - rim, 1), fill=255
    )
    out.paste(person, (0, 0), Image.composite(person.getchannel("A"), Image.new("L", (big, big), 0), inside))

    # The gold rim.
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
    print("wrote contacts-tray.png, contacts.icns, contacts.ico")
