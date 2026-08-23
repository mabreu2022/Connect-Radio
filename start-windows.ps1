# ╔══════════════════════════════════════════════════════════════╗
# ║  Connec Radio — Iniciar servidor no Windows (IP público)     ║
# ║  Execute com: .\start-windows.ps1                           ║
# ╚══════════════════════════════════════════════════════════════╝

$ErrorActionPreference = "Stop"

# ─── Cores no terminal ────────────────────────────────────────
function Write-Green  { param($t) Write-Host "  [✔] $t" -ForegroundColor Green }
function Write-Yellow { param($t) Write-Host "  [!] $t" -ForegroundColor Yellow }
function Write-Cyan   { param($t) Write-Host $t -ForegroundColor Cyan }
function Write-Red    { param($t) Write-Host "  [✘] $t" -ForegroundColor Red }

Clear-Host
Write-Cyan "╔══════════════════════════════════════════════════════════╗"
Write-Cyan "║          Connec Radio — Servidor WebRTC Windows          ║"
Write-Cyan "╚══════════════════════════════════════════════════════════╝"
Write-Host ""

# ─── Verificar Node.js ────────────────────────────────────────
try {
    $nodeVer = node --version 2>&1
    Write-Green "Node.js encontrado: $nodeVer"
} catch {
    Write-Red "Node.js não encontrado!"
    Write-Host ""
    Write-Yellow "Instale em: https://nodejs.org (versão 20 LTS)"
    Write-Yellow "Após instalar, feche e reabra o PowerShell e tente novamente."
    Read-Host "  Pressione Enter para sair"
    exit 1
}

# ─── Detectar IPs (Local e Público) ───────────────────────────
$LOCAL_IP = (Get-NetIPAddress -AddressFamily IPv4 |
             Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" } |
             Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "  Detectando seu IP público..." -ForegroundColor DarkGray
try {
    $PUBLIC_IP = (Invoke-WebRequest -Uri "https://api.ipify.org" -UseBasicParsing -TimeoutSec 5).Content.Trim()
    Write-Green "IP público detectado: $PUBLIC_IP"
} catch {
    $PUBLIC_IP = $LOCAL_IP
    Write-Yellow "Não foi possível detectar IP público. Usando IP local: $PUBLIC_IP"
}

# ─── Configurações ────────────────────────────────────────────
$PORT         = "8889"
$BEARER_TOKEN = ""    # Deixe vazio para teste sem autenticação
                      # Mude aqui para proteger: $BEARER_TOKEN = "meu-token-secreto"

Write-Host ""
Write-Cyan "  Configuração:"
Write-Host "    IP Local (Wi-Fi): $LOCAL_IP"
Write-Host "    IP Público:       $PUBLIC_IP"
Write-Host "    Porta:            $PORT"
Write-Host "    Bearer Token:     $(if ($BEARER_TOKEN) { '*** definido ***' } else { '(sem autenticação)' })"

# ─── Ir para o diretório do server ───────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ServerDir = Join-Path $ScriptDir "server"

if (-not (Test-Path $ServerDir)) {
    Write-Red "Pasta 'server' não encontrada em: $ScriptDir"
    Read-Host "  Pressione Enter para sair"
    exit 1
}

Set-Location $ServerDir

# ─── Liberar porta se já estiver em uso ──────────────────────
Write-Host ""
$portInUse = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Yellow "Porta $PORT já em uso. Encerrando instância anterior..."
    $portInUse | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep 2
    Write-Green "Instância anterior encerrada"
}

# ─── Instalar dependências (se necessário) ────────────────────
Write-Host ""
if (-not (Test-Path "node_modules")) {
    Write-Host "  Instalando dependências Node.js..." -ForegroundColor Yellow
    Write-Yellow "@roamhq/wrtc pode levar alguns minutos para compilar. Aguarde..."
    Write-Host ""
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Red "Erro no npm install. Verifique a saída acima."
        Read-Host "  Pressione Enter para sair"
        exit 1
    }
    Write-Green "Dependências instaladas"
} else {
    Write-Green "Dependências já instaladas"
}

# ─── Abrir porta no Firewall do Windows ──────────────────────
Write-Host ""
Write-Host "  Configurando Firewall do Windows..." -ForegroundColor DarkGray
$ruleName = "Connec Radio WebRTC $PORT"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
    try {
        New-NetFirewallRule `
            -DisplayName $ruleName `
            -Direction   Inbound `
            -Protocol    TCP `
            -LocalPort   $PORT `
            -Action      Allow `
            -Profile     Any | Out-Null
        Write-Green "Regra de firewall criada para porta TCP $PORT"
    } catch {
        Write-Yellow "Não foi possível criar regra de firewall automaticamente."
        Write-Yellow "Abra manualmente: Firewall → Regras de Entrada → Nova Regra → Porta TCP $PORT"
    }
} else {
    Write-Green "Regra de firewall já existe"
}

# ─── Definir variáveis de ambiente ───────────────────────────
$env:PORT         = $PORT
$env:HOST         = "0.0.0.0"
$env:SERVER_IP    = $PUBLIC_IP
$env:BEARER_TOKEN = $BEARER_TOKEN
$env:TURN_USER    = "connecradio"
$env:TURN_PASS    = "connecradio123"  # TURN local (sem coturn no Windows)
$env:USE_HTTPS    = "true"            # HTTPS com cert auto-assinado
$env:LOCAL_MODE   = "false"

# ─── Resumo antes de iniciar ──────────────────────────────────
Write-Host ""
Write-Cyan "══════════════════════════════════════════════════════════"
Write-Cyan "  🎛️  PAINEL DO ESTÚDIO & AUTODJ (Com Calendário):"
Write-Host "    Acesse no seu navegador: https://127.0.0.1:$PORT/studio" -ForegroundColor Yellow
Write-Host "    (Controle o som, grade de horários, microfone e playlists)" -ForegroundColor DarkGray
Write-Host ""
Write-Cyan "  🎧  PLAYER PARA OUVINTES:"
Write-Host "    No Celular (mesmo Wi-Fi): https://$($LOCAL_IP):$PORT" -ForegroundColor Cyan
Write-Host "    Pela Internet (externo):  https://$($PUBLIC_IP):$PORT" -ForegroundColor DarkGray
Write-Host "    ⚠  Na 1ª vez: Clique em 'Avançado' → 'Prosseguir' (certificado auto-assinado)" -ForegroundColor DarkGray
Write-Host ""
Write-Cyan "  🎙️  OU TRANSMISSÃO EXTERNA (BUTT / OBS):"
Write-Host "    WHIP URL: https://127.0.0.1:$PORT/whip/radio" -ForegroundColor White
Write-Cyan "══════════════════════════════════════════════════════════"
Write-Host ""
Write-Host "  Iniciando servidor... (Ctrl+C para parar)" -ForegroundColor Green
Write-Host ""

# ─── Iniciar servidor ─────────────────────────────────────────
node server.js
