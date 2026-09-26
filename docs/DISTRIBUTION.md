# Distribution

One codebase produces three builds. Store integrations sit behind the
`Storefront` trait (`src-tauri/src/storefront/`), so feature code never imports
a store SDK.

| Build | How | Updates | Payments |
| --- | --- | --- | --- |
| **Direct** (ezyappco.com/ePet) | `npx tauri build` (default `direct` feature) → MSI/NSIS, DMG | `tauri-plugin-updater` feed on the website (to add before launch) | License keys + subscription through a merchant of record (Paddle / Lemon Squeezy) |
| **Steam** | `npx tauri build --no-bundle --features steam` then `node scripts/steam-depot.mjs` → `build/steam-depot/` | Steam | Steam microtransactions for in-app purchases in the Steam build |
| **Epic** | `npx tauri build --features epic` | Epic launcher | Epic allows third-party payments, so web billing can be reused |

CI (`.github/workflows/ci.yml`) builds the direct installers for Windows and
macOS and a Windows Steam depot on every push.

## Renaming the product

Edit [`product.config.json`](../product.config.json) (`productName`, `identifier`,
`publisher`, `website`). `npm run product` (run automatically by `dev` and
`build`) copies it into `src-tauri/tauri.conf.json`, and the UI reads it
directly. **The bundle identifier must be final before the first store upload.**
It also names the data folder, so changing it later orphans users' to-dos.

## Steam

- Development: create `steam_appid.txt` containing `480` (Valve's Spacewar test app) next to the executable and keep Steam running. Without Steam the build falls back to local achievements.
- Achievement API names in Steamworks must match our ids (e.g. `safe_landing_win`).
- **Workshop**: user characters are data-only folders (`character.json` + images). Subscribed Workshop items can be mounted into the same characters folder the panel opens.
- Overlay: the pet window is transparent and always on top. Check that the overlay doesn't attach to it, and disable the overlay for the app if it does.
- Windows needs the WebView2 runtime (built into Windows 11). Add it as a Steam redistributable for older Windows 10 installs.
- macOS Steam builds need `libsteam_api.dylib` in `Contents/Frameworks`. Still to do: add it via `bundle.macOS.frameworks` in a Steam-specific Tauri config.

## Epic

The `epic` flavour compiles and runs with local achievements. Still to do: EOS
SDK integration (Auth, Achievements, Ecom) after registering in the Epic
Developer Portal.

## Code signing (direct build)

- **Windows**: Azure Trusted Signing or an OV/EV certificate, so SmartScreen doesn't warn. Configure `bundle.windows` signing in CI secrets.
- **macOS**: Developer ID Application certificate plus notarization (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for `tauri build`). The app uses `macOSPrivateApi` for transparent windows, so it is **not** eligible for the Mac App Store. That's fine for Steam, Epic and the direct build.

## Monetisation shape (proposal)

A paid base app, character packs and skins as DLC (`Storefront::owns_dlc`),
coins from mini-games to unlock cosmetics, and an optional account-based LLM
subscription that works across all storefronts.
