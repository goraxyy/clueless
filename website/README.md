# Website

The download page, install guide, privacy and terms. Plain HTML and one stylesheet, no build step.

- The download buttons link to `github.com/goraxyy/clueless/releases/latest/download/Clueless-mac.dmg`
  and `.../Clueless-Setup.exe`, so they always get the newest release. They 404 until the first
  release is published (see `RELEASING.md`).
- Hosting: Vercel, with this folder as the project's root directory. `vercel.json` gives clean URLs
  (`/install` instead of `/install.html`).
- Before publishing: replace `CONTACT_EMAIL` in `privacy.html` and `terms.html`. Both pages are plain
  drafts, not reviewed by a lawyer.
- Try it locally: `python3 -m http.server 8080` in this folder, then open http://localhost:8080
(or just open index.html).
