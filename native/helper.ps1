# Processus PowerShell persistant : lit des requêtes JSON (une par ligne) sur stdin,
# répond une ligne JSON sur stdout. Le C# est compilé une seule fois au démarrage.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Send($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

try {
    Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'Native.cs') -Raw -Encoding UTF8)
    Send @{ id = 0; ok = $true; ready = $true }
} catch {
    Send @{ id = 0; ok = $false; error = "Compilation : $($_.Exception.Message)" }
    exit 1
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
                # nom lisible depuis l'EDID (WmiMonitorID), indexé par code modèle (ex. ACR080E)
                $names = @{}
                try {
                    Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | ForEach-Object {
                        $code = ($_.InstanceName -split '\\')[1]
                        $names[$code] = (($_.UserFriendlyName | Where-Object { $_ }) | ForEach-Object { [char]$_ }) -join ''
                    }
                } catch {}
                $monOut = @($mon | Select-Object *, @{ n = 'name'; e = { if ($names[$_.model]) { $names[$_.model] } else { $_.model } } })
                $aud = [ScreenSwitcher.Audio]::List()
                Send @{ id = $req.id; ok = $true; result = @{ monitors = $monOut; audio = @($aud) } }
            }
            'apply' {
                $errors = @(); $skipped = @(); $sent = @()
                $s = $req.scene
                # SetPrimary ne fait rien si l'écran est déjà principal
                if ($s.primary) { try { [ScreenSwitcher.Display]::SetPrimary($s.primary) } catch { $errors += "Écran principal : $($_.Exception.Message)" } }
                if ($s.audio) {
                    try {
                        $def = [ScreenSwitcher.Audio]::List() | Where-Object { $_.isDefault } | Select-Object -First 1
                        if ($def -and $def.id -eq $s.audio) { $skipped += 'audio' } else { [ScreenSwitcher.Audio]::SetDefault($s.audio) }
                    } catch { $errors += "Audio : $($_.Exception.Message)" }
                }
                foreach ($i in @($s.inputs)) {
                    if ($null -eq $i) { continue }
                    try {
                        # skipIfRead : valeur que l'écran annonce s'il est déjà sur la bonne source (null = toujours envoyer)
                        if ($null -ne $i.skipIfRead -and [ScreenSwitcher.Display]::GetInput($i.device) -eq [int]$i.skipIfRead) {
                            $skipped += $i.device; continue
                        }
                        [ScreenSwitcher.Display]::SetInput($i.device, [int]$i.value); $sent += $i.device
                    } catch { $errors += "Entrée $($i.device) : $($_.Exception.Message)" }
                }
                Send @{ id = $req.id; ok = ($errors.Count -eq 0); error = ($errors -join "`n"); result = @{ skipped = $skipped; sent = $sent } }
            }
            'ping' { Send @{ id = $req.id; ok = $true } }
            default { Send @{ id = $req.id; ok = $false; error = "Commande inconnue : $($req.cmd)" } }
        }
    } catch {
        Send @{ id = $(if ($req) { $req.id } else { -1 }); ok = $false; error = $_.Exception.Message }
    }
}
