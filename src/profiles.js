// Écrans dont le firmware ne suit pas la norme MCCS pour la source d'entrée (VCP 0x60).
// Partagé entre le process principal (require) et l'interface (<script>, window.MODEL_PROFILES).
(function (root) {
  const MODEL_PROFILES = {
    // Acer ED270U P, testé code par code le 2026-11-17 :
    //  - écriture : 0x11/0x12 → DisplayPort ; 0x01/0x0F/0x10 → port HDMI 2 ; HDMI 1 injoignable (0x00–0xFF)
    //  - lecture  : DP = 0x0F, HDMI 1 = 0x12, HDMI 2 = 0x11
    ACR080E: {
      inputs: [[0x11, 'DisplayPort'], [0x0f, 'HDMI 2']],
      // code écrit → valeur lue quand l'écran est effectivement sur cette source
      readBack: { 0x11: 0x0f, 0x12: 0x0f, 0x0f: 0x11, 0x10: 0x11, 0x01: 0x11 },
      note: 'HDMI 1 non pilotable (firmware Acer)',
    },
  };

  // Profil d'un modèle : celui trouvé par l'assistant (config.inputProfiles) prime sur MODEL_PROFILES
  function profileFor(model, learned) {
    return (learned && learned[model]) || MODEL_PROFILES[model] || null;
  }

  // Valeur que l'écran annonce une fois sur la source demandée (norme : identique au code écrit)
  function expectedRead(model, value, learned) {
    const p = profileFor(model, learned);
    return p && p.readBack && p.readBack[value] !== undefined ? p.readBack[value] : value;
  }

  const api = { MODEL_PROFILES, profileFor, expectedRead };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
