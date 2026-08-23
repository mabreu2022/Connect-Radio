#!/bin/bash
###############################################################
# Connec Radio — Script de Instalação (Servidor WebRTC Próprio)
# Ubuntu 22.04 LTS
# Instala: Node.js 20 LTS, servidor WebRTC custom, Nginx, coturn
###############################################################

set -euo pipefail

# ─── Cores ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
log()    { echo -e "${GREEN}[✔]${NC} $1"; }
warn()   { echo -e "${YELLOW}[!]${NC} $1"; }
error()  { echo -e "${RED}[✘]${NC} $1"; exit 1; }
info()   { echo -e "${BLUE}[i]${NC} $1"; }
header() { echo -e "\n${CYAN}${BOLD}━━━ $1 ━━━${NC}\n"; }

# ─── Verificações ─────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Execute como root: sudo bash install.sh"
command -v lsb_release &>/dev/null && VER=$(lsb_release -rs) || VER="unknown"
[[ "$VER" != "22.04" ]] && warn "Testado no Ubuntu 22.04. Versão detectada: $VER"

# ─── Detectar IP público ──────────────────────────────────────
header "Detectando configurações do servidor"
SERVER_IP=$(curl -sf https://api.ipify.org || curl -sf https://icanhazip.com || hostname -I | awk '{print $1}')
[[ -z "$SERVER_IP" ]] && error "Não foi possível detectar o IP público."
info "IP público: ${BOLD}$SERVER_IP${NC}"

# ─── Gerar credenciais ────────────────────────────────────────
BEARER_TOKEN=$(openssl rand -hex 32)
TURN_PASS=$(openssl rand -hex 16)
TURN_SECRET=$(openssl rand -hex 32)

echo ""
echo -e "${YELLOW}${BOLD}⚠  SALVE ESTAS INFORMAÇÕES — VOCÊ PRECISARÁ NO BUTT  ⚠${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  IP do Servidor:    ${BOLD}$SERVER_IP${NC}"
echo -e "  Bearer Token WHIP: ${BOLD}$BEARER_TOKEN${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Salvar credenciais
CREDS="/root/connecradio_credentials.txt"
cat > "$CREDS" <<EOF
# Connec Radio — Credenciais do Servidor
# Gerado em: $(date)

IP do Servidor:    $SERVER_IP
Bearer Token WHIP: $BEARER_TOKEN
Senha TURN:        $TURN_PASS
TURN Secret:       $TURN_SECRET

# ── Configuração no BUTT ──────────────────────────────────────
# Tipo: WebRTC
# Servidor ICE: turn:$SERVER_IP:3478
# WHIP URL:     https://$SERVER_IP/whip/radio
# Bearer token: $BEARER_TOKEN

# ── Player Web ────────────────────────────────────────────────
# URL: https://$SERVER_IP
EOF
chmod 600 "$CREDS"
log "Credenciais salvas em $CREDS"

# ─── Atualizar sistema ────────────────────────────────────────
header "Atualizando sistema e instalando dependências"
apt-get update -qq
apt-get install -y -qq \
  curl wget openssl nginx coturn ufw \
  build-essential python3 git \
  libssl-dev
log "Pacotes base instalados"

# ─── Instalar Node.js 20 LTS ─────────────────────────────────
header "Instalando Node.js 20 LTS"
if ! command -v node &>/dev/null || [[ $(node -e "process.exit(parseInt(process.versions.node) < 20 ? 1 : 0)" 2>&1; echo $?) == "1" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
  apt-get install -y -qq nodejs
fi
node_version=$(node --version)
log "Node.js instalado: $node_version"

# ─── Criar usuário e diretório da aplicação ───────────────────
header "Configurando usuário e diretório"
if ! id "connecradio" &>/dev/null; then
  useradd --system --no-create-home --shell /bin/false connecradio
  log "Usuário 'connecradio' criado"
fi

APP_DIR="/opt/connecradio"
mkdir -p "$APP_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Copiar arquivos do servidor
cp "$SCRIPT_DIR/server.js"   "$APP_DIR/server.js"
cp "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"

# ─── Criar arquivo .env ───────────────────────────────────────
cat > "$APP_DIR/.env" <<EOF
PORT=8889
SERVER_IP=$SERVER_IP
BEARER_TOKEN=$BEARER_TOKEN
TURN_USER=connecradio
TURN_PASS=$TURN_PASS
TURN_SECRET=$TURN_SECRET
EOF
chmod 600 "$APP_DIR/.env"
log "Arquivo .env criado"

# ─── Instalar dependências Node.js ────────────────────────────
header "Instalando dependências Node.js (pode levar alguns minutos)"
info "Compilando @roamhq/wrtc — aguarde..."
cd "$APP_DIR"
npm install --omit=dev 2>&1 | tail -5
log "Dependências instaladas"

chown -R connecradio:connecradio "$APP_DIR"

# ─── Gerar certificado SSL auto-assinado ─────────────────────
header "Gerando certificado SSL"
SSL_DIR="/etc/nginx/ssl"
mkdir -p "$SSL_DIR"
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$SSL_DIR/connecradio.key" \
  -out    "$SSL_DIR/connecradio.crt" \
  -subj   "/C=BR/ST=Brasil/L=Brasil/O=Connec Radio/CN=$SERVER_IP" \
  -addext "subjectAltName=IP:$SERVER_IP" 2>/dev/null
chmod 600 "$SSL_DIR/connecradio.key"
log "Certificado SSL auto-assinado gerado (válido 10 anos)"

# ─── Configurar Nginx ─────────────────────────────────────────
header "Configurando Nginx"
rm -f /etc/nginx/sites-enabled/default

# Substituir IP no nginx.conf
sed "s/SERVER_IP_PLACEHOLDER/$SERVER_IP/g" \
  "$SCRIPT_DIR/nginx.conf" > /etc/nginx/sites-available/connecradio.conf

ln -sf /etc/nginx/sites-available/connecradio.conf \
       /etc/nginx/sites-enabled/connecradio.conf

nginx -t 2>/dev/null && log "Nginx config válida"
systemctl enable nginx && systemctl restart nginx
log "Nginx iniciado"

# ─── Configurar coturn ────────────────────────────────────────
header "Configurando coturn (TURN/STUN)"
grep -q "TURNSERVER_ENABLED=1" /etc/default/coturn 2>/dev/null || \
  echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn

sed \
  -e "s/SERVER_IP_PLACEHOLDER/$SERVER_IP/g" \
  -e "s/TURN_PASSWORD_PLACEHOLDER/$TURN_PASS/g" \
  -e "s/TURN_SECRET_PLACEHOLDER/$TURN_SECRET/g" \
  "$SCRIPT_DIR/turnserver.conf" > /etc/turnserver.conf

systemctl enable coturn && systemctl restart coturn
sleep 2
systemctl is-active coturn &>/dev/null && log "coturn rodando" || warn "Verifique: journalctl -u coturn"

# ─── Instalar serviço systemd ─────────────────────────────────
header "Instalando serviço Connec Radio"
cp "$SCRIPT_DIR/connecradio.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable connecradio
systemctl start connecradio
sleep 3
systemctl is-active connecradio &>/dev/null && log "Servidor WebRTC rodando" || {
  warn "Verifique o log: journalctl -u connecradio -n 50"
}

# ─── Instalar player web ──────────────────────────────────────
header "Instalando player web"
PLAYER_DIR="/var/www/connecradio"
mkdir -p "$PLAYER_DIR"

# Substitui IP nos arquivos do player
sed "s/SERVER_IP_PLACEHOLDER/$SERVER_IP/g" \
  "$SCRIPT_DIR/../player/index.html" > "$PLAYER_DIR/index.html"
cp "$SCRIPT_DIR/../player/style.css" "$PLAYER_DIR/style.css"
sed "s/SERVER_IP_PLACEHOLDER/$SERVER_IP/g" \
  "$SCRIPT_DIR/../player/app.js" > "$PLAYER_DIR/app.js"

chown -R www-data:www-data "$PLAYER_DIR"
log "Player web instalado"

# ─── Firewall ─────────────────────────────────────────────────
header "Configurando firewall (UFW)"
ufw --force reset &>/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow 49152:65535/udp
ufw --force enable
log "Firewall configurado"

# ─── Logrotate ────────────────────────────────────────────────
cat > /etc/logrotate.d/connecradio <<'EOF'
/var/log/journal {
    rotate 7
    daily
    compress
    missingok
}
EOF

# ─── Resumo ───────────────────────────────────────────────────
header "✔  Instalação Concluída!"
echo ""
echo -e "${CYAN}━━━ CONFIGURAÇÃO NO BUTT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Tipo:         ${BOLD}WebRTC${NC}"
echo -e "  Servidor ICE: ${BOLD}turn:$SERVER_IP:3478${NC}"
echo -e "  WHIP URL:     ${BOLD}https://$SERVER_IP/whip/radio${NC}"
echo -e "  Bearer token: ${BOLD}$BEARER_TOKEN${NC}"
echo ""
echo -e "${CYAN}━━━ PLAYER WEB ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  URL: ${BOLD}https://$SERVER_IP${NC}"
echo -e "  ${YELLOW}⚠ Na primeira vez: clique 'Avançado' → 'Prosseguir'${NC}"
echo ""
echo -e "${CYAN}━━━ COMANDOS ÚTEIS ─────────────────────────────────────${NC}"
echo -e "  systemctl status connecradio"
echo -e "  journalctl -u connecradio -f"
echo -e "  systemctl status coturn"
echo ""
echo -e "  Credenciais: ${BOLD}$CREDS${NC}"
echo -e "  Domínio no futuro: ${BOLD}bash migrate-ssl.sh${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
