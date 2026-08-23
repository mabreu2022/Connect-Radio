#!/bin/bash
###############################################################
# Connec Radio - Migração SSL para Let's Encrypt
# Execute este script quando tiver um domínio registrado
# apontando para o IP do servidor
###############################################################

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
log()   { echo -e "${GREEN}[✔]${NC} $1"; }
error() { echo -e "${RED}[✘]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Execute como root: sudo bash migrate-ssl.sh"

# ─── Solicitar domínio e email ────────────────────────────────
read -p "Digite seu domínio (ex: radio.meusite.com.br): " DOMAIN
read -p "Digite seu email para Let's Encrypt: " EMAIL

[[ -z "$DOMAIN" ]] && error "Domínio não pode ser vazio"
[[ -z "$EMAIL" ]]  && error "Email não pode ser vazio"

echo ""
echo -e "${YELLOW}Verificando se $DOMAIN aponta para este servidor...${NC}"
SERVER_IP=$(curl -s https://api.ipify.org)
DOMAIN_IP=$(dig +short "$DOMAIN" A | tail -1)

if [[ "$DOMAIN_IP" != "$SERVER_IP" ]]; then
    echo -e "${RED}AVISO: $DOMAIN aponta para $DOMAIN_IP, mas o servidor é $SERVER_IP${NC}"
    read -p "Continuar mesmo assim? (s/N): " CONFIRM
    [[ "$CONFIRM" != "s" && "$CONFIRM" != "S" ]] && exit 1
fi

# ─── Instalar Certbot ─────────────────────────────────────────
apt-get install -y -qq certbot python3-certbot-nginx
log "Certbot instalado"

# ─── Atualizar nginx.conf com domínio ────────────────────────
# Atualiza o server_name no nginx
sed -i "s/server_name _;/server_name $DOMAIN;/g" /etc/nginx/sites-available/connecradio.conf

# Temporariamente aponta SSL para auto-assinado enquanto gera
nginx -t && systemctl reload nginx

# ─── Obter certificado Let's Encrypt ─────────────────────────
certbot --nginx \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --non-interactive \
    --redirect

log "Certificado Let's Encrypt obtido para $DOMAIN"

# ─── Atualizar player web com novo domínio ───────────────────
PLAYER_DIR="/var/www/connecradio"
OLD_IP=$(grep -o 'SERVER_IP\|[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}' "$PLAYER_DIR/app.js" | head -1)

sed -i "s|https://$SERVER_IP|https://$DOMAIN|g" "$PLAYER_DIR/index.html"
sed -i "s|https://$SERVER_IP|https://$DOMAIN|g" "$PLAYER_DIR/app.js"

# ─── Atualizar credenciais salvas ────────────────────────────
CREDS_FILE="/root/connecradio_credentials.txt"
if [[ -f "$CREDS_FILE" ]]; then
    echo "" >> "$CREDS_FILE"
    echo "# Atualizado em: $(date)" >> "$CREDS_FILE"
    echo "Domínio:  $DOMAIN" >> "$CREDS_FILE"
    echo "Player:   https://$DOMAIN" >> "$CREDS_FILE"
    echo "WHIP URL: https://$DOMAIN/whip/radio" >> "$CREDS_FILE"
fi

# ─── Renovação automática ─────────────────────────────────────
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -
log "Renovação automática do certificado configurada (diária às 3h)"

echo ""
echo -e "${GREEN}${BOLD}✔ Migração SSL concluída!${NC}"
echo ""
echo -e "  Player Web:  ${BOLD}https://$DOMAIN${NC}"
echo -e "  WHIP URL:    ${BOLD}https://$DOMAIN/whip/radio${NC}"
echo -e "  Atualize o BUTT com a nova URL WHIP acima"
