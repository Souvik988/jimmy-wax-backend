$log = 'C:\jwbe\rerun-results.log'
Set-Content $log "start $(Get-Date)"
Set-Location 'C:\Users\MSI\OneDrive\Desktop\jimmy&wax_dashboard'
foreach ($s in 'studio-to-website','studio-preview-live','catalog-writes-live') {
  Add-Content $log "=== $s"
  $o = cmd /c "powershell -File tools\run-live-spec.ps1 tests/e2e/$s.local.spec.ts 2>&1"
  $o | Select-Object -Last 40 | Add-Content $log
  Add-Content $log "exit=$LASTEXITCODE"
}
Add-Content $log 'ALLDONE'
