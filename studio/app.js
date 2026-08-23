/**
 * Connec Radio Studio & AutoDJ — Client Controller (app.js)
 * 100% Integrado com Arquivos Reais de Áudio no HD
 */

'use strict';

const cfg = window.CONNEC_CONFIG || {};
const SERVER_BASE = cfg.serverBase || `${location.protocol}//${location.host}`;
const WS_URL      = cfg.wsUrl      || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// ─── Estado do Estúdio ─────────────────────────────────────────
const studio = {
  status:         null,
  ws:             null,
  wsRetry:        null,
  clockTimer:     null,
  levelTimer:     null,
  selectedFolder: null, // Objeto da pasta/playlist selecionada
  micActive:      false,
  micStream:      null,
};

// ─── DOM References ───────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const studioClock         = $('studio-clock');
const headerShowName      = $('header-show-name');
const deckCard            = document.querySelector('.deck-card');
const deckTrackTitle      = $('deck-track-title');
const deckTrackArtist     = $('deck-track-artist');
const deckTrackType       = $('deck-track-type');
const deckProgName        = $('deck-prog-name');
const deckProgressFill    = $('deck-progress-fill');
const deckTimeElapsed     = $('deck-time-elapsed');
const deckTimeRemaining   = $('deck-time-remaining');
const deckTimeTotal       = $('deck-time-total');
const btnDeckPlay         = $('btn-deck-play');
const deckIconPlay        = $('deck-icon-play');
const deckIconPause       = $('deck-icon-pause');
const btnDeckNext         = $('btn-deck-next');
const btnDeckPrev         = $('btn-deck-prev');
const btnModeAutoDJ       = $('btn-mode-autodj');
const btnModeManual       = $('btn-mode-manual');
const queueList           = $('queue-list');
const queueCount          = $('queue-count');
const btnReshuffle        = $('btn-reshuffle');
const btnInsertJingle     = $('btn-insert-jingle');
const btnMicToggle        = $('btn-mic-toggle');
const micStatusLabel      = $('mic-status-label');
const duckingIndicator    = $('ducking-indicator');
const meterL              = $('meter-l');
const meterR              = $('meter-r');
const weeklyGrid          = $('weekly-schedule-grid');
const historyList         = $('history-list');

// Biblioteca / Gerenciador de Pastas do HD
const libraryOverviewView = $('library-overview-view');
const libraryFolderView   = $('library-folder-detail-view');
const libraryGrid         = $('library-categories-grid');
const libraryStats        = $('library-stats');
const btnRescanMedia      = $('btn-rescan-media');
const btnOpenMediaRoot    = $('btn-open-media-root');
const btnNewPlaylist      = $('btn-new-playlist');
const btnBackLibrary      = $('btn-back-library');
const folderDetailTitle   = $('folder-detail-title');
const folderDetailPath    = $('folder-detail-path');
const btnOpenCurrentFolder= $('btn-open-current-folder');
const btnRefreshFolder    = $('btn-refresh-folder');
const inputAudioUpload    = $('input-audio-upload');
const dropzoneArea        = $('dropzone-area');
const uploadProgressBar   = $('upload-progress-bar');
const uploadProgressFill  = $('upload-progress-fill');
const uploadProgressText  = $('upload-progress-text');
const tracksTableBody     = $('tracks-table-body');

// Modais
const modalProgram        = $('modal-program');
const btnAddProgram       = $('btn-add-program');
const btnCloseModal       = $('btn-close-modal');
const btnCancelModal      = $('btn-cancel-modal');
const btnDeleteProg       = $('btn-delete-prog');
const formProgram         = $('form-program');

const modalPlaylist       = $('modal-playlist');
const btnClosePlaylistModal = $('btn-close-playlist-modal');
const btnCancelPlaylistModal = $('btn-cancel-playlist-modal');
const formNewPlaylist     = $('form-new-playlist');

// ─── Inicialização ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initTabs();
  initWebSocket();
  fetchStudioStatus();
  initControls();
  initLibraryAndUpload();
  initSoundboard();
  initModals();
  startMeterSimulation();
});

// ─── 1. Relógio ───────────────────────────────────────────────
function initClock() {
  const updateClock = () => {
    const d = new Date();
    studioClock.textContent = d.toLocaleTimeString('pt-BR', { hour12: false });
  };
  updateClock();
  studio.clockTimer = setInterval(updateClock, 1000);
}

// ─── 2. WebSocket & Sincronização ─────────────────────────────
function initWebSocket() {
  try {
    studio.ws = new WebSocket(WS_URL);

    studio.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.studio) {
          fetchStudioStatus();
        } else if (data.track) {
          updateDeckFromTrack(data.track);
        }
      } catch (_) {}
    };

    studio.ws.onclose = () => {
      clearTimeout(studio.wsRetry);
      studio.wsRetry = setTimeout(initWebSocket, 4000);
    };

    studio.ws.onerror = () => studio.ws.close();
  } catch (_) {}
}

async function fetchStudioStatus() {
  try {
    const res = await fetch(`${SERVER_BASE}/api/studio/status`);
    if (res.ok) {
      const data = await res.json();
      studio.status = data;
      renderStudioState(data);
    }
  } catch (err) {
    console.warn('[Studio] Erro ao buscar status:', err);
  }
}

// ─── Motor de Áudio Nativo do Estúdio ──────────────────────────
studio.audioPlayer = new Audio();
studio.audioPlayer.preload = 'auto';

studio.audioPlayer.onended = () => {
  sendControl('next');
};

studio.audioPlayer.onerror = (e) => {
  console.warn('[Studio Audio] Erro ao carregar arquivo de áudio:', e);
};

studio.audioPlayer.ontimeupdate = () => {
  updateDeckProgressSmooth();
};

// Atualizador suave e contínuo da barra de tempo (4x por segundo)
function updateDeckProgressSmooth() {
  if (!studio.status?.playing || !studio.status?.currentTrack) return;

  const track = studio.status.currentTrack;
  let elapsed = 0;
  let duration = track.duration || 180;

  if (studio.audioPlayer && !studio.audioPlayer.paused && studio.audioPlayer.duration && !isNaN(studio.audioPlayer.duration)) {
    elapsed = Math.floor(studio.audioPlayer.currentTime);
    duration = Math.floor(studio.audioPlayer.duration) || duration;
  } else if (track.startedAt) {
    elapsed = Math.max(0, Math.floor((Date.now() - track.startedAt) / 1000));
  } else if (track.elapsed !== undefined) {
    elapsed = track.elapsed;
  }

  const remaining = Math.max(0, duration - elapsed);
  const pct = Math.min(100, Math.max(0, (elapsed / duration) * 100));

  deckTimeElapsed.textContent = formatTime(elapsed);
  deckTimeRemaining.textContent = `-${formatTime(remaining)}`;
  deckTimeTotal.textContent = formatTime(duration);
  deckProgressFill.style.width = `${pct.toFixed(2)}%`;
}

// Inicia loop de atualização contínua
setInterval(updateDeckProgressSmooth, 250);

// ─── 3. Renderizar Estado Geral ───────────────────────────────
function renderStudioState(data) {
  if (!data) return;

  // Programa atual da grade
  if (data.currentProgram) {
    headerShowName.textContent = `${data.currentProgram.name} (${data.currentProgram.startTime || '00:00'} - ${data.currentProgram.endTime || '23:59'})`;
    deckProgName.textContent = data.currentProgram.name;
    deckProgName.style.borderColor = data.currentProgram.color || 'var(--purple)';
    deckProgName.style.color = data.currentProgram.color || 'var(--purple-lt)';
  }

  // Modo AutoDJ
  if (data.autodj) {
    btnModeAutoDJ.classList.add('active');
    btnModeManual.classList.remove('active');
  } else {
    btnModeAutoDJ.classList.remove('active');
    btnModeManual.classList.add('active');
  }

  // Estado do Deck
  if (data.playing) {
    deckCard.classList.add('playing');
    deckIconPlay.style.display = 'none';
    deckIconPause.style.display = '';
  } else {
    deckCard.classList.remove('playing');
    deckIconPlay.style.display = '';
    deckIconPause.style.display = 'none';
  }

  // Faixa Atual
  if (data.currentTrack) {
    updateDeckFromTrack(data.currentTrack);
  } else {
    deckTrackTitle.textContent = 'Aguardando músicas...';
    deckTrackArtist.textContent = 'Adicione arquivos MP3 na aba Biblioteca';
    deckProgressFill.style.width = '0%';
    deckTimeElapsed.textContent = '00:00';
    deckTimeRemaining.textContent = '-00:00';
    deckTimeTotal.textContent = '00:00';
  }

  // Reprodução de áudio real no navegador
  if (data.playing && data.currentTrack && data.currentTrack.path) {
    const rawPath = data.currentTrack.path.replace(/\\/g, '/');
    const audioUrl = `${SERVER_BASE}/media/${encodeURI(rawPath).replace(/#/g, '%23')}`;

    if (studio.audioPlayer.src !== audioUrl) {
      studio.audioPlayer.src = audioUrl;
      if (data.currentTrack.elapsed && data.currentTrack.elapsed > 2) {
        try { studio.audioPlayer.currentTime = data.currentTrack.elapsed; } catch (_) {}
      }
      studio.audioPlayer.play().catch(() => {
        console.log('[Studio Audio] Autoplay: clique no Play para liberar áudio');
      });
    } else if (studio.audioPlayer.paused) {
      studio.audioPlayer.play().catch(() => {});
    }
  } else {
    if (!studio.audioPlayer.paused) {
      studio.audioPlayer.pause();
    }
  }

  // Fila (Queue)
  renderQueue(data.queue || []);

  // Grade Semanal
  if (data.schedule) {
    renderWeeklySchedule(data.schedule);
  }

  // Biblioteca
  if (data.playlists) {
    renderLibraryOverview(data.playlists, data.libraryStats, data.allTracks || []);
  }

  // Se estiver com uma pasta aberta no detalhe, atualiza a lista de faixas
  if (studio.selectedFolder && data.allTracks) {
    renderFolderTracks(studio.selectedFolder, data.allTracks);
  }

  // Histórico
  if (data.history) {
    renderHistory(data.history);
  }
}

function updateDeckFromTrack(track) {
  if (!track) return;

  deckTrackTitle.textContent = track.title || track.filename || 'Sem título';
  deckTrackArtist.textContent = track.artist || (track.sizeFormatted ? `Arquivo: ${track.sizeFormatted}` : '');

  const type = track.type || 'music';
  deckTrackType.textContent = type === 'jingle' ? '⚡ VINHETA' : type === 'commercial' ? '📢 COMERCIAL' : '🎵 MÚSICA';
  deckTrackType.className = `badge-type ${type}`;

  const duration = track.duration || 180;
  const elapsed = track.elapsed !== undefined ? track.elapsed : (track.startedAt ? Math.max(0, Math.floor((Date.now() - track.startedAt) / 1000)) : 0);
  const remaining = Math.max(0, duration - elapsed);

  deckTimeElapsed.textContent = formatTime(elapsed);
  deckTimeRemaining.textContent = `-${formatTime(remaining)}`;
  deckTimeTotal.textContent = formatTime(duration);

  const pct = Math.min(100, (elapsed / duration) * 100);
  deckProgressFill.style.width = `${pct.toFixed(1)}%`;
}

// ─── 4. Fila (Queue) ──────────────────────────────────────────
function renderQueue(queue) {
  queueCount.textContent = `${queue.length} faixa${queue.length !== 1 ? 's' : ''}`;

  if (queue.length === 0) {
    queueList.innerHTML = '<div class="queue-empty">Nenhuma música na fila. Adicione músicas na aba <strong>Biblioteca</strong> para o AutoDJ começar a tocar.</div>';
    return;
  }

  queueList.innerHTML = queue.map((item, idx) => {
    const isJingle = item.type === 'jingle';
    const tagClass = isJingle ? 'jingle' : 'music';
    const tagText = isJingle ? 'Vinheta' : 'Música';
    const dur = formatTime(item.duration || 180);
    const title = item.title || item.filename || 'Faixa de Áudio';
    const artist = item.artist || item.subcategory || '';

    return `
      <div class="queue-item">
        <div class="queue-item-left">
          <span class="queue-index">${idx + 1}</span>
          <div class="queue-track-meta">
            <div class="queue-item-title">${escapeHtml(title)}</div>
            <div class="queue-item-artist">${escapeHtml(artist)}</div>
          </div>
        </div>
        <div class="queue-item-right">
          <span class="queue-item-tag ${tagClass}">${tagText}</span>
          <span class="queue-item-dur">${dur}</span>
          <button class="btn-queue-play" onclick="playTrackNow('${item.id}')" title="Tocar esta agora">▶</button>
        </div>
      </div>
    `;
  }).join('');
}

// ─── 5. Biblioteca & Gerenciador de Pastas do HD ──────────────
function renderLibraryOverview(playlistsConfig, stats, allTracks) {
  if (stats) {
    libraryStats.innerHTML = `
      <span>🎵 <strong>${stats.totalTracks || 0}</strong> Músicas</span> &nbsp;•&nbsp;
      <span>⚡ <strong>${stats.totalJingles || 0}</strong> Vinhetas</span> &nbsp;•&nbsp;
      <span>📢 <strong>${stats.totalCommercials || 0}</strong> Comerciais</span>
    `;
  }

  // Lista padrão de categorias + playlists criadas
  const folders = [
    { id: 'todas', name: 'Todas as Músicas', folder: 'musicas', color: '#06B6D4' },
    ...(playlistsConfig.playlists || []),
    { id: 'vinhetas', name: 'Vinhetas da Rádio', folder: 'vinhetas', color: '#F59E0B' },
    { id: 'comerciais', name: 'Comerciais & Spots', folder: 'comerciais', color: '#F43F5E' },
  ];

  libraryGrid.innerHTML = folders.map(f => {
    // Conta quantas faixas reais existem nesta pasta
    const count = allTracks.filter(t => {
      if (f.folder === 'musicas') return t.category === 'musicas';
      if (f.folder === 'vinhetas') return t.category === 'vinhetas';
      if (f.folder === 'comerciais') return t.category === 'comerciais';
      return t.path && t.path.startsWith(f.folder);
    }).length;

    return `
      <div class="playlist-card" style="border-top: 3px solid ${f.color || 'var(--cyan)'}" onclick="openFolderDetail('${f.id}', '${escapeHtml(f.name)}', '${f.folder}', '${f.color || '#06B6D4'}')">
        <div class="playlist-header">
          <span class="playlist-title" style="color: ${f.color || '#fff'}">${escapeHtml(f.name)}</span>
          <span class="playlist-count">${count} arquivo${count !== 1 ? 's' : ''}</span>
        </div>
        <div class="playlist-folder">Pasta: media/${f.folder}</div>
        <div class="playlist-click-hint">📁 Clique para abrir a pasta e adicionar músicas →</div>
      </div>
    `;
  }).join('');
}

window.openFolderDetail = (id, name, folder, color) => {
  studio.selectedFolder = { id, name, folder, color };
  libraryOverviewView.style.display = 'none';
  libraryFolderView.style.display = 'block';

  folderDetailTitle.textContent = name;
  folderDetailTitle.style.color = color || '#fff';
  folderDetailPath.textContent = `media/${folder}`;

  renderFolderTracks(studio.selectedFolder, studio.status?.allTracks || []);
};

function renderFolderTracks(folderObj, allTracks) {
  const folder = folderObj.folder;

  // Filtra as faixas desta pasta
  const tracks = allTracks.filter(t => {
    if (folder === 'musicas') return t.category === 'musicas';
    if (folder === 'vinhetas') return t.category === 'vinhetas';
    if (folder === 'comerciais') return t.category === 'comerciais';
    return t.path && t.path.startsWith(folder);
  });

  if (tracks.length === 0) {
    tracksTableBody.innerHTML = `
      <div class="empty-folder-state">
        <strong>Esta pasta está vazia</strong>
        <span>Arraste seus arquivos MP3 para o quadro acima ou clique em <strong>⬆️ Adicionar MP3s do HD</strong>.</span>
      </div>
    `;
    return;
  }

  tracksTableBody.innerHTML = tracks.map((track, idx) => {
    const dur = formatTime(track.duration || 180);
    const size = track.sizeFormatted || '—';

    return `
      <div class="track-row">
        <span class="col-num">${idx + 1}</span>
        <span class="col-title" title="${escapeHtml(track.filename)}">${escapeHtml(track.title)}</span>
        <span class="col-artist" title="${escapeHtml(track.artist)}">${escapeHtml(track.artist || '—')}</span>
        <span class="col-size">${size}</span>
        <span class="col-dur">${dur}</span>
        <div class="col-actions track-row-actions">
          <button class="btn-row-action btn-row-play" onclick="playTrackNow('${track.id}')" title="Tocar agora no AutoDJ">▶ Tocar</button>
          <button class="btn-row-action btn-row-queue" onclick="addToQueue('${track.id}')" title="Adicionar à fila">+ Fila</button>
          <button class="btn-row-action btn-row-del" onclick="deleteTrack('${track.id}', '${escapeHtml(track.title)}')" title="Excluir arquivo do disco">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

function initLibraryAndUpload() {
  // Voltar às playlists
  btnBackLibrary.addEventListener('click', () => {
    studio.selectedFolder = null;
    libraryFolderView.style.display = 'none';
    libraryOverviewView.style.display = 'block';
  });

  // Abrir pasta raiz no Windows
  btnOpenMediaRoot.addEventListener('click', () => openFolderInWindows(''));
  btnOpenCurrentFolder.addEventListener('click', () => {
    if (studio.selectedFolder) openFolderInWindows(studio.selectedFolder.folder);
  });

  // Re-escanear
  btnRescanMedia.addEventListener('click', () => rescanLibrary());
  btnRefreshFolder.addEventListener('click', () => rescanLibrary());

  // Input de Upload de arquivos
  inputAudioUpload.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesUpload(e.target.files);
    }
  });

  // Drag & Drop no Dropzone
  dropzoneArea.addEventListener('click', () => inputAudioUpload.click());

  dropzoneArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneArea.classList.add('dragover');
  });

  dropzoneArea.addEventListener('dragleave', () => {
    dropzoneArea.classList.remove('dragover');
  });

  dropzoneArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneArea.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesUpload(e.dataTransfer.files);
    }
  });
}

async function openFolderInWindows(folder) {
  try {
    await fetch(`${SERVER_BASE}/api/studio/open-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
  } catch (err) {
    console.error('[Open Folder] Erro:', err);
  }
}

async function rescanLibrary() {
  btnRescanMedia.textContent = 'Escaneando...';
  try {
    await fetch(`${SERVER_BASE}/api/studio/scan`, { method: 'POST' });
    await fetchStudioStatus();
  } finally {
    btnRescanMedia.textContent = '🔄 Re-escanear Disco';
  }
}

async function handleFilesUpload(fileList) {
  const targetFolder = studio.selectedFolder ? studio.selectedFolder.folder : 'musicas';
  const formData = new FormData();
  formData.append('folder', targetFolder);

  for (let i = 0; i < fileList.length; i++) {
    formData.append('files', fileList[i]);
  }

  uploadProgressBar.style.display = 'block';
  uploadProgressFill.style.width = '20%';
  uploadProgressText.textContent = `Enviando ${fileList.length} arquivo(s) para media/${targetFolder}...`;

  try {
    uploadProgressFill.style.width = '60%';
    const res = await fetch(`${SERVER_BASE}/api/studio/upload`, {
      method: 'POST',
      body: formData,
    });

    if (res.ok) {
      uploadProgressFill.style.width = '100%';
      uploadProgressText.textContent = 'Arquivos adicionados com sucesso!';
      setTimeout(() => {
        uploadProgressBar.style.display = 'none';
        uploadProgressFill.style.width = '0%';
      }, 1500);

      await fetchStudioStatus();
    } else {
      throw new Error('Falha no upload');
    }
  } catch (err) {
    alert('Erro ao enviar arquivos de áudio: ' + err.message);
    uploadProgressBar.style.display = 'none';
  } finally {
    inputAudioUpload.value = '';
  }
}

window.addToQueue = async (trackId) => {
  await fetch(`${SERVER_BASE}/api/studio/add-to-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId }),
  });
  await fetchStudioStatus();
};

window.deleteTrack = async (trackId, title) => {
  if (!confirm(`Deseja excluir "${title}" permanentemente do seu computador?`)) return;

  await fetch(`${SERVER_BASE}/api/studio/delete-track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId }),
  });
  await fetchStudioStatus();
};

// ─── 6. Grade de Programação por Calendário ───────────────────
const DAYS_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function renderWeeklySchedule(schedule) {
  const todayIdx = new Date().getDay();
  const curTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  weeklyGrid.innerHTML = DAYS_NAMES.map((name, dayIdx) => {
    const isToday = dayIdx === todayIdx;

    const dayShows = schedule
      .filter(s => s.days && s.days.includes(dayIdx))
      .sort((a, b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));

    const showsHtml = dayShows.map(show => {
      const isCurrent = isToday && curTime >= show.startTime && curTime < show.endTime;
      const color = show.color || '#06B6D4';

      return `
        <div class="show-card ${isCurrent ? 'is-current' : ''}" style="border-left-color: ${color}" onclick="openEditProgram('${show.id}')">
          <div class="show-time">${show.startTime} - ${show.endTime}</div>
          <div class="show-title">${escapeHtml(show.name)}</div>
          <span class="show-playlist-badge" style="color: ${color}">● ${escapeHtml(show.playlist || 'Geral')}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="day-column ${isToday ? 'today' : ''}">
        <div class="day-header">
          <span class="day-name">${name} ${isToday ? '(Hoje)' : ''}</span>
        </div>
        <div class="day-shows-list">
          ${showsHtml || '<div class="queue-empty">Sem programas</div>'}
        </div>
      </div>
    `;
  }).join('');
}

// ─── 7. Histórico ─────────────────────────────────────────────
function renderHistory(history) {
  if (history.length === 0) {
    historyList.innerHTML = '<div class="history-empty">Nenhuma música no histórico recente ainda.</div>';
    return;
  }

  historyList.innerHTML = history.map(item => {
    const timeStr = item.playedAt ? new Date(item.playedAt).toLocaleTimeString('pt-BR') : '';
    return `
      <div class="queue-item">
        <div class="queue-item-left">
          <span class="queue-index">⏱️</span>
          <div class="queue-track-meta">
            <div class="queue-item-title">${escapeHtml(item.title)}</div>
            <div class="queue-item-artist">${escapeHtml(item.artist || item.filename || 'Connec Radio')}</div>
          </div>
        </div>
        <div class="queue-item-right">
          <span class="queue-item-dur">${timeStr}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ─── 8. Controles do Deck ─────────────────────────────────────
function initControls() {
  btnDeckPlay.addEventListener('click', async () => {
    const isPlaying = studio.status?.playing;
    await sendControl(isPlaying ? 'pause' : 'resume');
  });

  btnDeckNext.addEventListener('click', async () => {
    await sendControl('skip');
  });

  btnDeckPrev.addEventListener('click', async () => {
    await sendControl('skip');
  });

  btnModeAutoDJ.addEventListener('click', async () => {
    await sendControl('toggle_autodj');
  });
  btnModeManual.addEventListener('click', async () => {
    await sendControl('toggle_autodj');
  });

  btnReshuffle.addEventListener('click', async () => {
    await fetchStudioStatus();
  });

  btnInsertJingle.addEventListener('click', async () => {
    await sendControl('trigger_jingle');
  });

  btnMicToggle.addEventListener('click', () => toggleMicrophone());

  // Clique na barra de progresso para avançar/retroceder (Seek)
  const progressBarEl = $('deck-progress-bar');
  if (progressBarEl) {
    progressBarEl.addEventListener('click', (e) => {
      if (!studio.audioPlayer || !studio.audioPlayer.duration || isNaN(studio.audioPlayer.duration)) return;
      const rect = progressBarEl.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      studio.audioPlayer.currentTime = ratio * studio.audioPlayer.duration;
      updateDeckProgressSmooth();
    });
  }
}

async function sendControl(action, payload = {}) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/studio/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status) renderStudioState(data.status);
    }
  } catch (err) {
    console.error('[Studio Control] Erro:', err);
  }
}

window.playTrackNow = async (trackId) => {
  await sendControl('play_track', { trackId });
};

// ─── 9. Soundboard / Vinhetas ─────────────────────────────────
function initSoundboard() {
  const sbButtons = document.querySelectorAll('.btn-soundboard');
  sbButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const jingleId = btn.dataset.jingle;
      btn.style.transform = 'scale(0.92)';
      setTimeout(() => btn.style.transform = '', 150);
      await sendControl('trigger_jingle', { jingleId });
    });
  });
}

// ─── 10. Microfone & Auto-Ducking ─────────────────────────────
async function toggleMicrophone() {
  if (studio.micActive) {
    studio.micActive = false;
    btnMicToggle.classList.remove('active');
    micStatusLabel.textContent = 'MICROFONE DESLIGADO';
    duckingIndicator.style.display = 'none';

    if (studio.micStream) {
      studio.micStream.getTracks().forEach(t => t.stop());
      studio.micStream = null;
    }
    await sendControl('toggle_mic', { active: false });
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      studio.micStream = stream;
      studio.micActive = true;

      btnMicToggle.classList.add('active');
      micStatusLabel.textContent = '🔴 NO AR — FALANDO';
      duckingIndicator.style.display = 'flex';

      await sendControl('toggle_mic', { active: true });
    } catch (err) {
      alert('Não foi possível acessar o microfone.');
    }
  }
}

// ─── 11. Abas ─────────────────────────────────────────────────
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const pane = document.getElementById(target);
      if (pane) pane.classList.add('active');
    });
  });
}

// ─── 12. Modais (Programa e Nova Playlist) ────────────────────
let editingProgramTracks = [];

function updateProgramDurationSummary() {
  const startVal = $('prog-start').value || '08:00';
  const endVal = $('prog-end').value || '12:00';

  const [sH, sM] = startVal.split(':').map(Number);
  const [eH, eM] = endVal.split(':').map(Number);

  let startMin = sH * 60 + sM;
  let endMin = eH * 60 + eM;
  if (endMin <= startMin) endMin += 24 * 60; // atravessa meia-noite

  const slotMinutes = endMin - startMin;
  const slotH = Math.floor(slotMinutes / 60);
  const slotM = slotMinutes % 60;
  $('summary-slot-dur').textContent = `${String(slotH).padStart(2, '0')}h ${String(slotM).padStart(2, '0')}m`;

  const allTracks = studio.status?.allTracks || [];
  let totalSec = 0;
  for (const tId of editingProgramTracks) {
    const t = allTracks.find(l => l.id === tId || l.path === tId);
    totalSec += (t?.duration || 180);
  }

  const selH = Math.floor(totalSec / 3600);
  const selM = Math.floor((totalSec % 3600) / 60);
  const selS = totalSec % 60;

  const count = editingProgramTracks.length;
  const timeFormatted = selH > 0 
    ? `${selH}h ${String(selM).padStart(2, '0')}m` 
    : `${String(selM).padStart(2, '0')}:${String(selS).padStart(2, '0')}`;

  $('summary-tracks-dur').textContent = `${count} música${count !== 1 ? 's' : ''} (${timeFormatted})`;
}

let currentFilteredAvailTracks = [];

function renderPtsLists() {
  const allTracks = studio.status?.allTracks || [];
  const search = ($('pts-search-input')?.value || '').toLowerCase().trim();
  const selectedPlaylist = $('prog-playlist')?.value || 'geral';

  // Lista de disponíveis
  const availList = $('pts-avail-list');
  const selectedList = $('pts-selected-list');
  if (!availList || !selectedList) return;

  const filteredAvail = allTracks.filter(t => {
    // 1. Filtro da pasta selecionada no combobox Playlist/Estilo
    if (selectedPlaylist !== 'geral') {
      const pNorm = selectedPlaylist.toLowerCase().trim();
      const subNorm = (t.subcategory || '').toLowerCase().trim();
      const pathNorm = (t.path || '').toLowerCase().replace(/\\/g, '/');
      const matchSub = subNorm === pNorm || subNorm === pNorm.replace(/^musicas\//, '');
      const matchPath = pathNorm.includes(`/${pNorm}/`) || pathNorm.startsWith(`musicas/${pNorm}`) || pathNorm.includes(pNorm);
      if (!matchSub && !matchPath) return false;
    }

    // 2. Filtro de busca por texto
    if (search) {
      return (t.title && t.title.toLowerCase().includes(search)) ||
             (t.artist && t.artist.toLowerCase().includes(search)) ||
             (t.filename && t.filename.toLowerCase().includes(search));
    }
    return true;
  });

  currentFilteredAvailTracks = filteredAvail;

  $('pts-avail-count').textContent = filteredAvail.length;
  $('pts-selected-count').textContent = editingProgramTracks.length;

  availList.innerHTML = filteredAvail.slice(0, 150).map(t => {
    const dur = formatTime(t.duration || 180);
    return `
      <div class="pts-item">
        <div class="pts-item-meta">
          <span class="pts-item-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
          <span class="pts-item-sub">${escapeHtml(t.artist || '—')} • ${dur}</span>
        </div>
        <div class="pts-item-actions">
          <button type="button" class="btn-pts-action btn-pts-add" onclick="addTrackToProgram('${t.id}')" title="Adicionar ao programa">+ Adicionar</button>
        </div>
      </div>
    `;
  }).join('') || '<div class="queue-empty">Nenhuma música encontrada nesta pasta</div>';

  // Lista de selecionadas
  selectedList.innerHTML = editingProgramTracks.map((tId, idx) => {
    const t = allTracks.find(l => l.id === tId || l.path === tId) || { title: 'Música ' + (idx + 1), duration: 180 };
    const dur = formatTime(t.duration || 180);

    return `
      <div class="pts-item">
        <div class="pts-item-meta">
          <span class="pts-item-title">${idx + 1}. ${escapeHtml(t.title)}</span>
          <span class="pts-item-sub">${escapeHtml(t.artist || '—')} • ${dur}</span>
        </div>
        <div class="pts-item-actions">
          <button type="button" class="btn-pts-action" onclick="moveTrackInProgram(${idx}, -1)" title="Subir">▲</button>
          <button type="button" class="btn-pts-action" onclick="moveTrackInProgram(${idx}, 1)" title="Descer">▼</button>
          <button type="button" class="btn-pts-action btn-pts-remove" onclick="removeTrackFromProgram(${idx})" title="Remover">✕</button>
        </div>
      </div>
    `;
  }).join('') || '<div class="queue-empty">Nenhuma música selecionada (o programa usará a pasta da playlist)</div>';

  updateProgramDurationSummary();
}

window.addTrackToProgram = (trackId) => {
  editingProgramTracks.push(trackId);
  renderPtsLists();
};

window.removeTrackFromProgram = (idx) => {
  editingProgramTracks.splice(idx, 1);
  renderPtsLists();
};

window.moveTrackInProgram = (idx, delta) => {
  const target = idx + delta;
  if (target < 0 || target >= editingProgramTracks.length) return;
  const temp = editingProgramTracks[idx];
  editingProgramTracks[idx] = editingProgramTracks[target];
  editingProgramTracks[target] = temp;
  renderPtsLists();
};

function initModals() {
  // Mudança do combobox de Playlist recarrega as músicas disponíveis na hora
  $('prog-playlist')?.addEventListener('change', () => renderPtsLists());

  // Busca em tempo real no seletor de músicas
  $('pts-search-input')?.addEventListener('input', () => renderPtsLists());
  $('prog-start')?.addEventListener('change', () => updateProgramDurationSummary());
  $('prog-end')?.addEventListener('change', () => updateProgramDurationSummary());

  $('btn-clear-pts')?.addEventListener('click', () => {
    editingProgramTracks = [];
    renderPtsLists();
  });

  // Botão de adicionar todas as músicas da pasta filtrada
  $('btn-add-all-pts')?.addEventListener('click', () => {
    for (const t of currentFilteredAvailTracks) {
      editingProgramTracks.push(t.id);
    }
    renderPtsLists();
  });

  // Modal de Programa
  btnAddProgram.addEventListener('click', () => {
    $('prog-id').value = '';
    $('modal-program-title').textContent = 'Adicionar Programa à Grade';
    $('prog-name').value = '';
    $('prog-start').value = '08:00';
    $('prog-end').value = '12:00';
    
    populatePlaylistOptions('geral');

    $('prog-jingle-freq').value = '3';
    $('prog-color').value = '#06B6D4';
    btnDeleteProg.style.display = 'none';
    editingProgramTracks = [];

    document.querySelectorAll('input[name="prog_day"]').forEach((ch, idx) => {
      ch.checked = idx >= 0 && idx <= 4;
    });

    renderPtsLists();
    modalProgram.style.display = 'flex';
  });

  btnCloseModal.addEventListener('click', () => modalProgram.style.display = 'none');
  btnCancelModal.addEventListener('click', () => modalProgram.style.display = 'none');

  formProgram.addEventListener('submit', async (e) => {
    e.preventDefault();

    const id = $('prog-id').value || `prog-${Date.now()}`;
    const name = $('prog-name').value.trim();
    const startTime = $('prog-start').value;
    const endTime = $('prog-end').value;
    const playlist = $('prog-playlist').value;
    const jingleFrequency = parseInt($('prog-jingle-freq').value, 10);
    const color = $('prog-color').value;

    const playbackMode = document.querySelector('input[name="prog_playback_mode"]:checked')?.value || 'sequential';

    const days = [];
    document.querySelectorAll('input[name="prog_day"]:checked').forEach(ch => {
      days.push(parseInt(ch.value, 10));
    });

    const newProg = {
      id,
      name,
      startTime,
      endTime,
      playlist,
      jingleFrequency,
      color,
      days,
      tracks: editingProgramTracks,
      playbackMode: playbackMode,
    };

    let currentSchedule = studio.status?.schedule || [];
    const existIdx = currentSchedule.findIndex(s => s.id === id);
    if (existIdx >= 0) {
      currentSchedule[existIdx] = newProg;
    } else {
      currentSchedule.push(newProg);
    }

    try {
      const res = await fetch(`${SERVER_BASE}/api/studio/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentSchedule),
      });
      if (res.ok) {
        modalProgram.style.display = 'none';
        await fetchStudioStatus();
      }
    } catch (_) {}
  });

  // Forçar reprodução imediata do programa
  $('btn-force-play-prog')?.addEventListener('click', async () => {
    const id = $('prog-id').value || `prog-${Date.now()}`;
    const name = $('prog-name').value.trim() || 'Programa Ao Vivo';
    const startTime = $('prog-start').value;
    const endTime = $('prog-end').value;
    const playlist = $('prog-playlist').value;
    const jingleFrequency = parseInt($('prog-jingle-freq').value, 10);
    const color = $('prog-color').value;
    const playbackMode = document.querySelector('input[name="prog_playback_mode"]:checked')?.value || 'sequential';

    const days = [];
    document.querySelectorAll('input[name="prog_day"]:checked').forEach(ch => {
      days.push(parseInt(ch.value, 10));
    });

    const newProg = {
      id,
      name,
      startTime,
      endTime,
      playlist,
      jingleFrequency,
      color,
      days,
      tracks: editingProgramTracks,
      playbackMode: playbackMode,
    };

    let currentSchedule = studio.status?.schedule || [];
    const existIdx = currentSchedule.findIndex(s => s.id === id);
    if (existIdx >= 0) {
      currentSchedule[existIdx] = newProg;
    } else {
      currentSchedule.push(newProg);
    }

    try {
      await fetch(`${SERVER_BASE}/api/studio/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentSchedule),
      });

      await fetch(`${SERVER_BASE}/api/studio/play-program`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId: id }),
      });

      modalProgram.style.display = 'none';
      await fetchStudioStatus();
    } catch (err) {
      alert('Erro ao iniciar programa: ' + err.message);
    }
  });

  btnDeleteProg.addEventListener('click', async () => {
    const id = $('prog-id').value;
    if (!id) return;
    if (!confirm('Deseja excluir este programa da grade?')) return;

    let currentSchedule = (studio.status?.schedule || []).filter(s => s.id !== id);
    try {
      const res = await fetch(`${SERVER_BASE}/api/studio/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentSchedule),
      });
      if (res.ok) {
        modalProgram.style.display = 'none';
        await fetchStudioStatus();
      }
    } catch (_) {}
  });

  // Modal de Nova Playlist
  btnNewPlaylist.addEventListener('click', () => {
    $('playlist-name').value = '';
    $('playlist-folder').value = '';
    $('playlist-color').value = '#8B5CF6';
    modalPlaylist.style.display = 'flex';
  });

  btnClosePlaylistModal.addEventListener('click', () => modalPlaylist.style.display = 'none');
  btnCancelPlaylistModal.addEventListener('click', () => modalPlaylist.style.display = 'none');

  formNewPlaylist.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('playlist-name').value.trim();
    const folder = $('playlist-folder').value.trim();
    const color = $('playlist-color').value;

    try {
      const res = await fetch(`${SERVER_BASE}/api/studio/create-playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder, color }),
      });
      if (res.ok) {
        modalPlaylist.style.display = 'none';
        await fetchStudioStatus();
      }
    } catch (_) {}
  });
}

function populatePlaylistOptions(selectedId = 'geral') {
  const playlists = studio.status?.playlists?.playlists || [];
  const select = $('prog-playlist');
  if (!select) return;

  const defaultList = [
    { id: 'geral', name: 'Músicas Gerais (Todas as Pastas)' },
    ...playlists.map(p => ({ id: p.id || p.folder.replace(/^musicas\//, ''), name: p.name })),
  ];

  const unique = [];
  const seen = new Set();
  for (const item of defaultList) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      unique.push(item);
    }
  }

  select.innerHTML = unique.map(p => `
    <option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>
  `).join('');
}

window.openEditProgram = (progId) => {
  const schedule = studio.status?.schedule || [];
  const prog = schedule.find(s => s.id === progId);
  if (!prog) return;

  $('prog-id').value = prog.id;
  $('modal-program-title').textContent = 'Editar Programa da Grade';
  $('prog-name').value = prog.name;
  $('prog-start').value = prog.startTime || '08:00';
  $('prog-end').value = prog.endTime || '12:00';
  
  populatePlaylistOptions(prog.playlist || 'geral');

  $('prog-jingle-freq').value = prog.jingleFrequency !== undefined ? String(prog.jingleFrequency) : '3';
  $('prog-color').value = prog.color || '#06B6D4';
  btnDeleteProg.style.display = '';

  document.querySelectorAll('input[name="prog_day"]').forEach(ch => {
    ch.checked = prog.days && prog.days.includes(parseInt(ch.value, 10));
  });

  // Carrega as faixas escolhidas para este programa
  editingProgramTracks = Array.isArray(prog.tracks) ? [...prog.tracks] : [];

  // Modo de reprodução
  const modeRadios = document.querySelectorAll('input[name="prog_playback_mode"]');
  modeRadios.forEach(r => {
    r.checked = r.value === (prog.playbackMode || 'sequential');
  });

  renderPtsLists();
  modalProgram.style.display = 'flex';
};

// ─── 13. VU Meter ─────────────────────────────────────────────
function startMeterSimulation() {
  studio.levelTimer = setInterval(() => {
    if (!studio.status?.playing) {
      meterL.style.height = '0%';
      meterR.style.height = '0%';
      return;
    }
    const hL = 35 + Math.random() * 55;
    const hR = 35 + Math.random() * 55;
    meterL.style.height = `${hL}%`;
    meterR.style.height = `${hR}%`;
  }, 150);
}

// ─── Helpers ──────────────────────────────────────────────────
function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
