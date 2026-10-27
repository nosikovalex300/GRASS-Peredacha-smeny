"""
Генерирует иконки Android и заставку из GRASS_icon.png (корень репозитория)
в mobile/android-res. Запускается при сборке: python3 scripts/make-icons.py
Нужен Pillow (pip install pillow).
"""
import os
import sys
from PIL import Image, ImageDraw

MOBILE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(MOBILE), 'GRASS_icon.png')
OUT = os.path.join(MOBILE, 'android-res')

src = Image.open(SRC).convert('RGBA')
if src.width != src.height or src.width < 432:
    sys.exit(f'make-icons: нужна квадратная иконка не меньше 432px, а это {src.size}')

# Фон адаптивной иконки — тёмно-зелёный край самой иконки.
bg = src.getpixel((int(src.width * 0.12), int(src.height * 0.5)))[:3]
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def circle(img):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.width - 1, img.height - 1), fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def write(rel, text):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


for d, k in DENS.items():
    folder = os.path.join(OUT, f'mipmap-{d}')
    os.makedirs(folder, exist_ok=True)
    s = round(48 * k)
    src.resize((s, s), Image.LANCZOS).save(os.path.join(folder, 'ic_launcher.png'), optimize=True)
    # Адаптивная иконка: картинка 84dp в центре слоя 108dp (видимая зона 72dp — ничего не обрезается).
    f = round(108 * k)
    inner = round(84 * k)
    small = src.resize((inner, inner), Image.LANCZOS)
    fg = Image.new('RGBA', (f, f), (0, 0, 0, 0))
    fg.paste(small, ((f - inner) // 2, (f - inner) // 2), small)
    fg.save(os.path.join(folder, 'ic_launcher_foreground.png'), optimize=True)
    full = Image.new('RGBA', (f, f), bg + (255,))
    full.alpha_composite(fg)
    vis = round(72 * k)
    off = (f - vis) // 2
    circle(full.crop((off, off, off + vis, off + vis)).resize((s, s), Image.LANCZOS)).save(
        os.path.join(folder, 'ic_launcher_round.png'), optimize=True)

os.makedirs(os.path.join(OUT, 'drawable-nodpi'), exist_ok=True)
src.resize((288, 288), Image.LANCZOS).save(os.path.join(OUT, 'drawable-nodpi', 'grass_splash_logo.png'), optimize=True)

write('values/grass_colors.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
      '    <color name="ic_launcher_background">#%02x%02x%02x</color>\n'
      '    <color name="grass_splash_background">#02150f</color>\n</resources>\n' % bg)
adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            '</adaptive-icon>\n')
write('mipmap-anydpi-v26/ic_launcher.xml', adaptive)
write('mipmap-anydpi-v26/ic_launcher_round.xml', adaptive)
write('drawable/splash.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n'
      '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n'
      '    <item android:drawable="@color/grass_splash_background"/>\n'
      '    <item android:width="144dp" android:height="144dp" android:gravity="center">\n'
      '        <bitmap android:src="@drawable/grass_splash_logo" android:gravity="fill"/>\n'
      '    </item>\n</layer-list>\n')

count = sum(len(files) for _, _, files in os.walk(OUT))
print(f'make-icons: {count} файлов в {OUT}, фон #%02x%02x%02x' % bg)
