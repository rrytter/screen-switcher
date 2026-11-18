# CLAUDE.md

Screen Switcher: a small Electron app (Windows only) that applies display **scenes** from global shortcuts, the notification-area icon or external launchers. A scene can enable/disable displays and set the primary display, the default audio output and the monitors' input source (DDC/CI).

**Language rules.** Everything code-related is in **English**: code, comments, error messages, README, this file, commit messages. French exists only as an in-app localization. User-facing texts go through `src/i18n.js` (`t(key, params)`, a UMD module shared by main / renderer / plugin; `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` in index.html). English is the default; French is used when Windows is in French. The effective language comes from `settings.language` (system / en / fr, Settings window), applied by `applyLang()` in main and passed to the renderer as `state.lang` (the window reloads when it changes); the plugin follows it for its key labels. Add every new text in both languages; French texts use the formal *vous*.

## Commands

```bash
npm install
npm start          # electron . from source
npm run dist       # NSIS installer (per user, unsigned) in dist/; publish through a GitHub release
node --check src/main.js renderer/app.js   # no automated tests; at least check syntax
npm run icons      # regenerates assets/icon-*.png and icon.ico from assets/src/*.svg (icon-small.svg for 16–32 px)
```

Test instance separate from the installed app (otherwise the single-instance lock wakes the installed one): `SS_USER_DATA=<folder> electron . --lang=en-US` (`--lang` forces the system language).

After changing `src/` or `native/`, **restart the app** (Ctrl+R reloads only the renderer, not the native helper nor `main.js`). The app is single-instance: kill the running process first:

```powershell
Get-Process electron | ? { $_.Path -like '*screen-switcher*' } | Stop-Process -Force
```

Useful logs are on stdout: `[shortcuts] …` (shortcut status at startup) and `[apply] <scene> {sent, skipped, savedModes}`.

## Architecture

| File | Role |
|---|---|
| `src/main.js` | main process: tray, shortcuts (`globalShortcut`), config, applying scenes, autostart, Start menu shortcut, language |
| `src/native.js` | JSON-lines bridge (stdin/stdout) to the persistent PowerShell helper |
| `src/profiles.js` | DDC codes of non-standard monitors; loaded by `require` (main) **and** `<script>` (renderer) |
| `src/i18n.js` | English / French strings; UMD shared by main, renderer and plugin (types in `i18n.d.ts`) |
| `src/scene-icons.js` | scene tiles (SVG drawings, colors, `lookOf`, `tileSvg`); UMD shared by the renderer **and** the Stream Deck plugin (imported by rollup, types in `scene-icons.d.ts`) |
| `src/preload.js` | `window.api` exposed to the renderer (contextIsolation) |
| `native/helper.ps1` | request loop; compiles `Native.cs` (Add-Type) once at startup |
| `native/Native.cs` | Windows interop: CCD API (`QueryDisplayConfig`/`SetDisplayConfig`), audio (`IPolicyConfig`, undocumented COM), DDC/CI (`dxva2`) |
| `renderer/` | scene editor (vanilla HTML/CSS/JS, no framework or bundler); gray theme, purple accent; icons in `ui-icons.js` (`data-icon` on an element); `wizard.js` = input wizard |

Scene triggers: global shortcut, tray menu, double-click in the list, `--scene "<name>"` argument or `screenswitcher://scene/<name>` link (protocol registered at startup; single instance → `second-instance` forwards argv to the running app). Lookup by id, then by normalized name (case/accents ignored).

Order in which a scene is applied (in `helper.ps1`): **enable displays → primary display → disable displays → audio → DDC inputs**. The HDMI audio of a just-enabled display takes ~1–2 s to appear: the helper waits.

User config: `%APPDATA%\screen-switcher\config.json` (scenes, display names, `settings`, `lastInputs`, `displayModes`, `devicePaths`, `inputProfiles`). Never commit it.

## Input wizard (`renderer/wizard.js`)

Standard MCCS codes are used for any monitor without a profile. The wizard sends a code (helper command `probe`: SetInput, wait 2.5 s, GetInput) and the user says what the monitor shows. "Nothing changed" is ambiguous (code ignored, or input already shown): such codes are re-checked from another input. Result = `config.inputProfiles[model]` (`inputs`, `readBack`, bilingual `note`), which wins over `MODEL_PROFILES` through `profileFor()`; no profile is saved if everything is standard. The window must not sit on the tested display (`window-on-monitor` / `window-move-away`, rectangles in physical pixels via `screen.dipToScreenRect`).

## Identifying displays

- `hwId` (`MONITOR\ACR080E\{…}\0003`): active displays, via `EnumDisplayDevices`.
- `devicePath` (`\\?\DISPLAY#BNQ4D03#…`): stable CCD identifier, **the only one available for a disabled display** (it no longer has a `\\.\DISPLAYn`). `config.devicePaths` stores hwId → devicePath.
- `\\.\DISPLAYn` changes with the configuration: always resolve it when applying (`resolveRef` in main, `Resolve-Gdi` in the helper).

## Stream Deck plugin (`streamdeck/plugin/`)

Separate project (TypeScript, `@elgato/streamdeck` SDK v3, rollup, official `@elgato/cli` template), UUID `com.rrytter.screenswitcher`. It does not talk to the app: it **reads and watches `%APPDATA%\screen-switcher\config.json`** (scenes, `lastSceneId`, `settings.language`) and triggers scenes through `screenswitcher://scene/<id>` (rundll32 `url.dll,FileProtocolHandler`). No ⚠ alert when the config is rewritten with `lastSceneId` equal to the requested scene: don't remove the `saveConfig()` after a scene in main. Key images are generated as SVG (`src/icons.ts`) and sent as a `data:image/svg+xml;base64,…` URL (raw SVG is silently ignored); `setImage` is ignored when the user set a custom image. Manifest strings are English; `fr.json` localizes them. The property inspector (`ui/scene.html`) writes its markup in the system language before the sdpi components load. After `npm run build`: `npx streamdeck restart com.rrytter.screenswitcher` (often has no visible effect: then kill the `node.exe` process whose command line contains `rrytter.screenswitcher`; Stream Deck restarts it within 2 s); a newly linked plugin is only detected when the Stream Deck software restarts. Logs: `%APPDATA%\Elgato\StreamDeck\logs\com.rrytter.screenswitcher0.log` and `StreamDeck.log`.

## Packaged app

- `native/` and `assets/` are extracted from the asar (`asarUnpack`): PowerShell must run `helper.ps1` and Windows must read `icon.ico` from disk. In main, use `UNPACKED` for these paths.
- `userData` is forced to `%APPDATA%\screen-switcher` (otherwise the "Screen Switcher" `productName` would change the folder and lose the config).
- electron-builder `appId` = AUMID `ScreenSwitcher.App` (Start menu shortcut, icon, notifications).
- Install folder: `%LOCALAPPDATA%\Programs\screen-switcher` (one-click per-user NSIS, no folder choice).
- Testing without installing: `dist\win-unpacked\Screen Switcher.exe` (it re-registers the shortcut and protocol to its own exe: run `npm start` again afterwards).

## Known pitfalls (tested by hand, don't "fix")

- `EnumDisplayDevices(output, 0)` can return a former monitor of that output (e.g. a disabled projector) instead of the connected one: `Display.List` picks the active monitor whose model matches the output's CCD path.
- **Acer ED270U P (ACR080E) doesn't follow MCCS** for VCP 0x60: writing `0x11`/`0x12` → DisplayPort, `0x01`/`0x0F`/`0x10` → HDMI 2 port, **HDMI 1 unreachable** (0x00–0xFF scanned). Reading: DP = `0x0F`, HDMI 1 = `0x12`, HDMI 2 = `0x11`. Everything is in `src/profiles.js` (`readBack`).
- The input **read back** is unreliable right after a switch (stale value / no answer for a few seconds). A DDC command is skipped only if the read value matches **and** `lastInputs` (last value sent by the app) is the same.
- `ChangeDisplaySettingsEx` fails (-1) when repositioning several displays: use the CCD API.
- Re-enabling a display with "invalid" modes lets Windows choose (e.g. 60 Hz instead of the projector's 59.94 Hz): when disabling, the exact path + modes are stored (`displayModes`, base64) and reused.
- Taskbar icon: when run from source, Windows shows `electron.exe`'s icon unless a Start menu shortcut carries the same AppUserModelID (`ScreenSwitcher.App`) → created by `ensureStartMenuShortcut()`. Windows caches the icon per AUMID: change the AUMID if the icon stays wrong. Also check that no other Start menu .lnk carries the same AUMID (an icon-less `Electron.lnk` to the dev electron.exe, created during development, won over the installed build); the taskbar cache is only cleared when Explorer restarts.
- Autostart: `Screen Switcher` value under `HKCU\…\Run`, written via `reg` (Electron's `getLoginItemSettings` only finds an entry by AUMID).
- `native/helper.ps1` must stay **UTF-8 with BOM** (otherwise Windows PowerShell 5.1 reads non-ASCII characters as ANSI). `Native.cs` is read explicitly as UTF-8.
- In PowerShell, don't name a function `R` (alias of `Invoke-History`).
- **When launched from Claude Desktop (an MSIX app), a process runs inside its container**: `%APPDATA%` / HKCU writes are redirected to `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\…`. An app launched that way (`npm start`, `Start-Process`) gets its own config, invisible to the Stream Deck plugin and to the app the user launches. Fine for testing; for real use the user launches the app (Start menu).

## Verifying a change

No tests: run the app and check for real. Commands change the user's display setup (primary display, displays turned off, inputs): warn before triggering a scene that switches an input (e.g. to the laptop), and restore the initial state after a test. To see the current state without the UI:

```powershell
'{"id":1,"cmd":"list","ddc":false}' | powershell -NoProfile -ExecutionPolicy Bypass -File native\helper.ps1
```

## Git

GitHub repository `rrytter/screen-switcher`. The commit email is the GitHub noreply address (local repo config): GitHub rejects pushes using the private address.
