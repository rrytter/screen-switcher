# Persistent PowerShell process: reads JSON requests (one per line) on stdin,
# answers one JSON line on stdout. The C# code is compiled once at startup.
# File saved as UTF-8 WITH BOM: otherwise Windows PowerShell 5.1 reads non-ASCII characters as ANSI.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Send($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

try {
    Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'Native.cs') -Raw -Encoding UTF8)
    Send @{ id = 0; ok = $true; ready = $true }
} catch {
    Send @{ id = 0; ok = $false; error = "Compilation: $($_.Exception.Message)" }
    exit 1
}

# Current \\.\DISPLAYn of a display: by devicePath (stable, valid right after enabling), else the stored name
function Resolve-Gdi($ref) {
    if ($ref.devicePath) { $g = [ScreenSwitcher.Display]::GdiFromPath($ref.devicePath); if ($g) { return $g } }
    return $ref.device
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $req = $null
    try {
        $req = $line | ConvertFrom-Json
        switch ($req.cmd) {
            'list' {
                $mon = [ScreenSwitcher.Display]::List([bool]$req.ddc)
                # readable name from the EDID (WmiMonitorID), indexed by model code (e.g. ACR080E)
                $names = @{}
                try {
                    Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | ForEach-Object {
                        $code = ($_.InstanceName -split '\\')[1]
                        $names[$code] = (($_.UserFriendlyName | Where-Object { $_ }) | ForEach-Object { [char]$_ }) -join ''
                    }
                } catch {}
                $monOut = @($mon | Select-Object *, @{ n = 'name'; e = { if ($names[$_.model]) { $names[$_.model] } else { $_.model } } })
                $targets = @([ScreenSwitcher.Display]::ListTargets())
                $aud = [ScreenSwitcher.Audio]::List()
                Send @{ id = $req.id; ok = $true; result = @{ monitors = $monOut; targets = $targets; audio = @($aud) } }
            }
            'apply' {
                $errors = @(); $skipped = @(); $sent = @(); $savedModes = @{}
                $s = $req.scene

                # 1. enable displays (before they can become primary or their audio output can be used)
                $enabled = $false
                foreach ($d in @($s.displays | Where-Object { $_ -and $_.enabled })) {
                    try {
                        $r = [ScreenSwitcher.Display]::SetEnabled($d.devicePath, $true, [string]$d.saved)
                        if ($null -eq $r) { $skipped += "on:$($d.devicePath)" } else { $enabled = $true; $sent += "on:$($d.devicePath)" }
                    } catch { $errors += "Enable display: $($_.Exception.Message)" }
                }
                if ($enabled) { Start-Sleep -Milliseconds 1500 }

                # 2. primary display (SetPrimary does nothing if it already is)
                if ($s.primary) {
                    try { [ScreenSwitcher.Display]::SetPrimary((Resolve-Gdi $s.primary)) } catch { $errors += "Primary display: $($_.Exception.Message)" }
                }

                # 3. disable displays (after the primary display has moved elsewhere)
                foreach ($d in @($s.displays | Where-Object { $_ -and -not $_.enabled })) {
                    try {
                        $r = [ScreenSwitcher.Display]::SetEnabled($d.devicePath, $false, $null)
                        if ($null -eq $r) { $skipped += "off:$($d.devicePath)" } else { $savedModes[$d.devicePath] = $r; $sent += "off:$($d.devicePath)" }
                    } catch { $errors += "Disable display: $($_.Exception.Message)" }
                }

                # 4. audio output: the output of a just-enabled HDMI display takes a moment to appear
                if ($s.audio) {
                    try {
                        $dev = $null
                        for ($t = 0; $t -lt 12; $t++) {
                            $list = [ScreenSwitcher.Audio]::List()
                            $dev = $list | Where-Object { $_.id -eq $s.audio } | Select-Object -First 1
                            if ($dev -or -not $enabled) { break }
                            Start-Sleep -Milliseconds 500
                        }
                        if (-not $dev) { throw 'audio output missing (device unplugged or turned off?)' }
                        if ($dev.isDefault) { $skipped += 'audio' } else { [ScreenSwitcher.Audio]::SetDefault($s.audio); $sent += 'audio' }
                    } catch { $errors += "Audio: $($_.Exception.Message)" }
                }

                # 5. DDC input sources
                foreach ($i in @($s.inputs)) {
                    if ($null -eq $i) { continue }
                    try {
                        $gdi = Resolve-Gdi $i
                        # skipIfRead: value the monitor reports when already on the right input (null = always send)
                        if ($null -ne $i.skipIfRead -and [ScreenSwitcher.Display]::GetInput($gdi) -eq [int]$i.skipIfRead) {
                            $skipped += $gdi; continue
                        }
                        [ScreenSwitcher.Display]::SetInput($gdi, [int]$i.value); $sent += $gdi
                    } catch { $errors += "Input $($i.device): $($_.Exception.Message)" }
                }
                Send @{ id = $req.id; ok = ($errors.Count -eq 0); error = ($errors -join "`n"); result = @{ skipped = $skipped; sent = $sent; savedModes = $savedModes } }
            }
            'input' {
                # editor "Test" button: sends an input code right away
                [ScreenSwitcher.Display]::SetInput((Resolve-Gdi $req), [int]$req.value)
                Send @{ id = $req.id; ok = $true }
            }
            'probe' {
                # input wizard: sends a code, lets the monitor switch, then reads the reported input (-1 = no answer)
                $gdi = Resolve-Gdi $req
                [ScreenSwitcher.Display]::SetInput($gdi, [int]$req.value)
                Start-Sleep -Milliseconds ([int]$req.waitMs)
                $read = -1
                try { $read = [ScreenSwitcher.Display]::GetInput($gdi) } catch { }
                Send @{ id = $req.id; ok = $true; result = @{ read = $read } }
            }
            'ping' { Send @{ id = $req.id; ok = $true } }
            default { Send @{ id = $req.id; ok = $false; error = "Unknown command: $($req.cmd)" } }
        }
    } catch {
        Send @{ id = $(if ($req) { $req.id } else { -1 }); ok = $false; error = $_.Exception.Message }
    }
}
