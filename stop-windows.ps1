# Encerra o servidor Connec Radio na porta 8889 e processos Node.js
Write-Host "Encerrando servidor Connec Radio..." -ForegroundColor Yellow

Get-NetTCPConnection -LocalPort 8889 -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}

Stop-Process -Name node -Force -ErrorAction SilentlyContinue

Write-Host "Servidor encerrado com sucesso!" -ForegroundColor Green
