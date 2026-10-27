$log = 'C:\jwbe\live-results.log'
Set-Content $log "start $(Get-Date)"
Set-Location 'C:\Users\MSI\OneDrive\Desktop\jimmy&wax_dashboard'
foreach ($s in 'studio-publish','studio-to-website','studio-preview-live','studio-finance-live','guarded-writes-live','catalog-writes-live','admin-writes-live') {
  Add-Content $log "=== $s"
  $o = cmd /c "powershell -File tools\run-live-spec.ps1 tests/e2e/$s.local.spec.ts 2>&1"
  $o | Select-Object -Last 14 | Add-Content $log
  Add-Content $log "exit=$LASTEXITCODE"
}
Add-Content $log '=== role-matrix'
$o = cmd /c "powershell -File tools\run-role-matrix.ps1 2>&1"
$o | Select-Object -Last 20 | Add-Content $log
Add-Content $log "exit=$LASTEXITCODE"
Add-Content $log 'ALLDONE'
