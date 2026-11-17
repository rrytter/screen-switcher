# Screen Switcher

Petit outil Windows qui applique des **scènes** d'affichage d'un raccourci clavier, d'un clic dans la zone de notification ou depuis un lanceur externe (pavé de touches programmables, script…). Pensé pour le télétravail : un PC perso et un laptop pro qui partagent les mêmes écrans, un projecteur, une console…

Une scène peut :

- **activer / désactiver un écran** (ex. couper la sortie HDMI du projecteur) ; à la réactivation, résolution, fréquence et position sont restaurées ;
- choisir l'**écran principal** (disposition et fréquences conservées) ;
- choisir la **sortie audio par défaut** ;
- changer la **source d'entrée de chaque écran** (DisplayPort / HDMI…) par DDC/CI, pour passer les écrans du PC au laptop sans toucher aux boutons des écrans.

Les commandes inutiles sont évitées (écran déjà principal, déjà actif/inactif, source ou audio déjà en place).

## Installation

1. Télécharger `Screen-Switcher-Setup-<version>.exe` dans les [Releases](../../releases).
2. Le lancer. L'installateur n'est pas signé : Windows SmartScreen affiche « Windows a protégé votre ordinateur » → **Informations complémentaires** → **Exécuter quand même**.
3. L'installation se fait pour l'utilisateur courant (pas de droits admin), dans `%LOCALAPPDATA%\Programs\Screen Switcher`. Désinstallation : Paramètres → Applications.

L'app vit dans la zone de notification (icône bleue). Fermer la fenêtre ne la quitte pas ; « Quitter » est dans le menu de l'icône. Cocher **« Lancer au démarrage de Windows »** pour que les raccourcis marchent dès l'ouverture de session.

**Prérequis** : Windows 10/11, PowerShell 5.1 (intégré à Windows). Sur un **PC d'entreprise verrouillé** (AppLocker, PowerShell en mode restreint), le moteur de l'app peut être bloqué : l'installer plutôt sur le PC perso, auquel les écrans sont reliés.

## Premiers pas

1. **+ Nouvelle scène**, lui donner un nom.
2. **Raccourci clavier** : cliquer sur le champ puis taper la combinaison (ex. Ctrl+Alt+F1).
3. **Écrans** : pour chaque écran, choisir s'il faut l'activer/désactiver, s'il devient principal, et sa source d'entrée.
4. **Sortie audio** si besoin, puis **Enregistrer et appliquer**.

Glisser-déposer dans la liste pour réordonner les scènes.

## Compatibilité des écrans (source d'entrée)

Écran principal, activation/désactivation et audio passent par Windows et marchent avec **tous les écrans**. Le changement de **source d'entrée** dépend de l'écran :

- il faut que **DDC/CI soit activé** dans le menu (OSD) de l'écran (souvent activé par défaut) ;
- les écrans de laptop, les télés et les projecteurs ne le gèrent généralement pas ;
- certains docks / hubs (notamment **DisplayLink**) ne transmettent pas le DDC/CI ; un câble direct DP/HDMI/USB-C vers le PC fonctionne ;
- couper la **détection automatique de source** dans le menu de l'écran, sinon il peut rebasculer seul dès qu'un appareil s'allume ;
- beaucoup d'écrans **n'utilisent pas les codes standard** (voir ci-dessous).

### Trouver les bons codes de son écran

Dans une scène, choisir une source dans la liste puis cliquer **Tester** : le code est envoyé immédiatement. Si l'écran ne bascule pas sur la bonne entrée, essayer les autres valeurs, ou « Autre (code hexa)… ». Le PC garde la main même quand l'écran affiche une autre source : on peut toujours revenir avec le code qui mène au PC.

Codes standard (norme MCCS) : `0x0F` DisplayPort 1 · `0x10` DisplayPort 2 · `0x11` HDMI 1 · `0x12` HDMI 2 · `0x1B` USB-C · `0x03` DVI · `0x01` VGA. Les entrées marquées ✓ sont celles que l'écran annonce (liste souvent incomplète ou fausse).

Un écran non standard dont on a trouvé les codes peut être ajouté à `MODEL_PROFILES` dans `src/profiles.js` (le code modèle, ex. `ACR080E`, est affiché sous le nom de l'écran). Les retours sont bienvenus via les issues.

**Acer ED270U P (ACR080E)**, testé : écriture `0x11`/`0x12` → DisplayPort ; `0x01`/`0x0F`/`0x10` → port **HDMI 2** ; le port **HDMI 1 n'est joignable par aucun code**. Brancher l'appareil à piloter (laptop) sur HDMI 2.

## Lanceurs

Chaque scène peut aussi se lancer sans raccourci clavier, depuis n'importe quel outil capable d'ouvrir un lien ou d'exécuter un programme (boutons « Copier le lien » / « Copier la commande » dans l'éditeur) :

| Type de lanceur | Valeur |
|---|---|
| ouvre un lien | `screenswitcher://scene/Projecteur` |
| exécute un programme | `"…\Screen Switcher.exe" --scene "Projecteur"` |

Les touches programmables d'un clavier ou d'une souris peuvent aussi simplement envoyer le raccourci clavier de la scène.

La scène est retrouvée par son nom (casse et accents ignorés) : renommer une scène casse les touches qui l'appellent.

## Développement

```bash
npm install
npm start          # depuis le code source
npm run dist       # installateur dans dist/
```

| Fichier | Rôle |
|---|---|
| `src/main.js` | process principal : tray, raccourcis globaux, scènes, config, démarrage auto |
| `src/native.js` | pont JSON-lignes vers le helper PowerShell persistant |
| `src/profiles.js` | codes DDC des écrans non standard (partagé main / interface) |
| `native/helper.ps1` | boucle stdin/stdout, compile `Native.cs` une fois au démarrage |
| `native/Native.cs` | interop Windows : API CCD, audio `IPolicyConfig`, DDC/CI `dxva2` |
| `renderer/` | interface d'édition (HTML/CSS/JS sans framework) |

Configuration : `%APPDATA%\screen-switcher\config.json` (partagée entre la version installée et `npm start`). Voir `CLAUDE.md` pour les détails techniques et les pièges connus.

Version de dev et version installée enregistrent toutes deux le raccourci du menu Démarrer, le lien `screenswitcher://` et l'entrée de démarrage auto : c'est la dernière lancée qui gagne. N'en garder qu'une au quotidien.
