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
    public string device; public string hwId; public string model; public bool primary;
    public int x, y, width, height, hz;
    public bool ddc; public string ddcCaps; public int[] ddcInputs; public int currentInput;
  }

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

    // ---- Écran principal via l'API CCD : la source en (0,0) devient principale ----
    [StructLayout(LayoutKind.Explicit, Size = 72)] struct PATH { [FieldOffset(12)] public uint srcModeIdx; }
    [StructLayout(LayoutKind.Explicit, Size = 64)] struct MODE {
      [FieldOffset(0)] public uint infoType; [FieldOffset(28)] public int x; [FieldOffset(32)] public int y;
    }
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint nPaths, out uint nModes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint nPaths, [Out] PATH[] paths, ref uint nModes, [Out] MODE[] modes, IntPtr topo);
    [DllImport("user32.dll")] static extern int SetDisplayConfig(uint nPaths, PATH[] paths, uint nModes, MODE[] modes, uint flags);

    public static void SetPrimary(string target) {
      var dmT = new DEVMODE(); dmT.dmSize = (short)Marshal.SizeOf(dmT);
      if (!EnumDisplaySettings(target, -1, ref dmT)) throw new Exception("Écran introuvable : " + target);
      int ox = dmT.dmPositionX, oy = dmT.dmPositionY;
      if (ox == 0 && oy == 0) return;
      const uint QDC_ONLY_ACTIVE_PATHS = 2;
      uint np, nm;
      int rc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm);
      if (rc != 0) throw new Exception("GetDisplayConfigBufferSizes = " + rc);
      var paths = new PATH[np]; var modes = new MODE[nm];
      rc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero);
      if (rc != 0) throw new Exception("QueryDisplayConfig = " + rc);
      for (int i = 0; i < nm; i++) if (modes[i].infoType == 1) { modes[i].x -= ox; modes[i].y -= oy; }
      const uint SDC_USE_SUPPLIED = 0x20, SDC_APPLY = 0x80, SDC_SAVE = 0x200, SDC_ALLOW_CHANGES = 0x400;
      rc = SetDisplayConfig(np, paths, nm, modes, SDC_APPLY | SDC_USE_SUPPLIED | SDC_SAVE | SDC_ALLOW_CHANGES);
      if (rc != 0) throw new Exception("SetDisplayConfig = " + rc);
    }
  }
}
