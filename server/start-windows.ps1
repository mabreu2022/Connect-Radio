# Wrapper para iniciar da pasta server
Set-Location -Path (Join-Path $PSScriptRoot "..")
& ".\start-windows.ps1"
