/**
 * Connec Radio — Servidor WebRTC Próprio
 * Implementa WHIP (ingestão do BUTT) + WHEP (ouvintes)
 * usando Node.js + @roamhq/wrtc
 *
 * Protocolo WHIP: https://www.ietf.org/archive/id/draft-ietf-wish-whip-01.txt
 * Protocolo WHEP: https://www.ietf.org/archive/id/draft-murillo-whep-02.txt
 */

'use strict';

const express      = require('express');
const http         = require('http');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const selfsigned   = require('selfsigned');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

// WebRTC nativo para Node.js
const {
  RTCPeerConnection,
  MediaStream,
  nonstandard: { RTCAudioSource, RTCAudioSink }
} = require('@roamhq/wrtc');

// ─── Configuração via variáveis de ambiente ───────────────────
const PORT         = parseInt(process.env.PORT || '8889');
const HOST         = process.env.HOST         || '0.0.0.0';
const SERVER_IP    = process.env.SERVER_IP    || '127.0.0.1';
const BEARER_TOKEN = process.env.BEARER_TOKEN || '';
const TURN_USER    = process.env.TURN_USER    || 'connecradio';
const TURN_PASS    = process.env.TURN_PASS    || '';
const TURN_SECRET  = process.env.TURN_SECRET  || '';
const multer       = require('multer');
const { exec }     = require('child_process');

const LOCAL_MODE   = process.env.LOCAL_MODE   === 'true';
const PLAYER_DIR   = process.env.PLAYER_DIR   || path.join(__dirname, '..', 'player');
const STUDIO_DIR   = process.env.STUDIO_DIR   || path.join(__dirname, '..', 'studio');
const MEDIA_DIR    = process.env.MEDIA_DIR    || path.join(__dirname, '..', 'media');

// Configuração do Multer para upload de músicas reais no HD
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let targetFolder = req.body.folder || 'musicas';
    targetFolder = targetFolder.replace(/^(\.\.[\/\\])+/, '').replace(/^[\\\/]+/, '');
    const destPath = path.join(MEDIA_DIR, targetFolder);
    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(destPath, { recursive: true });
    }
    cb(null, destPath);
  },
  filename: (req, file, cb) => {
    const cleanName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, cleanName);
  },
});
const upload = multer({ storage });

const AutoDJScheduler = require('./scheduler');
let autoDJ = null;

// ─── Configuração de ICE/STUN/TURN ───────────────────────────
function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
}

// ─── Estado global do servidor ────────────────────────────────

/** Broadcaster atual (somente 1 por vez) */
const broadcaster = {
  pc:        null,   // RTCPeerConnection do BUTT
  sessionId: null,
  audioSink: null,   // RTCAudioSink que lê do broadcaster
  audioSrc:  null,   // RTCAudioSource que envia para os ouvintes
  relayTrack:null,   // MediaStreamTrack derivado do audioSrc
  connectedAt: null,
};

/** Mapa de ouvintes: sessionId → { pc, createdAt } */
const listeners = new Map();

/** Metadados da faixa atual tocando */
const currentTrack = {
  title: '',
  artist: '',
  duration: 0,       // Duração em segundos (0 se ao vivo/desconhecido)
  startedAt: null,   // Timestamp em ms
  raw: '',
};

function parseTrackMetadata(rawText, extra = {}) {
  let text = (rawText || '').trim();
  if (!text || text.startsWith('#')) {
    return {
      title: '',
      artist: '',
      duration: 0,
      startedAt: null,
      raw: '',
    };
  }

  let duration = extra.duration || 0;
  // Verifica se o texto tem duração no formato "(3:45)" ou "[03:45]" no final
  const durationMatch = text.match(/[(\[](\d{1,2}):(\d{2})[)\]]$/);
  if (durationMatch) {
    const mins = parseInt(durationMatch[1], 10);
    const secs = parseInt(durationMatch[2], 10);
    duration = mins * 60 + secs;
    text = text.replace(/[(\[]\d{1,2}:\d{2}[)\]]$/, '').trim();
  }

  let artist = extra.artist || '';
  let title = extra.title || '';

  if (!title) {
    // Tenta separar por " - " (padrão Artista - Música)
    if (text.includes(' - ')) {
      const parts = text.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else {
      title = text;
      artist = '';
    }
  }

  // Remove extensões comuns de arquivo se houver (ex: .mp3, .wav, .flac, .aac, etc)
  title = title.replace(/\.(mp3|wav|flac|aac|m4a|ogg|wma)$/i, '');

  return {
    title,
    artist,
    duration: typeof duration === 'number' && !isNaN(duration) ? duration : 0,
    startedAt: extra.startedAt || Date.now(),
    raw: rawText.trim(),
  };
}

function updateTrack(newMetadata) {
  currentTrack.title     = newMetadata.title;
  currentTrack.artist    = newMetadata.artist;
  currentTrack.duration  = newMetadata.duration;
  currentTrack.startedAt = newMetadata.startedAt;
  currentTrack.raw       = newMetadata.raw;

  console.log(`[Metadata] Tocando agora: ${currentTrack.artist ? currentTrack.artist + ' - ' : ''}${currentTrack.title} (${currentTrack.duration ? currentTrack.duration + 's' : 'ao vivo'})`);
  broadcastStatus();
}

function setupNowPlayingWatcher() {
  const possiblePaths = [
    process.env.NOW_PLAYING_FILE,
    path.join(__dirname, '..', 'nowplaying.txt'),
    path.join(__dirname, 'nowplaying.txt'),
    path.join(__dirname, '..', 'current_song.txt'),
    path.join(__dirname, 'current_song.txt'),
  ].filter(Boolean);

  let lastContent = '';

  const checkFile = () => {
    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (content && content !== lastContent && !content.startsWith('#')) {
            lastContent = content;
            console.log(`[Metadata] Arquivo lido: ${path.basename(filePath)} -> "${content}"`);
            const parsed = parseTrackMetadata(content);
            updateTrack(parsed);
          }
        } catch (_) {}
        break;
      }
    }
  };

  // Checa arquivo a cada 2 segundos
  checkFile();
  setInterval(checkFile, 2000);

  // Checa Media Player Classic (MPC-HC) a cada 1 segundo
  setInterval(checkMpcHc, 1000);
}

// ─── Integração Automática com Media Player Classic (MPC-HC / MPC-BE) ───
let lastMpcTrackKey = '';

async function checkMpcHc() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);
    const res = await fetch('http://127.0.0.1:13579/variables.html', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return;
    const html = await res.text();

    const getVar = (id) => {
      const m = html.match(new RegExp(`<p id="${id}">([\\s\\S]*?)<\\/p>`, 'i'));
      return m ? m[1].trim() : '';
    };

    const stateStr = (getVar('statestring') || '').toLowerCase(); // 'playing', 'paused', 'stopped'
    const fileTitle = getVar('filetitle') || getVar('file');
    const posMs = parseInt(getVar('position') || '0', 10);
    const durMs = parseInt(getVar('duration') || '0', 10);

    if (!fileTitle || stateStr === 'stopped') {
      return;
    }

    const durationSec = Math.round(durMs / 1000);
    const posSec = Math.round(posMs / 1000);
    const trackKey = `${fileTitle}_${durationSec}`;

    // Sincroniza se mudou de faixa ou se desincronizou mais de 3s
    const expectedElapsed = currentTrack.startedAt ? Math.floor((Date.now() - currentTrack.startedAt) / 1000) : 0;
    const needsSync = Math.abs(expectedElapsed - posSec) > 3;

    if (trackKey !== lastMpcTrackKey || needsSync) {
      lastMpcTrackKey = trackKey;
      const startedAt = Date.now() - (posSec * 1000);
      const parsed = parseTrackMetadata(fileTitle, {
        duration: durationSec,
        startedAt,
      });
      updateTrack(parsed);
    }
  } catch (_) {
    // MPC-HC não está rodando com web interface ativa
  }
}

// ─── Utilitários ──────────────────────────────────────────────

/** Aguarda ICE gathering concluir (máximo `ms` milissegundos) */
function waitForIceGathering(pc, ms = 6000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, ms);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

/** Limpa recursos do broadcaster */
function cleanupBroadcaster(reason = 'disconnected') {
  if (!broadcaster.pc) return;
  console.log(`[WHIP] Broadcaster ${broadcaster.sessionId} ${reason}`);

  try { broadcaster.audioSink?.stop(); } catch (_) {}
  try { broadcaster.relayTrack?.stop(); } catch (_) {}
  try { broadcaster.pc.close(); } catch (_) {}

  broadcaster.pc         = null;
  broadcaster.sessionId  = null;
  broadcaster.audioSink  = null;
  broadcaster.audioSrc   = null;
  broadcaster.relayTrack = null;
  broadcaster.connectedAt = null;

  broadcastStatus();
}

/** Limpa recursos de um ouvinte */
function cleanupListener(sessionId, reason = 'disconnected') {
  const entry = listeners.get(sessionId);
  if (!entry) return;
  console.log(`[WHEP] Listener ${sessionId} ${reason}`);
  try { entry.pc.close(); } catch (_) {}
  listeners.delete(sessionId);
  broadcastStatus();
}

/** Envia status atualizado para todos os clientes WebSocket */
function broadcastStatus() {
  const payload = JSON.stringify(getStatus());
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  });
}

function getStatus() {
  const elapsed = (currentTrack.startedAt && currentTrack.title)
    ? Math.max(0, Math.floor((Date.now() - currentTrack.startedAt) / 1000))
    : 0;

  return {
    live:       !!broadcaster.pc || (autoDJ ? autoDJ.state.playing : false),
    listeners:  listeners.size,
    uptime:     broadcaster.connectedAt
      ? Math.floor((Date.now() - broadcaster.connectedAt) / 1000)
      : (autoDJ && autoDJ.state.currentTrack ? elapsed : 0),
    track: {
      ...currentTrack,
      elapsed,
    },
    studio: autoDJ ? {
      playing: autoDJ.state.playing,
      autodj: autoDJ.state.autodj,
      program: autoDJ.getCurrentProgram(),
      queueCount: autoDJ.queue.length,
    } : null,
  };
}

// ─── App Express ──────────────────────────────────────────────
const app = express();

// ─── Servir player web e painel do estúdio ────────────────────
app.use(express.static(PLAYER_DIR));
app.use('/studio', express.static(STUDIO_DIR));
app.use('/admin', (_req, res) => res.redirect('/studio'));
app.use('/media', express.static(MEDIA_DIR));

// Endpoint de configuração dinâmica — player carrega via <script>
// Retorna as URLs do servidor corretas para o ambiente atual
app.get('/config.js', (req, res) => {
  const proto    = LOCAL_MODE ? 'http'  : 'https';
  const wsProto  = LOCAL_MODE ? 'ws'    : 'wss';
  const host     = req.headers.host || `${SERVER_IP}:${PORT}`;
  res.set('Content-Type', 'application/javascript');
  res.send(`
/* Connec Radio — configuração gerada pelo servidor */
window.CONNEC_CONFIG = {
  serverBase: '${proto}://${host}',
  wsUrl:      '${wsProto}://${host}/ws',
  whepUrl:    '${proto}://${host}/whep/radio',
  studioUrl:  '${proto}://${host}/studio',
  turnIp:     '${SERVER_IP}',
  turnUser:   '${TURN_USER}',
  turnCred:   '${TURN_PASS}',
};
  `.trim());
});

// Parse SDP e texto simples
app.use(express.text({ type: 'application/sdp', limit: '100kb' }));
app.use(express.text({ type: 'text/plain', limit: '100kb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CORS (necessário para WHIP/WHEP do browser) ─────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
  res.setHeader('Access-Control-Expose-Headers','ETag, Location, Link');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Logging simples ──────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Middleware de autenticação WHIP ─────────────────────────
function requireBearerToken(req, res, next) {
  if (!BEARER_TOKEN) return next(); // sem token configurado → livre
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${BEARER_TOKEN}`) {
    return res.status(401).set('WWW-Authenticate', 'Bearer').send('Unauthorized');
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
//  WHIP — Ingestão (BUTT → Servidor)
//  POST /whip/:streamId
// ═══════════════════════════════════════════════════════════════
app.post('/whip/:streamId', requireBearerToken, async (req, res) => {
  const { streamId } = req.params;
  const sdpOffer = req.body;

  if (!sdpOffer || typeof sdpOffer !== 'string') {
    return res.status(400).send('Body must be SDP (Content-Type: application/sdp)');
  }

  // Somente 1 broadcaster ativo
  if (broadcaster.pc) {
    return res.status(409)
      .set('Content-Type', 'text/plain')
      .send('Another broadcaster is already active. Disconnect first.');
  }

  console.log(`[WHIP] New broadcaster on stream "${streamId}"`);

  // ── 1. Criar pipeline de relay de áudio ───────────────────
  const audioSource = new RTCAudioSource();
  const relayTrack  = audioSource.createTrack();

  // ── 2. Criar RTCPeerConnection para o broadcaster ─────────
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.ontrack = ({ track }) => {
    if (track.kind !== 'audio') return;
    console.log('[WHIP] Audio track received from broadcaster');
    console.log(`[WHIP] Track state: ${track.readyState}, muted: ${track.muted}`);

    const sink = new RTCAudioSink(track);
    let packetCount = 0;

    const logTimer = setInterval(() => {
      if (packetCount > 0) {
        console.log(`[WHIP] Relay OK: ${packetCount} pacotes/5s`);
        packetCount = 0;
      } else {
        console.warn('[WHIP] Sem pacotes de audio nos ultimos 5s');
      }
    }, 5000);

    sink.ondata = (data) => {
      packetCount++;
      if (packetCount === 1) {
        console.log(`[WHIP] 1o pacote! sampleRate=${data.sampleRate} ch=${data.channelCount}`);
      }
      if (audioSource) {
        try { audioSource.onData(data); } catch (_) {}
      }
    };

    broadcaster.audioSink   = sink;
    broadcaster.logTimer    = logTimer;
    broadcaster.connectedAt = Date.now();
    broadcastStatus();

    track.onended = () => {
      clearInterval(logTimer);
      cleanupBroadcaster('track ended');
    };
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[WHIP] ICE state: ${pc.iceConnectionState}`);
    if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
      cleanupBroadcaster(pc.iceConnectionState);
    }
  };

  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Aguarda ICE gathering para enviar SDP completo
    await waitForIceGathering(pc);
  } catch (err) {
    pc.close();
    console.error('[WHIP] Error creating answer:', err);
    return res.status(500).send('Failed to create WebRTC answer');
  }

  // ── 3. Registrar broadcaster ──────────────────────────────
  broadcaster.pc         = pc;
  broadcaster.sessionId  = uuidv4();
  broadcaster.audioSrc   = audioSource;
  broadcaster.relayTrack = relayTrack;

  console.log(`[WHIP] Session ${broadcaster.sessionId} established`);

  // ── 4. Retornar SDP answer com Location ───────────────────
  res.status(201)
    .set('Content-Type', 'application/sdp')
    .set('Location', `/whip/${streamId}/${broadcaster.sessionId}`)
    .set('Link', `<stun:stun.l.google.com:19302>; rel="ice-server"`)
    .send(pc.localDescription.sdp);
});

// DELETE /whip/:streamId/:sessionId — broadcaster desconecta
app.delete('/whip/:streamId/:sessionId', requireBearerToken, (req, res) => {
  const { sessionId } = req.params;
  if (broadcaster.sessionId !== sessionId) return res.sendStatus(404);
  cleanupBroadcaster('DELETE request');
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════
//  WHEP — Playback (Ouvintes → Servidor)
//  POST /whep/:streamId
// ═══════════════════════════════════════════════════════════════
app.post('/whep/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const sdpOffer = req.body;

  if (!sdpOffer || typeof sdpOffer !== 'string') {
    return res.status(400).send('Body must be SDP (Content-Type: application/sdp)');
  }

  if (!broadcaster.relayTrack) {
    return res.status(404)
      .set('Content-Type', 'text/plain')
      .send('No active broadcast. Tune in later!');
  }

  const sessionId = uuidv4();
  console.log(`[WHEP] New listener ${sessionId} on stream "${streamId}"`);

  const pc = new RTCPeerConnection({ iceServers: getIceServers() });

  // Adiciona o track de relay ao listener
  const stream = new MediaStream([broadcaster.relayTrack]);
  pc.addTrack(broadcaster.relayTrack, stream);

  pc.oniceconnectionstatechange = () => {
    console.log(`[WHEP] Listener ${sessionId} ICE: ${pc.iceConnectionState}`);
    if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
      cleanupListener(sessionId, pc.iceConnectionState);
    }
  };

  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
  } catch (err) {
    pc.close();
    console.error('[WHEP] Error creating answer:', err);
    return res.status(500).send('Failed to create WebRTC answer');
  }

  listeners.set(sessionId, { pc, createdAt: Date.now() });
  broadcastStatus();

  console.log(`[WHEP] Listener ${sessionId} connected (total: ${listeners.size})`);

  res.status(201)
    .set('Content-Type', 'application/sdp')
    .set('Location', `/whep/${streamId}/${sessionId}`)
    .set('Link', `<stun:stun.l.google.com:19302>; rel="ice-server"`)
    .send(pc.localDescription.sdp);
});

// GET /whep/:streamId — redireciona navegadores para o player web
app.get('/whep/:streamId', (_req, res) => res.redirect('/'));
app.get('/whip/:streamId', (_req, res) => res.redirect('/'));

// DELETE /whep/:streamId/:sessionId — ouvinte desconecta
app.delete('/whep/:streamId/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!listeners.has(sessionId)) return res.sendStatus(404);
  cleanupListener(sessionId, 'DELETE request');
  res.sendStatus(200);
});

// ─── API de Metadados (Tocando Agora / Faixa Atual) ───────────
app.post(['/metadata', '/api/metadata'], (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = { raw: body }; }
  } else if (!body || typeof body !== 'object') {
    body = {};
  }

  const raw = body.raw || body.song || body.track || (body.artist && body.title ? `${body.artist} - ${body.title}` : (body.title || ''));
  const duration = parseInt(body.duration || body.time || 0);
  const parsed = parseTrackMetadata(raw, {
    title: body.title,
    artist: body.artist,
    duration: isNaN(duration) ? 0 : duration,
    startedAt: body.startedAt || Date.now(),
  });

  updateTrack(parsed);
  res.json({ ok: true, track: getStatus().track });
});

app.get(['/metadata', '/api/metadata'], (_req, res) => {
  res.json(getStatus().track);
});

// ─── API do Estúdio & AutoDJ ──────────────────────────────────
app.get('/api/studio/status', (_req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  res.json(autoDJ.getStudioStatus());
});

app.post('/api/studio/control', (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  const { action, trackId, jingleId } = req.body || {};

  switch (action) {
    case 'play':
    case 'resume':
      autoDJ.resume();
      break;
    case 'pause':
      autoDJ.pause();
      break;
    case 'skip':
    case 'next':
      autoDJ.nextTrack();
      break;
    case 'toggle_autodj':
      autoDJ.state.autodj = !autoDJ.state.autodj;
      autoDJ.broadcastStudioUpdate();
      break;
    case 'play_track':
      if (trackId) autoDJ.playSpecific(trackId);
      break;
    case 'trigger_jingle':
      autoDJ.triggerJingleInstant(jingleId);
      break;
    case 'toggle_mic':
      autoDJ.state.micActive = !autoDJ.state.micActive;
      autoDJ.broadcastStudioUpdate();
      break;
    default:
      return res.status(400).json({ error: 'Invalid action' });
  }

  res.json({ ok: true, status: autoDJ.getStudioStatus() });
});

app.get('/api/studio/schedule', (_req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  res.json(autoDJ.scheduleConfig);
});

app.post('/api/studio/schedule', (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  const schedule = req.body;
  if (!Array.isArray(schedule)) {
    return res.status(400).json({ error: 'Schedule must be an array' });
  }
  const ok = autoDJ.saveSchedule(schedule);
  res.json({ ok, schedule: autoDJ.scheduleConfig });
});

// Forçar reprodução imediata de um programa da grade
app.post('/api/studio/play-program', (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  const { programId } = req.body || {};
  const ok = autoDJ.playProgramNow(programId);
  res.json({ ok, status: autoDJ.getStudioStatus() });
});

app.get('/api/studio/library', (_req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  res.json({
    tracks: autoDJ.library,
    playlists: autoDJ.playlistsConfig,
  });
});

app.post('/api/studio/scan', (_req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  autoDJ.scanLibrary();
  autoDJ.refillQueue();
  res.json({ ok: true, total: autoDJ.library.length, library: autoDJ.library });
});

// Upload de arquivos de áudio reais para a pasta selecionada
app.post('/api/studio/upload', upload.array('files', 100), (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  autoDJ.scanLibrary();
  autoDJ.refillQueue();
  res.json({
    ok: true,
    uploaded: req.files ? req.files.length : 0,
    files: autoDJ.library,
  });
});

// Abrir pasta no Windows Explorer nativo
app.post('/api/studio/open-folder', (req, res) => {
  const folder = req.body.folder || '';
  const cleanFolder = folder.replace(/^(\.\.[\/\\])+/, '').replace(/^[\\\/]+/, '');
  const targetPath = path.join(MEDIA_DIR, cleanFolder);
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }

  const winCmd = `explorer.exe "${targetPath}"`;
  exec(winCmd, (err) => {
    if (err) console.error('[Explorer] Erro ao abrir pasta:', err);
  });

  res.json({ ok: true, path: targetPath });
});

// Excluir faixa de áudio do HD
app.post('/api/studio/delete-track', (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  const { trackId } = req.body || {};
  const ok = autoDJ.deleteTrack(trackId);
  res.json({ ok, library: autoDJ.library });
});

// Adicionar faixa específica à fila
app.post('/api/studio/add-to-queue', (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  const { trackId } = req.body || {};
  const ok = autoDJ.addToQueue(trackId);
  res.json({ ok, status: autoDJ.getStudioStatus() });
});

// Criar nova playlist / subpasta em media/musicas
app.post('/api/studio/create-playlist', (req, res) => {
  if (!autoDJ) return res.status(503).json({ error: 'AutoDJ not initialized' });
  const { name, folder, color } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Nome da playlist é obrigatório' });
  }

  const cleanFolder = (folder || name).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const dirPath = path.join(MEDIA_DIR, 'musicas', cleanFolder);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const playlistsConfig = autoDJ.playlistsConfig || { playlists: [] };
  const existing = playlistsConfig.playlists.find(p => p.id === cleanFolder);
  if (!existing) {
    playlistsConfig.playlists.push({
      id: cleanFolder,
      name: name.trim(),
      folder: `musicas/${cleanFolder}`,
      color: color || '#8B5CF6',
    });
    autoDJ.savePlaylistsConfig(playlistsConfig);
  }

  autoDJ.scanLibrary();
  res.json({ ok: true, playlists: autoDJ.playlistsConfig });
});

// ─── API de Status ────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({
    ...getStatus(),
    server: 'Connec Radio WebRTC',
    version: '1.0.0',
  });
});

// ─── Health check simples ─────────────────────────────────────
app.get('/health', (_req, res) => res.sendStatus(200));

// ─── 404 fallback ─────────────────────────────────────────────
app.use((_req, res) => res.sendStatus(404));

// ═══════════════════════════════════════════════════════════════
//  HTTP ou HTTPS + WebSocket Server
//  USE_HTTPS=true  → HTTPS com certificado auto-assinado (para IP público)
//  USE_HTTPS=false → HTTP puro (apenas localhost, sem ouvintes externos)
// ═══════════════════════════════════════════════════════════════
const USE_HTTPS = process.env.USE_HTTPS !== 'false'; // padrão: HTTPS ativado

let serverInstance;

if (USE_HTTPS) {
  // Gera certificado auto-assinado em memória com o IP do servidor
  console.log('[SSL] Gerando certificado auto-assinado...');
  const attrs = [{ name: 'commonName', value: SERVER_IP || 'connecradio.local' }];
  const pems  = selfsigned.generate(attrs, {
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: [
        SERVER_IP ? { type: 7, ip: SERVER_IP } : { type: 2, value: 'localhost' }
      ]}
    ]
  });
  console.log('[SSL] Certificado gerado. Ouvintes precisarão aceitar no browser na 1ª vez.');
  serverInstance = https.createServer({ key: pems.private, cert: pems.cert }, app);
} else {
  console.log('[HTTP] Modo HTTP puro (somente localhost, sem HTTPS)');
  serverInstance = http.createServer(app);
}

const wss = new WebSocketServer({ server: serverInstance, path: '/ws' });

wss.on('connection', (ws) => {
  // Envia status imediato ao conectar
  ws.send(JSON.stringify(getStatus()));

  // Ping/pong para manter conexão viva
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30_000);

  ws.on('close', () => clearInterval(ping));
});

serverInstance.listen(PORT, HOST, () => {
  // Inicializa o Motor AutoDJ e Calendário
  autoDJ = new AutoDJScheduler({
    updateTrack,
    broadcastStatus,
    currentTrack,
  });
  autoDJ.startAutoDJ();

  // Inicia monitoramento de arquivo de metadados
  setupNowPlayingWatcher();

  const proto   = USE_HTTPS ? 'https' : 'http';
  const wsProto = USE_HTTPS ? 'wss'   : 'ws';
  const display = `${SERVER_IP || 'localhost'}:${PORT}`;
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log(`║  Connec Radio — WebRTC ${USE_HTTPS ? 'HTTPS' : 'HTTP '} Server         ║`);
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  Player:    ${proto}://${display}`);
  console.log(`║  Estúdio:   ${proto}://${display}/studio      (AutoDJ)`);
  console.log(`║  WHIP:      ${proto}://${display}/whip/radio  (BUTT/OBS)`);
  console.log(`║  WHEP:      ${proto}://${display}/whep/radio  (Ouvintes)`);
  console.log(`║  Status:    ${proto}://${display}/status`);
  console.log('╚════════════════════════════════════════════════╝');
  if (USE_HTTPS) {
    console.log(`
  ⚠️  Browser: abra ${proto}://${display}/status`);
    console.log('       Clique em “Avançado” → “Prosseguir” para confiar no certificado.');
    console.log('       Faça isso antes de abrir o player!\n');
  }
  console.log('');
});

// ─── Error handling para evitar encerramento inesperado ───────────
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
});

// ─── Graceful shutdown ────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  cleanupBroadcaster('server shutdown');
  listeners.forEach((_, id) => cleanupListener(id, 'server shutdown'));
  serverInstance.close(() => process.exit(0));
});
process.on('SIGINT', () => process.emit('SIGTERM'));
