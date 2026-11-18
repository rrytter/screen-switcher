# Processus PowerShell persistant : lit des requêtes JSON (une par ligne) sur stdin,
# répond une ligne JSON sur stdout. Le C# est compilé une seule fois au démarrage.
# Fichier en UTF-8 AVEC BOM : Windows PowerShell 5.1 lit sinon les accents en ANSI.
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

# \\.\DISPLAYn actuel d'un écran : par devicePath (stable, valable juste après une activation), sinon le nom mémorisé
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
                # nom lisible depuis l'EDID (WmiMonitorID), indexé par code modèle (ex. ACR080E)
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

                # 1. activer les écrans (avant de pouvoir les rendre principaux ou utiliser leur sortie audio)
                $enabled = $false
                foreach ($d in @($s.displays | Where-Object { $_ -and $_.enabled })) {
                    try {
                        $r = [ScreenSwitcher.Display]::SetEnabled($d.devicePath, $true, [string]$d.saved)
                        if ($null -eq $r) { $skipped += "on:$($d.devicePath)" } else { $enabled = $true; $sent += "on:$($d.devicePath)" }
                    } catch { $errors += "Activation écran : $($_.Exception.Message)" }
                }
                if ($enabled) { Start-Sleep -Milliseconds 1500 }

                # 2. écran principal (SetPrimary ne fait rien s'il l'est déjà)
                if ($s.primary) {
                    try { [ScreenSwitcher.Display]::SetPrimary((Resolve-Gdi $s.primary)) } catch { $errors += "Écran principal : $($_.Exception.Message)" }
                }

                # 3. désactiver les écrans (après avoir déplacé l'écran principal ailleurs)
                foreach ($d in @($s.displays | Where-Object { $_ -and -not $_.enabled })) {
                    try {
                        $r = [ScreenSwitcher.Display]::SetEnabled($d.devicePath, $false, $null)
                        if ($null -eq $r) { $skipped += "off:$($d.devicePath)" } else { $savedModes[$d.devicePath] = $r; $sent += "off:$($d.devicePath)" }
                    } catch { $errors += "Désactivation écran : $($_.Exception.Message)" }
                }

                # 4. sortie audio : celle d'un écran HDMI qui vient d'être activé met un moment à apparaître
                if ($s.audio) {
                    try {
                        $dev = $null
                        for ($t = 0; $t -lt 12; $t++) {
                            $list = [ScreenSwitcher.Audio]::List()
                            $dev = $list | Where-Object { $_.id -eq $s.audio } | Select-Object -First 1
                            if ($dev -or -not $enabled) { break }
                            Start-Sleep -Milliseconds 500
                        }
                        if (-not $dev) { throw 'sortie audio absente (appareil débranché ou éteint ?)' }
                        if ($dev.isDefault) { $skipped += 'audio' } else { [ScreenSwitcher.Audio]::SetDefault($s.audio); $sent += 'audio' }
                    } catch { $errors += "Audio : $($_.Exception.Message)" }
                }

                # 5. sources d'entrée DDC
                foreach ($i in @($s.inputs)) {
                    if ($null -eq $i) { continue }
                    try {
                        $gdi = Resolve-Gdi $i
                        # skipIfRead : valeur que l'écran annonce s'il est déjà sur la bonne source (null = toujours envoyer)
                        if ($null -ne $i.skipIfRead -and [ScreenSwitcher.Display]::GetInput($gdi) -eq [int]$i.skipIfRead) {
                            $skipped += $gdi; continue
                        }
                        [ScreenSwitcher.Display]::SetInput($gdi, [int]$i.value); $sent += $gdi
                    } catch { $errors += "Entrée $($i.device) : $($_.Exception.Message)" }
                }
                Send @{ id = $req.id; ok = ($errors.Count -eq 0); error = ($errors -join "`n"); result = @{ skipped = $skipped; sent = $sent; savedModes = $savedModes } }
            }
            'input' {
                # bouton « Tester » de l'éditeur : envoie un code de source tout de suite
                [ScreenSwitcher.Display]::SetInput((Resolve-Gdi $req), [int]$req.value)
                Send @{ id = $req.id; ok = $true }
            }
            'probe' {
                # assistant des sources : envoie un code, laisse l'écran basculer, puis lit la source annoncée (-1 = pas de réponse)
                $gdi = Resolve-Gdi $req
                [ScreenSwitcher.Display]::SetInput($gdi, [int]$req.value)
                Start-Sleep -Milliseconds ([int]$req.waitMs)
                $read = -1
                try { $read = [ScreenSwitcher.Display]::GetInput($gdi) } catch { }
                Send @{ id = $req.id; ok = $true; result = @{ read = $read } }
            }
            'ping' { Send @{ id = $req.id; ok = $true } }
            default { Send @{ id = $req.id; ok = $false; error = "Commande inconnue : $($req.cmd)" } }
        }
    } catch {
        Send @{ id = $(if ($req) { $req.id } else { -1 }); ok = $false; error = $_.Exception.Message }
    }
}
