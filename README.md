# Coullsey's Lucky Wheel

Webhook-driven spin wheel for TikTok LIVE. Trigger a wheel from TikFinity, DrewTok or anything that can call a URL, and it spins on stream (OBS / TikTok LIVE Studio browser source) with the viewer's name, then fires the winning box's webhook and/or keybind.

**Download:** grab `Coullseys-Lucky-Wheel-Setup-x.y.z.exe` from [Releases](https://github.com/Coullsey/coullseys-lucky-wheel/releases). The app updates itself from there.

## Using it

- **Overlay:** add `http://localhost:5730/overlay` as a Browser Source (1080 × 1080).
- **Trigger a wheel:** `http://localhost:5730/wheel?id=<wheel id>&userName={nickname}` (GET or POST). Each wheel's link is on the Play and Wheels screens.
- **Wheels:** boxes with colours/photos, chance (frequency), and an optional webhook and/or recorded keybind for when it lands. Each wheel can show as a roulette wheel or a bar.
- **Customize:** font (built-in or upload your own), colours, prize and queue text.
- Your wheels, photos, fonts and `wheel.log` live in `%APPDATA%\Coullseys Lucky Wheel` (Settings → Open data folder).

## Building

```bash
npm install
npm start          # run the app from source
npm run build      # makes dist/Coullseys-Lucky-Wheel-Setup-<version>.exe
```

`node server.js` runs just the wheel server (saving next to the code) without the app window.

## Releasing an update

1. Bump `version` in `package.json` (e.g. `1.0.1`) and run `npm run build`.
2. On GitHub, create a release with tag `v1.0.1` and upload these three files from `dist/`:
   `Coullseys-Lucky-Wheel-Setup-1.0.1.exe`, `Coullseys-Lucky-Wheel-Setup-1.0.1.exe.blockmap` and `latest.yml`.
3. Publish it. Installed apps pick it up on launch (and every 4 hours) and show "Restart to update".

Or set a `GH_TOKEN` environment variable (GitHub token with repo access) and run `npm run release` to build and upload in one go.
