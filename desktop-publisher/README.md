# LSC Publisher (desktop)

A macOS menu-bar app for putting a finished file in front of a client without
opening the NAS share or the browser (Bunny Slice 10). Pick a project and one of
its deliverables, drop a video or a folder of photos, confirm, and it:

1. **copies it onto the NAS** (into the project's folder in `Client Deliverables_Media`),
   unless it's already there;
2. **adds it as the deliverable's next version** (Draft Cut or Final, whatever the
   item is set to);
3. **sends it to Bunny** and waits until Bunny has it ready (when Bunny is on). A
   video Bunny can't take stops there. A photo library Bunny can't take is still
   published, and the client sees it from the NAS until you send it to Bunny again
   from the Deliverables tab (the admin's Publish allows the same);
4. **publishes it**, so the client sees it in the portal.

Every step is the same `/api` route the admin's Deliverables tab uses, so the
server's own rules still apply: no archived projects, no items marked not
needed, only the newest version is published, and a video waits for Bunny.

What it doesn't do:

- **No portal invite.** On a project's first publish it says so; send the invite
  from the Deliverables tab, where you choose who it goes to.
- **No Bunny keys.** It signs in with the admin's account and the server does the
  Bunny side. The app holds no key.
- **No stored password.** The password goes to `/api/login` once. After that the
  server's session cookie (30 days) is kept by macOS for this app only. **Sign out**
  ends it.

## Build and run

You need Xcode (or its command-line tools) on macOS 14 or later. There are no
other dependencies.

```bash
cd desktop-publisher
sh build-app.sh --open
```

That builds `dist/LSC Publisher.app` (gitignored) and opens it. To keep it, drag
it into Applications, and add it under System Settings › General › Login Items
if you want it there after every restart. The build cache lives in
`~/Library/Caches/lsc-publisher-build`, outside Google Drive.

It runs in the menu bar only (there's no Dock icon). Click the ↑ icon.

## First run

1. **Connect to the NAS share.** In Finder: Go › Connect to Server, then the NAS's
   `LSC Creative_Media` share. The app expects
   `/Volumes/LSC Creative_Media/Client Deliverables_Media`. If yours mounts
   elsewhere, set it under **Settings… › NAS deliverables folder**.
2. **Sign in** with the admin's username or email and password.
3. **Choose a project** (anything in production or review) and **a deliverable**.
   The label shows the version it will become, e.g. `Hero film · v3 Final`.
4. **NAS folder**: where a file from elsewhere is copied. It starts as the folder the
   project's last version came from. Use **Change…** to choose another, or to set
   one for a project with nothing published yet. It's remembered per project.

## Publishing

- **Drag from Finder onto the drop window.** The menu-bar panel closes when you
  click in Finder, so use **Drop window** to open a window that stays put. Or
  click **Choose…** and pick the file.
- A **video** is one `.mp4`, `.mov`, `.webm` or `.m4v`. **Photos** are a folder of
  `.jpg`, `.png` or `.webp` images (200 at most). Only the images directly in the
  folder are copied; subfolders and other files are left behind.
- A file already on the share isn't copied: the server reads it where it is.
- A copied file never overwrites anything. If the name is taken, it becomes
  `Cut (2).mp4`. While it's copying, it's a hidden `.lscpart` file, so the server
  never sees half a file. **Stop** removes it.
- From the drop until the publish ends, the project, deliverable and folder are
  locked: what the confirm card names is where it goes.
- A `.lscpart` more than a day old (the app quit or the Mac slept mid-copy) is
  removed the next time something is copied into that folder. **Quit** during a
  publish asks first, then stops it cleanly.
- If something fails partway, the message says how far it got: "The copy is on the
  NAS…" (nothing added), or "v3 is added but not published" (finish it from the
  Deliverables tab).

## Settings

- **Server**: `https://app.lsccreative.studio`. Plain `http://` is accepted only
  for `localhost`, for testing against a scratch server.
- **NAS deliverables folder**: see First run.

## For developers

```
Sources/PublisherCore/   everything testable: NAS paths, the copy, the API client, the publish steps
Sources/LSCPublisher/    the SwiftUI app (MenuBarExtra, drop window, Settings)
Tests/PublisherCoreTests/
Resources/Info.plist     LSUIElement (menu bar only); local-network http for scratch testing
```

```bash
swift test --scratch-path ~/Library/Caches/lsc-publisher-build
```

The end-to-end tests (`EndToEndTests.swift`) are skipped unless `LSC_E2E_BASE`
points at a scratch admin server on this Mac (launch config `portal-api-fakebunny`).
They add and publish real versions there. The file lists the variables they need.
