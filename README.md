# Screen Switcher

Petit outil Windows (Electron) qui applique des **scènes** d'affichage depuis un raccourci clavier global ou l'icône de la zone de notification :

- **activer / désactiver un écran** (ex. couper la sortie HDMI du projecteur) ; à la réactivation, la résolution, la fréquence et la position mémorisées à la désactivation sont restaurées ;
- **écran principal** (API Windows CCD `SetDisplayConfig`, disposition et fréquences conservées) ;
- **sortie audio par défaut** (les 3 rôles Windows) ;
- **source d'entrée de chaque écran** par DDC/CI (code VCP `0x60`), par exemple DisplayPort / HDMI 1 / HDMI 2.

Les commandes inutiles sont évitées (écran déjà principal, déjà actif/inactif, source ou audio déjà en place).

## Lancer

```bash
npm install
npm start
```

Fermer la fenêtre la réduit dans la zone de notification ; « Quitter » est dans le menu de l'icône.
Option « Lancer au démarrage de Windows » dans la fenêtre : valeur `Screen Switcher` dans `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (démarre caché, avec `--hidden`).

Au lancement, l'app crée/met à jour le raccourci `Screen Switcher` du menu Démarrer (AppUserModelID `ScreenSwitcher.App`) : c'est lui qui donne la bonne icône dans la barre des tâches et les notifications, même lancé depuis le code source.

Si le dossier du projet est déplacé, relancer l'app une fois à la main puis décocher/recocher le démarrage automatique.

## Structure

| Fichier | Rôle |
|---|---|
| `src/main.js` | process principal : tray, raccourcis globaux, scènes, config |
| `src/native.js` | pont JSON-lignes vers le helper PowerShell persistant |
| `src/profiles.js` | codes DDC des écrans non standard (partagé main / interface) |
| `native/helper.ps1` | boucle stdin/stdout, compile `Native.cs` une fois au démarrage |
| `native/Native.cs` | interop Windows (écrans, audio IPolicyConfig, DDC/CI dxva2) |
| `renderer/` | interface d'édition |

La configuration est dans `%APPDATA%\screen-switcher\config.json`. Les écrans y sont repérés par leur ID matériel (`MONITOR\ACR080E\…`), donc un changement de numéro `DISPLAYn` ne casse pas les scènes.

## Codes d'entrée DDC courants

`0x0F` DisplayPort 1 · `0x10` DisplayPort 2 · `0x11` HDMI 1 · `0x12` HDMI 2 · `0x1B` USB-C · `0x03` DVI · `0x01` VGA.
La liste annoncée par l'écran (✓ dans l'interface) est souvent incomplète ou fausse.

**Acer ED270U P (ACR080E), testé le 2026-11-17** : firmware non standard, géré par `MODEL_PROFILES` dans `src/profiles.js`.
- Écriture : `0x11` ou `0x12` → DisplayPort ; `0x01`, `0x0F` ou `0x10` → port **HDMI 2**. Le port **HDMI 1 n'est joignable par aucun code** (0x00–0xFF balayés).
- Lecture : DP = `0x0F`, HDMI 1 = `0x12`, HDMI 2 = `0x11`.
- Donc : brancher l'appareil à piloter (laptop) sur **HDMI 2**, et ce qu'on sélectionne rarement (Switch 2) sur HDMI 1.
La source « actuelle » lue sur un écran qui affiche un autre appareil peut être fausse ; l'envoi de la commande fonctionne quand même.
Pense à désactiver la détection automatique de source dans le menu de l'écran, sinon il peut rebasculer seul.
