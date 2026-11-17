// Interop Windows : écrans (CCD), audio (IPolicyConfig) et DDC/CI (dxva2).
// Compilé à la volée par helper.ps1 (Add-Type), aucune dépendance externe.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ScreenSwitcher {

  // ======================= Audio =======================
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out int n); int Item(int i, out IMMDevice d); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int c); int GetAt(int i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
  }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT {
    [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2;
  }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}
  [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(); int GetDeviceFormat(); int ResetDeviceFormat(); int SetDeviceFormat();
    int GetProcessingPeriod(); int SetProcessingPeriod(); int GetShareMode(); int SetShareMode();
    int GetPropertyValue(); int SetPropertyValue();
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  }

  public class AudioDevice { public string id; public string name; public bool isDefault; }

  public static class Audio {
    static string Name(IMMDevice d) {
      IPropertyStore ps; d.OpenPropertyStore(0, out ps);
      var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PROPVARIANT v; ps.GetValue(ref key, out v);
      return Marshal.PtrToStringUni(v.p);
    }
    public static List<AudioDevice> List() {
      var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      string defId = null;
      IMMDevice def;
      if (e.GetDefaultAudioEndpoint(0, 1, out def) == 0) def.GetId(out defId);
      IMMDeviceCollection c; e.EnumAudioEndpoints(0, 1, out c);   // eRender, DEVICE_STATE_ACTIVE
      int n; c.GetCount(out n);
      var r = new List<AudioDevice>();
      for (int i = 0; i < n; i++) {
        IMMDevice d; c.Item(i, out d); string id; d.GetId(out id);
        r.Add(new AudioDevice { id = id, name = Name(d), isDefault = id == defId });
      }
      return r;
    }
    public static void SetDefault(string id) {
      var p = (IPolicyConfig)new PolicyConfigClient();
      for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(p.SetDefaultEndpoint(id, role));
    }
  }

  // ======================= Écrans =======================
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency,
      dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  public class MonitorInfo {
    public string device; public string hwId; public string model; public string devicePath; public bool primary;
    public int x, y, width, height, hz;
    public bool ddc; public string ddcCaps; public int[] ddcInputs; public int currentInput;
  }

  public class TargetInfo { public string devicePath; public string name; public bool active; public string device; }

  public static class Display {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, int i, ref DISPLAY_DEVICE dd, int flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);

    // ---- DDC/CI ----
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PHYS { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string d; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONINFO { public int cb; public int l, t, r, b, wl, wt, wr, wb; public int f; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dev; }
    delegate bool MonEnum(IntPtr hMon, IntPtr hdc, IntPtr r, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonEnum cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h, ref MONINFO mi);
    [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, out uint n);
    [DllImport("dxva2.dll", CharSet = CharSet.Unicode)] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYS[] a);
    [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PHYS[] a);
    [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr t, out uint cur, out uint max);
    [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte code, uint val);
    [DllImport("dxva2.dll")] static extern bool GetCapabilitiesStringLength(IntPtr h, out uint len);
    [DllImport("dxva2.dll", CharSet = CharSet.Ansi)] static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr h, StringBuilder s, uint len);

    // Exécute fn(handle physique) pour l'écran GDI donné (\\.\DISPLAYn)
    static bool WithPhysical(string device, Action<IntPtr> fn) {
      bool found = false;
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hm, a, b, c) => {
        var mi = new MONINFO(); mi.cb = Marshal.SizeOf(mi); GetMonitorInfo(hm, ref mi);
        if (!string.Equals(mi.dev, device, StringComparison.OrdinalIgnoreCase)) return true;
        uint n; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) return false;
        var pm = new PHYS[n];
        if (GetPhysicalMonitorsFromHMONITOR(hm, n, pm)) { found = true; try { fn(pm[0].h); } finally { DestroyPhysicalMonitors(n, pm); } }
        return false;
      }, IntPtr.Zero);
      return found;
    }

    static int[] ParseInputs(string caps) {
      var r = new List<int>();
      int i = caps.IndexOf(" 60(", StringComparison.Ordinal);
      if (i < 0) i = caps.IndexOf("(60(", StringComparison.Ordinal);
      if (i < 0) return r.ToArray();
      int s = caps.IndexOf('(', i + 1) + 1, e = caps.IndexOf(')', s);
      if (s <= 0 || e < 0) return r.ToArray();
      foreach (var tok in caps.Substring(s, e - s).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        int v; if (int.TryParse(tok, System.Globalization.NumberStyles.HexNumber, null, out v)) r.Add(v);
      }
      return r.ToArray();
    }

    public static List<MonitorInfo> List(bool withDdc) {
      var r = new List<MonitorInfo>();
      var gdiToPath = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      try { foreach (var t in ListTargets()) if (t.active && t.device != null) gdiToPath[t.device] = t.devicePath; } catch { }
      for (int i = 0; ; i++) {
        var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(dd);
        if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
        if ((dd.StateFlags & 1) == 0) continue;                       // non attaché au bureau
        var mon = new DISPLAY_DEVICE(); mon.cb = Marshal.SizeOf(mon);
        bool ok = EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0);
        var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
        EnumDisplaySettings(dd.DeviceName, -1, ref dm);
        string hw = ok ? mon.DeviceID : "";
        string model = "";
        var parts = hw.Split('\\'); if (parts.Length > 1) model = parts[1];
        var m = new MonitorInfo {
          device = dd.DeviceName, hwId = hw, model = model, primary = (dd.StateFlags & 4) != 0,
          devicePath = gdiToPath.ContainsKey(dd.DeviceName) ? gdiToPath[dd.DeviceName] : null,
          x = dm.dmPositionX, y = dm.dmPositionY, width = dm.dmPelsWidth, height = dm.dmPelsHeight, hz = dm.dmDisplayFrequency,
          ddcInputs = new int[0], ddcCaps = "", currentInput = -1
        };
        if (withDdc) {
          WithPhysical(dd.DeviceName, h => {
            uint cur, max;
            if (GetVCPFeatureAndVCPFeatureReply(h, 0x60, IntPtr.Zero, out cur, out max)) { m.ddc = true; m.currentInput = (int)cur; }
            uint len;
            if (GetCapabilitiesStringLength(h, out len) && len > 0) {
              var sb = new StringBuilder((int)len);
              if (CapabilitiesRequestAndCapabilitiesReply(h, sb, len)) { m.ddcCaps = sb.ToString(); m.ddc = true; m.ddcInputs = ParseInputs(m.ddcCaps); }
            }
          });
        }
        r.Add(m);
      }
      return r;
    }

    // Source annoncée par l'écran (VCP 0x60), -1 si pas de réponse. Quelques essais : le bus DDC est lent.
    public static int GetInput(string device) {
      int r = -1;
      WithPhysical(device, h => {
        for (int t = 0; t < 3 && r < 0; t++) {
          uint cur, max;
          if (GetVCPFeatureAndVCPFeatureReply(h, 0x60, IntPtr.Zero, out cur, out max)) r = (int)(cur & 0xFF); else Thread.Sleep(150);
        }
      });
      return r;
    }

    public static void SetInput(string device, int value) {
      bool done = false;
      bool found = WithPhysical(device, h => {
        for (int t = 0; t < 4 && !done; t++) { done = SetVCPFeature(h, 0x60, (uint)value); if (!done) Thread.Sleep(250); }
      });
      if (!found) throw new Exception("Écran introuvable pour DDC : " + device);
      if (!done) throw new Exception("L'écran " + device + " a refusé la commande DDC");
    }

    // ======================= API CCD (QueryDisplayConfig / SetDisplayConfig) =======================
    // DISPLAYCONFIG_PATH_INFO (72 octets) : source (adaptateur, id, mode) puis cible (adaptateur, id, mode, ..., disponible)
    [StructLayout(LayoutKind.Explicit, Size = 72)] struct PATH {
      [FieldOffset(0)] public uint srcAdapterLow; [FieldOffset(4)] public int srcAdapterHigh;
      [FieldOffset(8)] public uint srcId; [FieldOffset(12)] public uint srcModeIdx;
      [FieldOffset(20)] public uint tgtAdapterLow; [FieldOffset(24)] public int tgtAdapterHigh;
      [FieldOffset(28)] public uint tgtId; [FieldOffset(32)] public uint tgtModeIdx;
      [FieldOffset(60)] public int targetAvailable; [FieldOffset(68)] public uint flags;
    }
    [StructLayout(LayoutKind.Explicit, Size = 64)] struct MODE {
      [FieldOffset(0)] public uint infoType; [FieldOffset(28)] public int x; [FieldOffset(32)] public int y;
    }
    [StructLayout(LayoutKind.Sequential)] struct DI_HEADER { public uint type; public uint size; public uint adapterLow; public int adapterHigh; public uint id; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SOURCE_NAME {
      public DI_HEADER h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string gdi;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TARGET_NAME {
      public DI_HEADER h; public uint flags; public uint outTech; public ushort edidMfg; public ushort edidProd; public uint connector;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string friendly;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string path;
    }
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint nPaths, out uint nModes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint nPaths, [Out] PATH[] paths, ref uint nModes, [Out] MODE[] modes, IntPtr topo);
    [DllImport("user32.dll")] static extern int SetDisplayConfig(uint nPaths, PATH[] paths, uint nModes, MODE[] modes, uint flags);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME r);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TARGET_NAME r);

    const uint QDC_ALL_PATHS = 1, QDC_ONLY_ACTIVE_PATHS = 2, PATH_ACTIVE = 1, MODE_IDX_INVALID = 0xFFFFFFFF;
    const uint SDC_TOPOLOGY_EXTEND = 0x4, SDC_USE_SUPPLIED = 0x20, SDC_APPLY = 0x80, SDC_SAVE = 0x200, SDC_ALLOW_CHANGES = 0x400;

    static void Query(uint flags, out PATH[] paths, out MODE[] modes) {
      uint np, nm;
      int rc = GetDisplayConfigBufferSizes(flags, out np, out nm);
      if (rc != 0) throw new Exception("GetDisplayConfigBufferSizes = " + rc);
      paths = new PATH[np]; modes = new MODE[nm];
      rc = QueryDisplayConfig(flags, ref np, paths, ref nm, modes, IntPtr.Zero);
      if (rc != 0) throw new Exception("QueryDisplayConfig = " + rc);
      Array.Resize(ref paths, (int)np); Array.Resize(ref modes, (int)nm);
    }
    static void Apply(PATH[] paths, MODE[] modes) {
      int rc = SetDisplayConfig((uint)paths.Length, paths, (uint)modes.Length, modes, SDC_APPLY | SDC_USE_SUPPLIED | SDC_SAVE | SDC_ALLOW_CHANGES);
      if (rc != 0) throw new Exception("SetDisplayConfig = " + rc);
    }
    static TARGET_NAME TargetName(PATH p) {
      var t = new TARGET_NAME();
      t.h = new DI_HEADER { type = 2, size = (uint)Marshal.SizeOf(typeof(TARGET_NAME)), adapterLow = p.tgtAdapterLow, adapterHigh = p.tgtAdapterHigh, id = p.tgtId };
      DisplayConfigGetDeviceInfo(ref t);
      return t;
    }
    static string SourceGdi(PATH p) {
      var s = new SOURCE_NAME();
      s.h = new DI_HEADER { type = 1, size = (uint)Marshal.SizeOf(typeof(SOURCE_NAME)), adapterLow = p.srcAdapterLow, adapterHigh = p.srcAdapterHigh, id = p.srcId };
      return DisplayConfigGetDeviceInfo(ref s) == 0 ? s.gdi : null;
    }
    static bool SameTarget(PATH a, PATH b) { return a.tgtAdapterLow == b.tgtAdapterLow && a.tgtAdapterHigh == b.tgtAdapterHigh && a.tgtId == b.tgtId; }

    // Tous les écrans branchés, actifs ou désactivés. devicePath (\\?\DISPLAY#BNQ4D03#...) est l'identifiant stable.
    public static List<TargetInfo> ListTargets() {
      PATH[] paths; MODE[] modes; Query(QDC_ALL_PATHS, out paths, out modes);
      var r = new List<TargetInfo>(); var seen = new List<PATH>();
      foreach (var p in paths) {
        if (p.targetAvailable == 0) continue;
        int k = seen.FindIndex(x => SameTarget(x, p));
        bool active = (p.flags & PATH_ACTIVE) != 0;
        if (k >= 0) { if (active) { r[k].active = true; r[k].device = SourceGdi(p); } continue; }
        var tn = TargetName(p);
        if (string.IsNullOrEmpty(tn.path)) continue;
        seen.Add(p);
        r.Add(new TargetInfo { devicePath = tn.path, name = tn.friendly, active = active, device = active ? SourceGdi(p) : null });
      }
      return r;
    }

    static byte[] ToBytes<T>(T s) where T : struct {
      int n = Marshal.SizeOf(typeof(T)); var b = new byte[n]; IntPtr p = Marshal.AllocHGlobal(n);
      try { Marshal.StructureToPtr(s, p, false); Marshal.Copy(p, b, 0, n); } finally { Marshal.FreeHGlobal(p); }
      return b;
    }
    static T FromBytes<T>(byte[] b, int offset) where T : struct {
      int n = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(n);
      try { Marshal.Copy(b, offset, p, n); return (T)Marshal.PtrToStructure(p, typeof(T)); } finally { Marshal.FreeHGlobal(p); }
    }

    // Active ou désactive un écran (mode étendu).
    // Retour : null si déjà dans l'état demandé ; à la désactivation, le chemin + modes exacts (base64)
    // à repasser dans « saved » à la réactivation pour retrouver résolution, fréquence (ex. 59,94 Hz) et position.
    public static string SetEnabled(string devicePath, bool on, string saved) {
      PATH[] all; MODE[] modes; Query(QDC_ALL_PATHS, out all, out modes);
      var candidates = new List<PATH>();
      foreach (var p in all) if (p.targetAvailable != 0 && string.Equals(TargetName(p).path, devicePath, StringComparison.OrdinalIgnoreCase)) candidates.Add(p);
      if (candidates.Count == 0) throw new Exception("Écran non branché ou introuvable");
      var active = new List<PATH>(); foreach (var p in all) if ((p.flags & PATH_ACTIVE) != 0) active.Add(p);
      bool isOn = active.Exists(a => SameTarget(a, candidates[0]));
      if (isOn == on) return null;

      if (!on) {
        var cur = active.Find(a => SameTarget(a, candidates[0]));
        var rest = active.FindAll(a => !SameTarget(a, candidates[0]));
        if (rest.Count == 0) throw new Exception("Impossible de désactiver le dernier écran actif");
        string blob = "";
        if (cur.srcModeIdx < modes.Length && cur.tgtModeIdx < modes.Length) {
          var b = new List<byte>(ToBytes(cur)); b.AddRange(ToBytes(modes[cur.srcModeIdx])); b.AddRange(ToBytes(modes[cur.tgtModeIdx]));
          blob = Convert.ToBase64String(b.ToArray());
        }
        Apply(rest.ToArray(), modes);
        return blob;
      }
      // 1) réactivation avec le chemin et les modes mémorisés (si la source est libre)
      if (!string.IsNullOrEmpty(saved)) {
        try {
          var b = Convert.FromBase64String(saved);
          var sp = FromBytes<PATH>(b, 0); var sm = FromBytes<MODE>(b, 72); var tm = FromBytes<MODE>(b, 72 + 64);
          bool srcUsed = active.Exists(a => a.srcAdapterLow == sp.srcAdapterLow && a.srcAdapterHigh == sp.srcAdapterHigh && a.srcId == sp.srcId);
          if (!srcUsed && SameTarget(sp, candidates[0])) {
            var newModes = new List<MODE>(modes); newModes.Add(sm); newModes.Add(tm);
            sp.srcModeIdx = (uint)modes.Length; sp.tgtModeIdx = (uint)modes.Length + 1; sp.flags |= PATH_ACTIVE;
            var list = new List<PATH>(active); list.Add(sp);
            Apply(list.ToArray(), newModes.ToArray());
            return "";
          }
        } catch { }
      }
      // 2) sinon un chemin vers cet écran dont la source n'est pas déjà utilisée sur le même adaptateur
      foreach (var c in candidates) {
        if (active.Exists(a => a.srcAdapterLow == c.srcAdapterLow && a.srcAdapterHigh == c.srcAdapterHigh && a.srcId == c.srcId)) continue;
        var p = c; p.flags |= PATH_ACTIVE; p.srcModeIdx = MODE_IDX_INVALID; p.tgtModeIdx = MODE_IDX_INVALID;
        var list = new List<PATH>(active); list.Add(p);
        try { Apply(list.ToArray(), modes); return ""; } catch { }
      }
      // 3) repli : mode « Étendre » de Windows (réactive tous les écrans branchés, positions de la base Windows)
      int rc = SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_TOPOLOGY_EXTEND);
      if (rc != 0) throw new Exception("Activation impossible (SetDisplayConfig = " + rc + ")");
      return "";
    }

    public static string GdiFromPath(string devicePath) {
      foreach (var t in ListTargets()) if (t.active && string.Equals(t.devicePath, devicePath, StringComparison.OrdinalIgnoreCase)) return t.device;
      return null;
    }

    // ---- Écran principal : la source en (0,0) devient principale ----
    public static void SetPrimary(string target) {
      var dmT = new DEVMODE(); dmT.dmSize = (short)Marshal.SizeOf(dmT);
      if (!EnumDisplaySettings(target, -1, ref dmT)) throw new Exception("Écran introuvable : " + target);
      int ox = dmT.dmPositionX, oy = dmT.dmPositionY;
      if (ox == 0 && oy == 0) return;
      PATH[] paths; MODE[] modes; Query(QDC_ONLY_ACTIVE_PATHS, out paths, out modes);
      for (int i = 0; i < modes.Length; i++) if (modes[i].infoType == 1) { modes[i].x -= ox; modes[i].y -= oy; }
      Apply(paths, modes);
    }
  }
}
