/**
 * Connec Radio — Player Web (WHEP Client)
 * Conecta ao servidor via protocolo WHEP e reproduz o áudio ao vivo.
 */

'use strict';

// ─── Configuração — URLs carregadas dinamicamente via /config.js ─────────
// window.CONNEC_CONFIG é injetado pelo endpoint /config.js do servidor.
// Isso garante que o player funciona tanto local quanto em produção
// sem precisar editar arquivos.
const cfg = window.CONNEC_CONFIG || {};

const SERVER_BASE = cfg.serverBase || `${location.protocol}//${location.host}`;
const WHEP_URL    = cfg.whepUrl    || `${SERVER_BASE}/whep/radio`;
const STATUS_URL  = `${SERVER_BASE}/status`;
const WS_URL      = cfg.wsUrl      || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ICE Servers — STUN sempre ativo, TURN só se tiver credenciais
const TURN_IP   = cfg.turnIp   || '';
const TURN_USER = cfg.turnUser || '';
const TURN_CRED = cfg.turnCred || '';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Só adiciona TURN se tiver IP + usuário + senha preenchidos
if (TURN_IP && TURN_USER && TURN_CRED) {
  ICE_SERVERS.push({
    urls: `turn:${TURN_IP}:3478`,
    username: TURN_USER,
    credential: TURN_CRED,
  });
}

// ─── Estado do player ─────────────────────────────────────────
const state = {
  pc:           null,   // RTCPeerConnection atual
  audioCtx:     null,   // AudioContext para visualizador
  analyser:     null,   // AnalyserNode
  sessionUrl:   null,   // URL de sessão WHEP para DELETE
  playing:      false,
  muted:        false,
  volume:       0.8,
  uptimeTimer:  null,
  listeningSec: 0,
  wsRetryTimer: null,
  ws:           null,
};

// ─── Refs DOM ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const playBtn           = $('play-btn');
const iconPlay          = $('icon-play');
const iconStop          = $('icon-stop');
const iconLoading       = $('icon-loading');
const statusBar         = $('status-bar');
const statusText        = $('status-text');
const statusDot         = $('status-dot');
const logoRing          = $('logo-ring');
const nowPlayingCard    = $('now-playing-card');
const trackTitle        = $('track-title');
const trackArtist       = $('track-artist');
const trackProgressFill = $('track-progress-fill');
const trackTimeElapsed  = $('track-time-elapsed');
const trackTimeTotal    = $('track-time-total');
const trackLiveTag      = $('track-live-tag');
const volumeSlider      = $('volume-slider');
const volumeFill        = $('volume-fill');
const volumeValue       = $('volume-value');
const muteBtn           = $('mute-btn');
const volIcon           = $('vol-icon');
const volWave1          = $('vol-wave-1');
const volWave2          = $('vol-wave-2');
const infoLatency       = $('info-latency');
const infoCodec         = $('info-codec');
const infoQuality       = $('info-quality');
const infoUptime        = $('info-uptime');
const audioEl           = $('audio-element');
const sslNotice         = $('ssl-notice');
const canvas            = $('visualizer');
const footerYear        = $('footer-year');

// ─── Estado da Faixa Atual ────────────────────────────────────
let currentTrackInfo = {
  title: '',
  artist: '',
  duration: 0,
  startedAt: null,
};
let trackTimer = null;

// ─── Inicialização ────────────────────────────────────────────
footerYear.textContent = new Date().getFullYear();
setupParticles();
setupVolumeControl();
connectWebSocket();
checkServerStatus();

// ─── Botão Play/Stop ──────────────────────────────────────────
playBtn.addEventListener('click', () => {
  if (state.playing) {
    stopStream();
  } else {
    startStream();
  }
});

// ═══════════════════════════════════════════════════════════════
//  WHEP — Conexão WebRTC
// ═══════════════════════════════════════════════════════════════
async function startStream() {
  setStatus('connecting', 'Conectando...');
  setPlayIcon('loading');
  playBtn.disabled = true;

  try {
    // 1. Criar RTCPeerConnection
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.pc = pc;

    // 2. Anexar listeners IMEDIATAMENTE
    pc.ontrack = ({ track, streams }) => {
      console.log('[Player] WebRTC ontrack recebido! kind=', track.kind);
      if (track.kind !== 'audio') return;
      const stream = streams[0] || new MediaStream([track]);

      audioEl.srcObject = stream;
      audioEl.volume = state.muted ? 0 : state.volume;
      audioEl.muted = false;

      const playPromise = audioEl.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Player] Autoplay aguardando interação:', err.message);
          setTimeout(() => audioEl.play().catch(() => {}), 300);
        });
      }

      setupVisualizer(stream);
      onConnected(pc);
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        onConnected(pc);
      } else if (['disconnected', 'failed', 'closed'].includes(s)) {
        onDisconnected(s);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') onConnected(pc);
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        onDisconnected(pc.connectionState);
      }
    };

    // 3. Adicionar transceiver de áudio (receiveonly)
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // 4. Criar offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 5. Aguardar ICE gathering
    await waitForIceGathering(pc);

    // 6. Enviar SDP offer ao servidor via WHEP
    let response;
    try {
      response = await fetch(WHEP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
    } catch (fetchErr) {
      showSslNotice();
      throw fetchErr;
    }

    if (response.ok) {
      const answerSdp = await response.text();
      state.sessionUrl = response.headers.get('Location');
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      state.playing = true;
      playBtn.disabled = false;
      return;
    }

    // Se WebRTC não estiver ativo, mas o AutoDJ estiver tocando no servidor:
    if (currentTrackInfo && currentTrackInfo.path) {
      startAutoDJStream();
      return;
    }

    if (response.status === 404) {
      setStatus('error', 'Rádio não está ao vivo');
      setPlayIcon('play');
      playBtn.disabled = false;
      return;
    }
    throw new Error(`Servidor retornou ${response.status}`);

  } catch (err) {
    if (currentTrackInfo && currentTrackInfo.path) {
      startAutoDJStream();
      return;
    }
    console.error('[Player] Connection error:', err);
    if (!sslNotice.style.display || sslNotice.style.display === 'none') {
      setStatus('error', 'Erro ao conectar — tente novamente');
    }
    setPlayIcon('play');
    playBtn.disabled = false;
    cleanup();
  }
}

function startAutoDJStream() {
  if (!currentTrackInfo || !currentTrackInfo.path) return;
  const rawPath = currentTrackInfo.path.replace(/\\/g, '/');
  const audioUrl = `${SERVER_BASE}/media/${encodeURI(rawPath).replace(/#/g, '%23')}`;

  audioEl.srcObject = null;
  audioEl.src = audioUrl;
  audioEl.volume = state.muted ? 0 : state.volume;
  audioEl.muted = false;

  const elapsed = currentTrackInfo.startedAt ? Math.max(0, Math.floor((Date.now() - currentTrackInfo.startedAt) / 1000)) : 0;
  if (elapsed > 1) {
    try { audioEl.currentTime = elapsed; } catch (_) {}
  }

  audioEl.play().then(() => {
    state.playing = true;
    playBtn.disabled = false;
    onConnected(null);
  }).catch((err) => {
    console.warn('[AutoDJ Audio] Erro:', err);
    state.playing = false;
    playBtn.disabled = false;
    setPlayIcon('play');
  });
}

function stopStream() {
  cleanup();
  setStatus('idle', 'Parado');
  setPlayIcon('play');
  stopVisualizer();
  stopUptimeTimer();
}

function cleanup() {
  if (state.sessionUrl) {
    fetch(state.sessionUrl, { method: 'DELETE' }).catch(() => {});
    state.sessionUrl = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  audioEl.srcObject = null;
  state.playing = false;
  playBtn.classList.remove('playing');
  logoRing.classList.remove('is-live');
  if (nowPlayingCard) nowPlayingCard.classList.remove('is-playing');
}

function onConnected(pc) {
  setStatus('connected', '● AO VIVO');
  setPlayIcon('stop');
  playBtn.classList.add('playing');
  logoRing.classList.add('is-live');
  if (nowPlayingCard) nowPlayingCard.classList.add('is-playing');
  startUptimeTimer();
  pollStats(pc);
}

function onDisconnected(reason) {
  console.warn('[Player] Disconnected:', reason);
  setStatus('error', 'Conexão perdida');
  setPlayIcon('play');
  playBtn.classList.remove('playing');
  logoRing.classList.remove('is-live');
  if (nowPlayingCard) nowPlayingCard.classList.remove('is-playing');
  stopVisualizer();
  stopUptimeTimer();
  state.playing = false;
}

// ─── ICE Gathering helper ─────────────────────────────────────
function waitForIceGathering(pc, timeout = 5000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, timeout);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

// ─── WebRTC Stats polling ─────────────────────────────────────
async function pollStats(pc) {
  if (!pc || pc.connectionState === 'closed') return;
  try {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        // Codec
        infoCodec.textContent = report.mimeType?.replace('audio/', '') || 'Opus';
        // Qualidade (packet loss)
        const lost = report.packetsLost || 0;
        const recv = report.packetsReceived || 1;
        const loss = ((lost / (lost + recv)) * 100).toFixed(1);
        infoQuality.textContent = loss < 1 ? '🟢 Ótima' : loss < 5 ? '🟡 Boa' : '🔴 Ruim';
      }
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        const rtt = report.currentRoundTripTime;
        if (rtt !== undefined) {
          infoLatency.textContent = `${Math.round(rtt * 1000)} ms`;
        }
      }
    });
  } catch (_) {}
  setTimeout(() => pollStats(pc), 3000);
}

// ─── Uptime timer ─────────────────────────────────────────────
function startUptimeTimer() {
  state.listeningSec = 0;
  state.uptimeTimer = setInterval(() => {
    state.listeningSec++;
    infoUptime.textContent = formatDuration(state.listeningSec);
  }, 1000);
}
function stopUptimeTimer() {
  clearInterval(state.uptimeTimer);
  state.uptimeTimer = null;
  infoUptime.textContent = '—';
}
function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ─── UI helpers ───────────────────────────────────────────────
function setPlayIcon(which) {
  iconPlay.style.display    = which === 'play'    ? '' : 'none';
  iconStop.style.display    = which === 'stop'    ? '' : 'none';
  iconLoading.style.display = which === 'loading' ? '' : 'none';
}

function setStatus(type, text) {
  statusBar.className = 'status-bar ' + (type === 'idle' ? '' : type);
  statusText.textContent = text;
}

function showSslNotice() {
  sslNotice.style.display = 'flex';
  setStatus('error', 'Aceite o certificado SSL primeiro');
  setPlayIcon('play');
  playBtn.disabled = false;
}

// ─── Volume control ───────────────────────────────────────────
function setupVolumeControl() {
  volumeSlider.addEventListener('input', () => {
    const v = parseInt(volumeSlider.value);
    state.volume = v / 100;
    volumeFill.style.width = v + '%';
    volumeValue.textContent = v + '%';
    if (!state.muted) audioEl.volume = state.volume;
    updateVolumeIcon(v);
  });

  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    audioEl.volume = state.muted ? 0 : state.volume;
    updateVolumeIcon(state.muted ? 0 : parseInt(volumeSlider.value));
  });
}

function updateVolumeIcon(level) {
  if (level === 0 || state.muted) {
    volWave1.style.display = 'none';
    volWave2.style.display = 'none';
  } else if (level < 50) {
    volWave1.style.display = '';
    volWave2.style.display = 'none';
  } else {
    volWave1.style.display = '';
    volWave2.style.display = '';
  }
}

// ─── Visualizador de áudio ────────────────────────────────────
let animFrame = null;
const ctx2d = canvas.getContext('2d');

function setupVisualizer(stream) {
  try {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.8;

    const src = state.audioCtx.createMediaStreamSource(stream);
    src.connect(state.analyser);
    drawVisualizer();
  } catch (err) {
    console.warn('[Player] Visualizer setup:', err);
  }
}

function drawVisualizer() {
  if (!state.analyser) return;
  animFrame = requestAnimationFrame(drawVisualizer);

  const W = canvas.width;
  const H = canvas.height;
  const bufLen = state.analyser.frequencyBinCount;
  const data = new Uint8Array(bufLen);
  state.analyser.getByteFrequencyData(data);

  ctx2d.clearRect(0, 0, W, H);

  const barW = (W / bufLen) * 2.2;
  let x = 0;

  for (let i = 0; i < bufLen; i++) {
    const v = data[i] / 255;
    const barH = v * H;

    // Gradiente por frequência
    const hue = 260 + (i / bufLen) * 80; // purple → cyan
    const alpha = 0.5 + v * 0.5;
    ctx2d.fillStyle = `hsla(${hue}, 80%, 60%, ${alpha})`;

    // Barra da base para cima
    ctx2d.fillRect(x, H - barH, barW - 1, barH);

    // Reflexo suave
    ctx2d.fillStyle = `hsla(${hue}, 80%, 60%, ${alpha * 0.2})`;
    ctx2d.fillRect(x, 0, barW - 1, barH * 0.3);

    x += barW;
  }
}

function stopVisualizer() {
  if (animFrame) cancelAnimationFrame(animFrame);
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
    state.analyser = null;
  }
}

// ─── WebSocket para status em tempo real ─────────────────────
function connectWebSocket() {
  try {
    state.ws = new WebSocket(WS_URL);

    state.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        updateStatusFromServer(data);
      } catch (_) {}
    };

    state.ws.onclose = () => {
      clearTimeout(state.wsRetryTimer);
      state.wsRetryTimer = setTimeout(connectWebSocket, 5000);
    };

    state.ws.onerror = () => state.ws.close();
  } catch (_) {}
}

function updateStatusFromServer(data) {
  if (!data) return;

  // Atualiza metadados da faixa se fornecidos
  if (data.track) {
    updateTrackUI(data.track);
  }

  // Atualiza info de ouvintes no card
  if (!state.playing) {
    if (data.live) {
      setStatus('idle', `${data.listeners} ouvinte${data.listeners !== 1 ? 's' : ''} online — Clique para ouvir`);
    } else {
      setStatus('idle', 'Aguardando transmissão...');
    }
  }
}

function updateTrackUI(track) {
  if (!track) return;
  currentTrackInfo = track;

  const title = track.title || 'Connec Radio';
  const artist = track.artist || (track.title ? '' : 'Transmissão ao vivo');

  if (trackTitle) trackTitle.textContent = title;
  if (trackArtist) {
    trackArtist.textContent = artist;
    trackArtist.style.display = artist ? '' : 'none';
  }

  if (track.duration && track.duration > 0) {
    if (trackTimeTotal) trackTimeTotal.textContent = formatDuration(track.duration);
    if (trackLiveTag) trackLiveTag.style.display = 'none';
  } else {
    if (trackTimeTotal) trackTimeTotal.textContent = 'AO VIVO';
    if (trackLiveTag) trackLiveTag.style.display = '';
  }

  tickTrackProgress();
  if (!trackTimer) {
    trackTimer = setInterval(tickTrackProgress, 500);
  }
}

function tickTrackProgress() {
  if (!currentTrackInfo.startedAt || !currentTrackInfo.title) {
    if (trackTimeElapsed) trackTimeElapsed.textContent = '00:00';
    if (trackProgressFill) trackProgressFill.style.width = '0%';
    return;
  }

  const elapsed = Math.max(0, Math.floor((Date.now() - currentTrackInfo.startedAt) / 1000));
  if (trackTimeElapsed) trackTimeElapsed.textContent = formatDuration(elapsed);

  if (currentTrackInfo.duration && currentTrackInfo.duration > 0) {
    const pct = Math.min(100, (elapsed / currentTrackInfo.duration) * 100);
    if (trackProgressFill) trackProgressFill.style.width = `${pct.toFixed(1)}%`;
  } else {
    // Ao vivo sem duração fixa
    if (trackProgressFill) trackProgressFill.style.width = '100%';
  }
}

async function checkServerStatus() {
  try {
    const r = await fetch(STATUS_URL);
    if (r.ok) {
      const data = await r.json();
      updateStatusFromServer(data);
    }
  } catch (_) {
    setStatus('idle', 'Clique ▶ para ouvir');
  }
}

// ─── Partículas de fundo ──────────────────────────────────────
function setupParticles() {
  const c = document.getElementById('particles-canvas');
  const cx = c.getContext('2d');
  let W, H;
  const particles = [];

  function resize() {
    W = c.width = window.innerWidth;
    H = c.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  for (let i = 0; i < 60; i++) {
    particles.push({
      x: Math.random() * 1920,
      y: Math.random() * 1080,
      r: Math.random() * 1.5 + 0.3,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      a: Math.random() * 0.5 + 0.1,
      hue: 220 + Math.random() * 80,
    });
  }

  function drawParticles() {
    cx.clearRect(0, 0, W, H);
    particles.forEach((p) => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      cx.beginPath();
      cx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      cx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.a})`;
      cx.fill();
    });
    requestAnimationFrame(drawParticles);
  }
  drawParticles();
}
