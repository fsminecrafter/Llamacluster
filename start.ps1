# Start LlamaCluster.
#   .\start.ps1                controller + new web UI (builds it on first run)
#   .\start.ps1 --worker       controller + a worker on this computer, registered automatically
#   .\start.ps1 --classic      keep the old single-file UI at /
#   .\start.ps1 --rebuild      rebuild the web UI first
# Any other option (--port, --token, --local-only, ...) goes to controller.py. See .\start.ps1 --help.
# (No param block on purpose: it would reject the GNU-style --worker. -Worker / -Classic work too.)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$rest = @($args | ForEach-Object { if ($_ -match '^-(worker|classic|rebuild)$') { "-$_" } else { $_ } })
$py = $null
foreach ($c in 'python', 'python3') { if (Get-Command $c -ErrorAction SilentlyContinue) { $py = @($c); break } }
if (-not $py -and (Get-Command py -ErrorAction SilentlyContinue)) { $py = @('py', '-3') }
if (-not $py) { Write-Error 'Python 3 is required (https://www.python.org/downloads/).'; exit 1 }
$exe = $py[0]; $pre = @($py | Select-Object -Skip 1)
& $exe @pre launcher.py @rest
exit $LASTEXITCODE
