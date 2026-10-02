"""Build a Firefox port of the Shazam Chrome extension.

Reads the unpacked Chrome extension from ./original, applies the Firefox
patches, and writes ./firefox (unpacked) and ./shazam-firefox.zip.
"""

import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "original"
OUT = ROOT / "firefox"
PATCHES = ROOT / "patches"
ZIP_PATH = ROOT / "shazam-firefox.zip"

ADDON_ID = "shazam-firefox-port@local"
# Firefox 149 is the first release with a spec-compliant captureStream() that
# keeps the element audible; the older mozCaptureStream() diverts its audio.
MIN_FIREFOX = "149.0"

# The popup records the tab with chrome.tabCapture and plays the captured
# audio back (tabCapture mutes the tab). Swap in the Firefox capture shim and
# drop the playback, since captureStream() leaves the page's audio untouched.
# A second capture while one is live fails like tabCapture's does: the
# callback gets no stream, `a` becomes null and creating the source throws.
RECORDER_ORIGINAL = (
    'const l=()=>{chrome.tabCapture.capture({audio:!0},e=>{a=e,r=new AudioContext;'
    'const t=r.createMediaStreamSource(e);"no"!==o&&"pending"!==o||(i=new Date);'
    'let n=new c(t);n.start(),t.connect(r.destination);'
)
RECORDER_PATCHED = (
    'const l=()=>{globalThis.ffTabCapture.capture({audio:!0},e=>{'
    'if(e&&e.ffBusy){a=null,r=e.ffContext;throw new TypeError("Cannot capture a tab with an active stream.")}'
    'if(!e)return void chrome.runtime.sendMessage({type:"silence"});'
    'a=e,r=e.ffContext;const t=e.ffSource;"no"!==o&&"pending"!==o||(i=new Date);'
    'let n=new c(t);n.start();'
)

# The recorder takes its 3/6/9/12 s snapshots on wall-clock timers started in
# the capture callback. The Firefox shim calls back late on purpose and hands
# over the audio captured meanwhile (ffPrerollMs), so shorten the timers by
# that much. Its PCM also comes from the page's main thread, which page jank
# delays; wait until the samples a tabCapture stream would have delivered by
# then have arrived (capped at 2 s extra).
TIMERS_ORIGINAL = (
    'this.capture3s=setTimeout(()=>{this.stop(!1)},3e3),'
    'this.capture6s=setTimeout(()=>{this.stop(!1)},6e3),'
    'this.capture9s=setTimeout(()=>{this.stop(!1)},9e3),'
    'this.capture12s=setTimeout(()=>{this.stop(!1)},12e3)'
)
TIMERS_PATCHED = (
    '(()=>{const p=Math.max(0,Math.min(3e3,e.context.ffPrerollMs||0)),g=(k,n)=>{'
    'const need=Math.floor(n*3*e.context.sampleRate/4096)*4096,d=Math.max(0,3e3*n-p),cap=Date.now()+d+2e3,'
    'f=()=>{e.recLength>=need||Date.now()>=cap?e.stop(!1):e[k]=setTimeout(f,10)};e[k]=setTimeout(f,d)};'
    'g("capture3s",1),g("capture6s",2),g("capture9s",3),g("capture12s",4)})()'
)

# The rating button stores is_rated and opens the store page in one go.
# Firefox aborts the in-flight storage write when the new tab closes the
# popup, which would bring the prompt back; open the page once it is stored.
# It opens synchronously in Chrome, so it keeps the native window.open (Ctrl
# and Shift apply) that ff-popup.js otherwise replaces.
RATE_CLICK = re.compile(
    r'onClick:\(\)=>\(chrome\.storage\.local\.set\(\{shazam_rating:\{is_rated:"yes"\}\}\),'
    r'void window\.open\(("[^"]+"),"_blank"\)\)'
)
RATE_CLICK_PATCHED = (
    'onClick:()=>{chrome.storage.local.set({shazam_rating:{is_rated:"yes"}})'
    '.finally(()=>(globalThis.ffNativeOpen||window.open)(\\1,"_blank"))}'
)

POPUP_SCRIPT_ORIGINAL = '<script defer="defer" src="/popup.bundle.js"></script>'
POPUP_SCRIPT_PATCHED = (
    '<link rel="stylesheet" href="/ff-popup.css"/>'
    '<script defer="defer" src="/ff-popup.js"></script>'
    '<script defer="defer" src="/ff-detect.js"></script>'
    '<script defer="defer" src="/ff-tabcapture.js"></script>'
    + POPUP_SCRIPT_ORIGINAL
)

ADDED_FILES = ("ff-tabcapture.js", "ff-capture-content.js", "ff-popup.css", "ff-popup.js")

# Hashed class names the patches target; a new bundle version renames them.
BUNDLE_CLASSES = (
    "li4ou6PVyauMoiqDcF2y",  # listening view Cancel (ff-tabcapture.js)
    "RLHtwz_RlwPoJIR5A33T",  # library list (ff-popup.js)
)

# Chrome 154's chrome.i18n.detectLanguage() result for each locale's
# "nomatch_no_audio" text (None = not reliable).
CHROME_DETECT = {
    "cs": "cs", "de": "de", "el": "el", "en": "en", "en_GB": "en", "es": "es", "fr": "fr",
    "hi": "hi", "it": "it", "ja": "ja", "ko": "ko", "nl": "nl", "pl": "pl", "pt_BR": "pt",
    "pt_PT": "pt", "ru": "ru", "sk": "sk", "uk": "uk", "zh_TW": "zh",
    "id": None, "tr": None, "zh_CN": None,
}

# Chrome picks the extension locale from its own UI locale and falls back to
# default_locale ("en"); Firefox negotiates over its whole app-locale chain and
# lands on the build language instead. Give every Firefox UI language the
# extension lacks an English folder, and fold English variants into en_GB the
# way Chrome's UI locale does.
FIREFOX_UI_LANGUAGES_WITHOUT_LOCALE = (
    "ach", "af", "an", "ar", "ast", "az", "be", "bg", "bn", "bo", "br", "brx", "bs", "ca", "cak",
    "ckb", "cy", "da", "dsb", "eo", "et", "eu", "fa", "ff", "fi", "fur", "fy", "ga", "gd", "gl",
    "gn", "gu", "he", "hr", "hsb", "hu", "hy", "hye", "ia", "is", "ka", "kab", "kk", "km", "kn", "lij",
    "lo", "lt", "ltg", "lv", "meh", "mk", "mr", "ms", "my", "nb", "ne", "nn", "oc", "pa", "rm",
    "ro", "sat", "sc", "scn", "sco", "si", "skr", "sl", "son", "sq", "sr", "sv", "szl", "ta", "te", "tg",
    "th", "tl", "trs", "ur", "uz", "vi", "wo", "xh",
)
ENGLISH_VARIANTS_AS_GB = ("en_AU", "en_CA", "en_IN", "en_NZ", "en_ZA")


def replace_once(text: str, old: str, new: str, what: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Patch '{what}' expected exactly 1 match, found {count}")
    return text.replace(old, new)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", newline="")


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="")


def patch_manifest(path: Path) -> None:
    manifest = json.loads(read_text(path))
    for key in ("update_url", "key", "devtools_page", "web_accessible_resources"):
        manifest.pop(key, None)
    manifest["background"] = {"scripts": ["background.bundle.js"]}
    permissions = [p for p in manifest["permissions"] if p != "tabCapture"]
    manifest["permissions"] = permissions + ["activeTab", "scripting"]
    # Chrome's effective host access comes from the content-script matches;
    # a wider grant would make the beacon.shazam.com requests same-site.
    manifest["host_permissions"] = ["*://www.shazam.com/*", "*://amp.shazam.com/*"]
    # activeTab only covers the tab's top-level origin. Granting this in
    # about:addons lets the capture script reach cross-origin iframes too
    # (e.g. embedded YouTube players).
    manifest["optional_host_permissions"] = ["<all_urls>"]
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": ADDON_ID,
            "strict_min_version": MIN_FIREFOX,
            # AMO requires an explicit data-collection declaration. This port
            # does not transmit any user data, so declare "none".
            "data_collection_permissions": {"required": ["none"]},
        }
    }
    write_text(path, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def patch_text(path: Path, old: str, new: str, what: str) -> None:
    write_text(path, replace_once(read_text(path), old, new, what))


def patch_bundle(path: Path) -> None:
    text = read_text(path)
    missing = [name for name in BUNDLE_CLASSES if name not in text]
    if missing:
        raise SystemExit(f"popup.bundle.js no longer contains classes used by the patches: {missing}")
    text = replace_once(text, RECORDER_ORIGINAL, RECORDER_PATCHED, "recorder")
    text = replace_once(text, TIMERS_ORIGINAL, TIMERS_PATCHED, "recorder timers")
    text, count = RATE_CLICK.subn(RATE_CLICK_PATCHED, text)
    if count != 1:
        raise SystemExit(f"Patch 'rate button' expected exactly 1 match, found {count}")
    write_text(path, text)


def patch_locales(locales: Path) -> None:
    # Chrome's en locale lacks this key and silently returns ""; Firefox logs
    # an error for every missing key.
    en_messages = locales / "en" / "messages.json"
    messages = json.loads(read_text(en_messages))
    messages.setdefault("am_button_moreoptions", {"message": ""})
    write_text(en_messages, json.dumps(messages, indent="\t", ensure_ascii=False) + "\n")

    for code in FIREFOX_UI_LANGUAGES_WITHOUT_LOCALE:
        if not (locales / code).exists():
            shutil.copytree(locales / "en", locales / code)
    for code in ENGLISH_VARIANTS_AS_GB:
        if not (locales / code).exists():
            shutil.copytree(locales / "en_GB", locales / code)


def write_detect_shim(locales: Path) -> None:
    shipped = sorted(p.name for p in (SRC / "_locales").iterdir() if (p / "messages.json").is_file())
    unknown = [name for name in shipped if name not in CHROME_DETECT]
    if unknown:
        raise SystemExit(f"Add Chrome's detectLanguage results for new locales: {unknown}")
    results = {}
    for name in shipped:
        text = json.loads(read_text(locales / name / "messages.json"))["nomatch_no_audio"]["message"]
        language = CHROME_DETECT[name]
        results[text] = [language is not None, language or name.split("_")[0]]
    template = read_text(PATCHES / "ff-detect.js")
    shim = replace_once(template, "__CHROME_DETECT_RESULTS__", json.dumps(results, ensure_ascii=False), "detect table")
    write_text(OUT / "ff-detect.js", shim)


def build_zip() -> bool:
    tmp = ZIP_PATH.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in sorted(OUT.rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(OUT).as_posix())
    try:
        tmp.replace(ZIP_PATH)
    except PermissionError:
        tmp.unlink()
        print(f"Warning: {ZIP_PATH.name} is in use by another program and was not updated")
        return False
    return True


def main() -> None:
    if not (SRC / "manifest.json").is_file():
        raise SystemExit(f"Unpacked Chrome extension not found in {SRC}")
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SRC, OUT, ignore=shutil.ignore_patterns("_metadata"))
    # Chrome ignores this unused non-locale folder; Firefox refuses to load
    # the extension because it has no messages.json.
    shutil.rmtree(OUT / "_locales" / "default", ignore_errors=True)

    patch_manifest(OUT / "manifest.json")
    patch_bundle(OUT / "popup.bundle.js")
    patch_text(OUT / "popup.html", POPUP_SCRIPT_ORIGINAL, POPUP_SCRIPT_PATCHED, "popup.html")
    write_detect_shim(OUT / "_locales")
    patch_locales(OUT / "_locales")
    for name in ADDED_FILES:
        shutil.copy2(PATCHES / name, OUT / name)

    print(f"Built {OUT}")
    if build_zip():
        print(f"Built {ZIP_PATH}")


if __name__ == "__main__":
    main()
