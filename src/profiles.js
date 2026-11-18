// Monitors whose firmware does not follow the MCCS standard for the input source (VCP 0x60).
// Shared by the main process (require) and the UI (<script>, window.MODEL_PROFILES).
(function (root) {
  const MODEL_PROFILES = {
    // Acer ED270U P, tested code by code on 2026-11-17:
    //  - write: 0x11/0x12 → DisplayPort; 0x01/0x0F/0x10 → HDMI 2 port; HDMI 1 unreachable (0x00–0xFF)
    //  - lecture  : DP = 0x0F, HDMI 1 = 0x12, HDMI 2 = 0x11
    ACR080E: {
      inputs: [[0x11, 'DisplayPort'], [0x0f, 'HDMI 2']],
      // written code → value read back when the monitor is actually on that input
      readBack: { 0x11: 0x0f, 0x12: 0x0f, 0x0f: 0x11, 0x10: 0x11, 0x01: 0x11 },
      note: { en: 'HDMI 1 not controllable (Acer firmware)', fr: 'HDMI 1 non pilotable (firmware Acer)' },
    },
  };

  // Profile of a model: the one found by the wizard (config.inputProfiles) wins over MODEL_PROFILES
  function profileFor(model, learned) {
    return (learned && learned[model]) || MODEL_PROFILES[model] || null;
  }

  // Value the monitor reports once on the requested input (standard: same as the written code)
  function expectedRead(model, value, learned) {
    const p = profileFor(model, learned);
    return p && p.readBack && p.readBack[value] !== undefined ? p.readBack[value] : value;
  }

  const api = { MODEL_PROFILES, profileFor, expectedRead };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
