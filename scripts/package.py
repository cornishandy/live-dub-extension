"""Build an installable ZIP from an explicit source allowlist; never include keys or Git history."""
from pathlib import Path
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    'manifest.json', 'background.js', 'config.js', 'offscreen.html',
    'offscreen.js', 'popup.html', 'popup.css', 'popup.js',
    'README.md', 'PRIVACY.md', 'CHANGELOG.md',
]
version = json.loads((ROOT / 'manifest.json').read_text())['version']
destination = ROOT / 'dist' / f'live-dub-extension-{version}.zip'
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in FILES:
        archive.write(ROOT / name, f'live-dub-extension/{name}')
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None
print(destination)
