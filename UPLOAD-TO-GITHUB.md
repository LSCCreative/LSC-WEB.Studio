# How to Upload to GitHub

Follow these steps every time you make changes and want to push them live to **lsccreative.studio**.

---

## What GitHub Pages Does

Your GitHub repo is connected to your custom domain. Whenever you upload files to GitHub, the live website at lsccreative.studio updates automatically within 1–2 minutes.

---

## ⚠️ Missing File — Action Required

`assets/branding/shape-85.png` is referenced in the site but the file is **missing** from the project folder. The site will show a broken image wherever this is used until you add it.

**Fix:** Find the original `shape-85.png` file and place it at:
```
assets/branding/shape-85.png
```
Then upload it to GitHub following the steps below.

---

## Files to Upload to GitHub

Only upload what has changed. The website needs these files to work:

| File / Folder | Purpose | Upload when… |
|---|---|---|
| `index.html` | The entire website | Any time the design or content changes |
| `css/style.css` | Base stylesheet | If CSS changes were made outside index.html |
| `css/quote.css` | Quote form styling | Rarely |
| `js/app.js` | Site interactions (scroll, hover, modal) | If JS was updated |
| `assets/fonts/` | Custom fonts (Delight + CS-Felice-Mono) | First upload only — fonts don't change |
| `assets/branding/` | Logo, shape mark | If branding assets change |
| `assets/sections/section-services/` | Services images | If service images change |
| `assets/sections/section-work/` | Work thumbnail images | If thumbnails change |
| `assets/favicon.png` | Browser tab icon | If favicon changes |
| `CNAME` | Custom domain setting | First upload only — do not delete |

**Do NOT upload:**
- `.DS_Store` files (macOS junk)
- `CLAUDE.md` (internal Claude instructions)
- `Skills/` folder
- `.superpowers/` folder
- `lsc-portfolio-cms.csv`
- The `assets/sections/section-services/Old Services Frames/` folder

---

## Step-by-Step: Upload via GitHub Website

### First time (fresh upload of everything)

1. Go to your GitHub repo at **github.com/[your-username]/[your-repo-name]**
2. Click **Add file** → **Upload files**
3. Drag in the following folders and files from your project folder:
   - `index.html`
   - `css/` (entire folder)
   - `js/` (entire folder)
   - `assets/` (entire folder)
   - `CNAME`
4. At the bottom, write a commit message like: `"Initial upload — full site"`
5. Click **Commit changes**
6. Wait 1–2 minutes, then check lsccreative.studio

---

### Ongoing updates (most common — just changed index.html)

1. Go to your GitHub repo
2. Click **index.html** in the file list
3. Click the **pencil icon** (Edit this file) in the top-right
4. Press **Ctrl+A** (or **Cmd+A** on Mac) to select all, then **Delete**
5. Open your local `index.html` in a text editor (e.g. TextEdit, VS Code), select all, copy
6. Paste into the GitHub editor
7. Click **Commit changes**, write a short message (e.g. `"Update selected works hover effect"`)
8. Site updates within 1–2 minutes

> **Tip:** For `index.html` specifically, you can also drag-and-drop the file directly onto the GitHub upload page and it will replace the existing file.

---

### Uploading a whole folder (e.g. new assets)

1. Go to the folder on GitHub where you want to upload (e.g. click into `assets/sections/section-work/`)
2. Click **Add file** → **Upload files**
3. Drag your new images in
4. Commit changes

---

## Current Clean File List (what's tracked in git)

```
index.html
css/
  style.css
  quote.css
js/
  app.js
assets/
  favicon.png
  LSC Logo Type 3.png
  branding/
    lsc-logo.png
    hud-side-measure.png
    shape-85.png          ← MISSING, needs to be added
  fonts/
    cs-felice-mono/       (6 font files)
    delight/              (5 font files)
  sections/
    section-services/
      Services Screens.png
      servicesV2-02.png
      servicesV2-03.png
    section-work/
      marine-vitalities-thumb.png
      bnb-autohaus-thumb.png
      bakehouse-thumb.png
      illawarra-hawks-thumb.png
CNAME
.gitignore
```

---

## Checking if the site updated

After committing to GitHub:
1. Go to your repo → **Actions** tab (top menu)
2. You'll see a workflow running — wait for the green tick ✓
3. Then visit lsccreative.studio and hard-refresh (**Cmd+Shift+R** on Mac, **Ctrl+Shift+R** on Windows)
