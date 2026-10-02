# Shazam for Firefox — Port Kit

An unofficial **port kit** that rebuilds the [Shazam browser extension](https://www.shazam.com/apps)
so it runs on Firefox. It ships only the porting work — a build script and a set
of patches. You supply your own copy of Shazam's extension; the script applies
the patches to it and produces a Firefox-ready build.

> ⚠️ **Unofficial & fan-made.** Not affiliated with, authorized by, or endorsed
> by Shazam or Apple Inc. "Shazam" is a trademark of Apple Inc. This repository
> contains **no Shazam code or assets** — only an independent build script and
> compatibility patches. You supply Shazam's extension yourself. See
> [Legal](#legal).

---

## Why a port kit?

Shazam publishes its extension for Chrome only. The Chrome build relies on
`chrome.tabCapture`, which Firefox doesn't implement the same way. This kit swaps
in Firefox-compatible shims (using the spec-compliant `captureStream()`),
adjusts the manifest for Manifest V3 on Gecko, fixes locale negotiation, and
rewires a few popup behaviours that differ between the browsers.

Because the fix is a set of patches against Shazam's compiled code, the kit
distributes **the patches**, not Shazam's code. You bring the original; the
script does the rest.

## What this does / doesn't ship

| Shipped in this repo (the port work — ours) | **Not** shipped (Shazam/Apple's — you supply) |
| --- | --- |
| `build.py` — the build/patch script | `original/` — the unpacked Chrome extension |
| `patches/` — Firefox shims and overrides | `*.crx` — the packed Chrome extension |
| `README.md`, `.gitignore` | `firefox/`, `shazam-firefox.zip` — build outputs |

## Requirements

- **Python 3.9+** (standard library only — no packages to install)
- **Firefox 149 or newer** (needed for the spec-compliant `captureStream()`)
- For signing: **Node.js** and an [addons.mozilla.org](https://addons.mozilla.org/) account

## Build

1. **Get Shazam's extension.** Install [Shazam from the Chrome Web Store](https://chromewebstore.google.com/)
   and locate its unpacked files, or download its `.crx` and unzip it. Place the
   unpacked files (the folder containing `manifest.json`) at `./original/`.

2. **Run the build:**

   ```sh
   python build.py
   ```

   This reads `./original/`, applies the patches, and writes:
   - `./firefox/` — the unpacked Firefox extension
   - `./shazam-firefox.zip` — the same, packaged

The script verifies each patch matches exactly once and fails loudly if Shazam
ships a new bundle that renamed the classes or code the patches target — see
[Keeping up with Shazam updates](#keeping-up-with-shazam-updates).

## Install

Firefox (stable) only installs **signed** extensions. Two options:

### A. Temporary (resets when Firefox closes)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → select `firefox/manifest.json`

### B. Permanent (sign it once via Mozilla)

Mozilla signs **unlisted** (self-distributed) add-ons automatically — no public
listing, no human review required to use it.

Either upload `shazam-firefox.zip` at
<https://addons.mozilla.org/developers/addon/submit/> → choose **"On your own"**,
or sign from the command line:

```sh
npm install -g web-ext
cd firefox
web-ext sign --channel=unlisted --api-key=<ISSUER> --api-secret=<SECRET>
```

API credentials come from
<https://addons.mozilla.org/developers/addon/api/key/>. Download the signed
`.xpi`, then install it via `about:addons` → ⚙️ → **Install Add-on From File…**.

## Using the extension

Once installed, the extension works like the official Shazam one:

1. Play audio in a tab — a song in a YouTube video, a stream, a web player, etc.
2. Click the **Shazam** icon in the Firefox toolbar.
3. Press **listen** in the popup. It captures a few seconds of the tab's audio
   and identifies the track, then shows the title, artist, and a link.
4. Identified songs are kept in the popup's **history**.

Notes:

- It identifies audio playing **in the browser tab**, not from your microphone.
- Capturing from embedded cross-origin players (e.g. a YouTube iframe) needs the
  optional all-sites permission. Grant it in `about:addons` → the extension →
  **Permissions** if a capture comes back silent.
- Requires **Firefox 149+** (see [Requirements](#requirements)).

## Keeping up with Shazam updates

The patches target specific minified code and hashed class names in Shazam's
bundle (`BUNDLE_CLASSES` in `build.py`). When Shazam ships a new version the
build will stop with an error naming what no longer matches. Update the affected
pattern in `build.py` / `patches/` against the new `original/` and rebuild.

## Legal

**This is an independent, unofficial, fan-made port kit. It is not affiliated
with, authorized by, endorsed by, or associated with Shazam Entertainment Ltd.
or Apple Inc.** "Shazam", the Shazam logo, and related marks are trademarks of
Apple Inc. All rights to the Shazam extension and its code, assets, and branding
belong to their respective owners.

### What this repository contains

This repository contains **only original work by its author**: a build script
(`build.py`) and a set of Firefox compatibility patches (`patches/`). These
patches are transformative — they describe *changes* to make Shazam's extension
run on Firefox.

### What this repository does NOT contain

This repository **does not** include, host, redistribute, or mirror any of
Shazam's or Apple's code, compiled bundles, icons, images, localized strings, or
other assets. It does not include the packed (`.crx`) or unpacked extension, the
generated Firefox build, or the signed `.xpi`. The `.gitignore` is configured to
keep all of that out of version control. **Do not commit those files.**

### For users

To build the port you must obtain Shazam's extension **yourself** from an
official source and supply it locally (see [Build](#build)). Using this kit and
the resulting build is your responsibility and must comply with Shazam's and
Apple's terms of service and the laws of your jurisdiction.

### DMCA / takedown

If you are a rights holder and believe this repository infringes your rights,
please open an issue or contact the repository owner; the maintainer will
respond promptly to any legitimate concern. This project is offered in good
faith as interoperability/compatibility work and intentionally ships none of the
original copyrighted material.

### License

The original porting work in this repository (`build.py`, `patches/`) is released
under the [MIT License](./LICENSE). That license covers **only** this repository's
own code — it does **not** grant any rights to Shazam's or Apple's intellectual
property.
