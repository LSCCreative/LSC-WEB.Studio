# Archive — historical only, do not follow

Kept for provenance ("why is it built this way"), not for guidance.

| File | Status |
|---|---|
| `BUILD-PLAN.md` | The original 4-sprint spec. **All four sprints are delivered.** Still the best explanation of *why* the data model and security split look the way they do. Its "next step" sections are obsolete. |
| `Reference Template (Bunny.net Standalone Edge Script).js` | ⚠️ **Actively misleading.** Shows the standalone `serve()` model; the deployed script is **middleware** (`servePullZone().onOriginRequest()`) and reads env via `process.env`. Use `../hub-edge-script.js` instead. |
| `Reference Template (.github:workflows:deploy.yml).yaml` | Unused — Bunny mirrors the GitHub repo directly, so there's no GitHub Action in play. |

Current truth lives in `../START-HERE.md`, `../Handoff.md`, and `../BUNNY-SETUP.md`.
