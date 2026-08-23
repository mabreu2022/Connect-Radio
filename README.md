# 📻 Connec Radio — Servidor WebRTC Próprio

Servidor de streaming de áudio ao vivo usando **WebRTC**, protocolo **WHIP** (ingestão via BUTT) e **WHEP** (reprodução no browser).

---

## 🏗️ Arquitetura

```
[BUTT 1.47.0 no Windows]
         │
         │  POST /whip/radio  (SDP offer + Bearer token)
         │  WebRTC DTLS/SRTP  (áudio Opus)
         ▼
[Ubuntu 22.04 VPS]
  ├── Nginx (porta 443/HTTPS) ── Reverse proxy
  ├── Node.js server.js (porta 8889) ── WHIP + WHEP + WebSocket
  └── coturn (porta 3478) ── STUN/TURN
         │
         │  POST /whep/radio  (SDP offer)
         │  WebRTC DTLS/SRTP  (áudio relay)
         ▼
[Browsers dos Ouvintes]
  https://IP_DO_SERVIDOR  →  Player Web
```

### Fluxo de áudio no servidor (Node.js)

```
RTCPeerConnection (BUTT)
  └── ontrack → AudioTrack
        └── RTCAudioSink.ondata (PCM raw)
              └── RTCAudioSource.onData
                    └── relayTrack (MediaStreamTrack)
                          └── RTCPeerConnection (cada ouvinte)
```

---

## 🚀 Instalação no VPS

### Pré-requisitos

- Ubuntu 22.04 LTS
- Acesso root/sudo
- IP público fixo

### Passos

```bash
# 1. Suba os arquivos para o VPS
scp -r ./server ./player root@SEU_IP:/tmp/connecradio/

# 2. No VPS, execute o instalador
ssh root@SEU_IP
cd /tmp/connecradio
bash server/install.sh
```

O script faz **tudo automaticamente**:
- Instala Node.js 20 LTS
- Compila `@roamhq/wrtc` (leva ~3 min)
- Configura Nginx + SSL auto-assinado
- Configura coturn (STUN/TURN)
- Cria serviço systemd com auto-start
- Instala o player web
- Configura firewall (UFW)
- Salva as credenciais em `/root/connecradio_credentials.txt`

---

## 🎙️ Configuração no BUTT

Após a instalação, configure assim no BUTT:

| Campo | Valor |
|-------|-------|
| Tipo | WebRTC |
| Servidor ICE | `turn:SEU_IP:3478` |
| WebRTC (WHIP) URL | `https://SEU_IP/whip/radio` |
| Bearer token | *(gerado pelo install.sh)* |

> ⚠️ O Bearer token está salvo em `/root/connecradio_credentials.txt`

---

## 🎧 Player Web

Acesse: `https://SEU_IP`

**Primeira vez com SSL auto-assinado:**
1. O browser mostrará aviso de segurança
2. Clique em **Avançado** → **Prosseguir**
3. O player funcionará normalmente daí em diante

---

## 📁 Estrutura de arquivos

```
Connec Radio/
├── server/
│   ├── server.js           ← Servidor WebRTC Node.js (WHIP + WHEP)
│   ├── package.json        ← Dependências npm
│   ├── install.sh          ← Script de instalação completa
│   ├── migrate-ssl.sh      ← Migrar para Let's Encrypt (com domínio)
│   ├── connecradio.service ← Serviço systemd
│   ├── nginx.conf          ← Configuração Nginx
│   └── turnserver.conf     ← Configuração coturn
└── player/
    ├── index.html          ← Player web
    ├── style.css           ← Estilos (glassmorphism dark)
    └── app.js              ← Cliente WHEP + visualizador
```

---

## 🔧 Comandos de gerenciamento no VPS

```bash
# Status dos serviços
systemctl status connecradio
systemctl status nginx
systemctl status coturn

# Logs em tempo real
journalctl -u connecradio -f

# Reiniciar servidor
systemctl restart connecradio

# Atualizar server.js
cp novo_server.js /opt/connecradio/server.js
systemctl restart connecradio
```

---

## 🌐 API do Servidor

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `POST` | `/whip/radio` | Ingestão BUTT → Servidor |
| `DELETE` | `/whip/radio/:sessionId` | Desconectar broadcaster |
| `POST` | `/whep/radio` | Ouvinte → Servidor |
| `DELETE` | `/whep/radio/:sessionId` | Ouvinte desconecta |
| `GET` | `/status` | Status JSON (live, listeners, uptime) |
| `GET` | `/health` | Health check simples |
| `WS` | `/ws` | WebSocket para status em tempo real |

---

## 🔒 Migrar para SSL com domínio

Quando registrar um domínio:

```bash
# No VPS
bash /tmp/connecradio/server/migrate-ssl.sh
```

O script:
1. Instala Certbot
2. Obtém certificado Let's Encrypt
3. Atualiza Nginx e o player web
4. Configura renovação automática

---

## 📊 Portas necessárias no firewall

| Porta | Proto | Serviço |
|-------|-------|---------|
| 80 | TCP | HTTP → redireciona HTTPS |
| 443 | TCP | HTTPS (Nginx) |
| 3478 | TCP/UDP | STUN/TURN (coturn) |
| 5349 | TCP/UDP | TURNS/TLS (coturn) |
| 49152-65535 | UDP | WebRTC media relay |

---

## 🐛 Solução de problemas

**BUTT não consegue conectar:**
- Verifique se o Bearer token está correto
- Certifique-se de que o SSL foi aceito no browser primeiro (abre o player uma vez)
- Veja o log: `journalctl -u connecradio -f`

**Sem áudio no player:**
- Abra `https://SEU_IP/status` — verifica se `live: true`
- Navegadores exigem interação do usuário antes de reproduzir áudio (botão play)

**Erro de ICE/conexão WebRTC:**
- Verifique se coturn está rodando: `systemctl status coturn`
- Confirme as portas UDP abertas: `ufw status`
