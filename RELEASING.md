# Releasing Clueless

A release is a version tag. GitHub Actions builds the Mac and Windows installers, uploads them to a
GitHub release, and publishes it once both are up. Installed copies then update themselves, and the
website's download buttons point at the new files.

## Cut a release

1. Make sure `main` is green (the Tests workflow).
2. Bump the version in `app/package.json` (for example `0.2.0`), commit, and push.
3. Tag and push the tag:
   ```bash
   git tag v0.2.0
   ```
   ```bash
   git push origin v0.2.0
   ```
4. Watch the Release workflow in the repo's Actions tab. It takes about 15 minutes. The tag must match
   the version in `app/package.json`, or the workflow stops at the first step.

What gets published (always with these names, so the website's links never change):

| File | What it is |
|---|---|
| `Clueless-mac.dmg` | The Mac download (Apple silicon and Intel) |
| `Clueless-mac.zip`, `latest-mac.yml` | What installed Macs download to update |
| `Clueless-Setup.exe`, `latest.yml` | The Windows installer, and what installed PCs check for updates |

## Mac signing (Apple Developer Program, individual)

Until this is set up, the Mac app is unsigned:
- macOS asks students to click **Open Anyway** in System Settings.
- Auto-update doesn't work on Mac, because macOS only installs updates signed by the same developer.

The release workflow prints a warning, and the website's install guide covers the Open Anyway step.

1. Enroll at developer.apple.com/programs as an **individual** ($99 a year).
2. **Developer ID certificate.** In Xcode, open Settings → Accounts → Manage Certificates and add a
   **Developer ID Application** certificate. Then in Keychain Access, right-click it and export it as
   a `.p12` file with a password.
3. **API key for notarizing.** In App Store Connect, open Users and Access → Integrations → App Store
   Connect API and create a key with the Developer role. Download the `.p8` file, and note its
   **Key ID** and the **Issuer ID**.
4. **GitHub secrets.** In the repo's Settings → Secrets and variables → Actions, add:

   | Secret | Value |
   |---|---|
   | `MAC_CERT_P12_BASE64` | the `.p12` file as base64: `base64 -i cert.p12 \| pbcopy` |
   | `MAC_CERT_PASSWORD` | the `.p12` password |
   | `APPLE_API_KEY_P8` | the whole text of the `.p8` file |
   | `APPLE_API_KEY_ID` | the Key ID |
   | `APPLE_API_ISSUER` | the Issuer ID |

The next release is then signed and notarized: no warnings, and Mac auto-update works.

## Windows signing (later)

For the beta the Windows installer is unsigned. Windows shows **Windows protected your PC**, and
students click **More info → Run anyway**, as the install guide explains. Auto-update works anyway.

Before a wider launch, add signing:
- **Azure Trusted Signing:** about $10 a month and an identity check.
- **A code-signing certificate:** $200 or more a year.

Either one plugs into electron-builder's `win` settings.

## Before the first release

- The account server must be live (`supabase/README.md`), and `app/src/main/account/project.ts`
  must have its URL and publishable key. Otherwise the installed app has nowhere to sign in.
- Fill in `CONTACT_EMAIL` on the website's privacy and terms pages, then deploy `website/` to Vercel.

## Build on your own Mac

```bash
cd app && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

The result is in `app/dist/`: an unsigned universal `Clueless-mac.dmg`. Nothing is uploaded.
