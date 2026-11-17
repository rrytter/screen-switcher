# CLAUDE.md

Screen Switcher : petite app Electron (Windows uniquement) qui applique des **scènes** d'affichage depuis des raccourcis globaux ou l'icône de la zone de notification. Une scène peut : activer/désactiver des écrans, choisir l'écran principal, la sortie audio par défaut et la source d'entrée des écrans (DDC/CI).

Interface, commentaires et messages en **français**.

## Commandes

```bash
npm install
npm start          # electron . (pas de build : l'app tourne depuis le code source)
node --check src/main.js renderer/app.js   # pas de tests automatisés ; au minimum vérifier la syntaxe
```

Après une modification de `src/` ou `native/`, il faut **redémarrer l'app** (le renderer seul se recharge avec Ctrl+R, mais le helper natif et `main.js` non). L'app est mono-instance : tuer d'abord le process existant :

```powershell
Get-Process electron | ? { $_.Path -like '*screen-switcher*' } | Stop-Process -Force
```

Les logs utiles sont sur stdout : `[shortcuts] …` (état des raccourcis au démarrage) et `[apply] <scène> {sent, skipped, savedModes}`.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/main.js` | process principal : tray, raccourcis (`globalShortcut`), config, application des scènes, démarrage auto, raccourci menu Démarrer |
| `src/native.js` | pont JSON-lignes (stdin/stdout) vers le helper PowerShell persistant |
| `src/profiles.js` | codes DDC des écrans non standard ; chargé par `require` (main) **et** `<script>` (renderer) |
| `src/preload.js` | `window.api` exposé au renderer (contextIsolation) |
| `native/helper.ps1` | boucle de requêtes ; compile `Native.cs` (Add-Type) une seule fois au démarrage |
| `native/Native.cs` | interop Windows : API CCD (`QueryDisplayConfig`/`SetDisplayConfig`), audio (`IPolicyConfig`, COM non documenté), DDC/CI (`dxva2`) |
| `renderer/` | éditeur de scènes (HTML/CSS/JS vanilla, pas de framework ni de bundler) |

Déclencheurs d'une scène : raccourci global, menu du tray, double-clic dans la liste, argument `--scene "<nom>"` ou lien `screenswitcher://scene/<nom>` (protocole enregistré au démarrage ; instance unique → `second-instance` transmet l'argv à l'app déjà lancée). Recherche par id puis par nom normalisé (casse/accents).

Ordre d'application d'une scène (dans `helper.ps1`) : **activer écrans → écran principal → désactiver écrans → audio → sources DDC**. L'audio HDMI d'un écran qui vient d'être activé met ~1–2 s à apparaître : le helper attend.

Config utilisateur : `%APPDATA%\screen-switcher\config.json` (scènes, noms d'écrans, `lastInputs`, `displayModes`, `devicePaths`). Ne pas la versionner.

## Identifier les écrans

- `hwId` (`MONITOR\ACR080E\{…}\0003`) : écrans actifs, via `EnumDisplayDevices`.
- `devicePath` (`\\?\DISPLAY#BNQ4D03#…`) : identifiant CCD stable, **seul disponible pour un écran désactivé** (il n'a plus de `\\.\DISPLAYn`). `config.devicePaths` mémorise hwId → devicePath.
- `\\.\DISPLAYn` change selon la config : toujours le résoudre au moment d'appliquer (`resolveRef` dans main, `Resolve-Gdi` dans le helper).

## Pièges connus (testés à la main, ne pas « corriger »)

- **Acer ED270U P (ACR080E) ne suit pas MCCS** pour VCP 0x60 : en écriture `0x11`/`0x12` → DisplayPort, `0x01`/`0x0F`/`0x10` → port HDMI 2, **HDMI 1 injoignable** (0x00–0xFF balayés). En lecture : DP = `0x0F`, HDMI 1 = `0x12`, HDMI 2 = `0x11`. Tout est dans `src/profiles.js` (`readBack`).
- La source **lue** est peu fiable juste après une bascule (valeur périmée / pas de réponse quelques secondes). On ne saute une commande DDC que si la lecture correspond **et** que `lastInputs` (dernière valeur envoyée par l'app) est identique.
- `ChangeDisplaySettingsEx` échoue (-1) pour repositionner plusieurs écrans : utiliser l'API CCD.
- Réactiver un écran avec des modes « invalides » laisse Windows choisir (ex. 60 Hz au lieu des 59,94 Hz voulus pour le projecteur) : à la désactivation on mémorise le chemin + modes exacts (`displayModes`, base64) et on les réutilise.
- Icône de barre des tâches : lancé depuis le code source, Windows affiche celle d'`electron.exe` sauf si un raccourci du menu Démarrer porte le même AppUserModelID (`ScreenSwitcher.App`) → créé par `ensureStartMenuShortcut()`. Windows met l'icône en cache par AUMID : changer d'AUMID si l'icône reste fausse.
- Démarrage auto : valeur `Screen Switcher` sous `HKCU\…\Run`, écrite via `reg` (le `getLoginItemSettings` d'Electron ne retrouve une entrée que par l'AUMID).
- `native/helper.ps1` doit rester en **UTF-8 avec BOM** (Windows PowerShell 5.1 lit sinon les accents en ANSI). `Native.cs` est lu explicitement en UTF-8.
- En PowerShell, ne pas nommer une fonction `R` (alias de `Invoke-History`).

## Vérifier un changement

Pas de tests : lancer l'app et vérifier réellement. Les commandes changent l'affichage de l'utilisateur (écran principal, écrans éteints, sources) : prévenir avant de déclencher une scène qui bascule une source (ex. vers le laptop), et revenir à l'état de départ après un test. Pour l'état courant sans l'UI :

```powershell
'{"id":1,"cmd":"list","ddc":false}' | powershell -NoProfile -ExecutionPolicy Bypass -File native\helper.ps1
```

## Git

Repo privé GitHub `rrytter/screen-switcher`. L'e-mail de commit est l'adresse noreply GitHub (config locale du repo) : GitHub refuse les push avec l'adresse privée.
