/**
 * Connec Radio — AutoDJ & Scheduler Engine
 * Gerencia a grade de programação por calendário (24/7), playlists reais,
 * fila de reprodução inteligente de arquivos locais do HD e metadados.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MEDIA_DIR     = path.join(__dirname, '..', 'media');
const SCHEDULE_FILE = path.join(MEDIA_DIR, 'schedule.json');
const PLAYLIST_FILE = path.join(MEDIA_DIR, 'playlists.json');

const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'];

class AutoDJScheduler {
  constructor(serverContext) {
    this.server = serverContext; // { updateTrack, broadcastStatus, currentTrack }

    this.state = {
      playing:       false,
      autodj:        true,
      currentTrack:  null,
      queue:         [],
      history:       [],
      jingleCounter: 0,
      volume:        1.0,
      micActive:     false,
    };

    this.scheduleConfig  = [];
    this.playlistsConfig = { playlists: [] };
    this.library         = [];

    this.timer = null;

    this.init();
  }

  init() {
    this.loadConfigs();
    this.scanLibrary();
    this.refillQueue();

    // Loop do Scheduler a cada 1 segundo
    this.timer = setInterval(() => this.tick(), 1000);

    console.log('[AutoDJ] Motor de agendamento e calendário inicializado (Modo 100% Arquivos Reais)');
  }

  // ─── Carregar Configurações ─────────────────────────────────
  loadConfigs() {
    try {
      if (fs.existsSync(SCHEDULE_FILE)) {
        this.scheduleConfig = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      }
    } catch (err) {
      console.error('[AutoDJ] Erro ao ler schedule.json:', err.message);
    }

    try {
      if (fs.existsSync(PLAYLIST_FILE)) {
        this.playlistsConfig = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
      }
    } catch (err) {
      console.error('[AutoDJ] Erro ao ler playlists.json:', err.message);
    }
  }

  saveSchedule(newSchedule) {
    this.scheduleConfig = newSchedule;
    try {
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(newSchedule, null, 2), 'utf8');
      console.log('[AutoDJ] Grade de programação atualizada no disco');

      // Limpa a fila e recarrega imediatamente com o novo roteiro do programa ativo!
      this.state.queue = [];
      this.state.programTrackIndex = 0;
      this.refillQueue();

      if (this.state.playing && this.queue.length > 0 && !this.state.currentTrack) {
        this.nextTrack();
      }
      this.broadcastStudioUpdate();
      return true;
    } catch (err) {
      console.error('[AutoDJ] Erro ao salvar schedule.json:', err.message);
      return false;
    }
  }

  playProgramNow(programId) {
    const prog = this.scheduleConfig.find(s => s.id === programId);
    if (!prog) return false;

    this.state.forcedProgram = prog;
    this.state.queue = [];
    this.state.programTrackIndex = 0;
    this.state.playing = true;

    this.refillQueue();
    this.nextTrack();
    this.broadcastStudioUpdate();
    return true;
  }

  savePlaylistsConfig(newConfig) {
    this.playlistsConfig = newConfig;
    try {
      fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[AutoDJ] Erro ao salvar playlists.json:', err.message);
      return false;
    }
  }

  // ─── Escanear Biblioteca de Arquivos Reais no HD ─────────────
  scanLibrary() {
    const files = [];

    const scanDir = (dir, category = 'musicas', subcategory = '') => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath, category, entry.name);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTS.includes(ext)) {
            try {
              const stat = fs.statSync(fullPath);
              const parsed = this.parseSongName(entry.name, stat.size);
              const relPath = path.relative(MEDIA_DIR, fullPath).replace(/\\/g, '/');

              const fileId = crypto.createHash('md5').update(relPath).digest('hex').substring(0, 16);

              files.push({
                id:          fileId,
                filename:    entry.name,
                title:       parsed.title,
                artist:      parsed.artist,
                duration:    parsed.duration,
                sizeBytes:   stat.size,
                sizeFormatted: (stat.size / (1024 * 1024)).toFixed(1) + ' MB',
                path:        relPath,
                fullPath:    fullPath,
                category:    category,
                subcategory: subcategory,
                mtime:       stat.mtimeMs,
              });
            } catch (_) {}
          }
        }
      }
    };

    scanDir(path.join(MEDIA_DIR, 'musicas'), 'musicas');
    scanDir(path.join(MEDIA_DIR, 'vinhetas'), 'vinhetas');
    scanDir(path.join(MEDIA_DIR, 'comerciais'), 'comerciais');

    this.library = files;
    console.log(`[AutoDJ] Biblioteca escaneada no HD: ${files.length} arquivo(s) real(is) de áudio`);
  }

  parseSongName(filename, sizeBytes = 0) {
    let clean = filename.replace(/\.(mp3|wav|ogg|aac|m4a|flac|wma)$/i, '').trim();
    // Remove prefixos como "01 - ", "04. ", etc.
    clean = clean.replace(/^[0-9]{1,3}[.\s-_]+/, '').trim();

    let duration = 0;

    // Se o nome do arquivo tem a duração (ex: "Musica (3:45)")
    const durMatch = clean.match(/[(\[](\d{1,2}):(\d{2})[)\]]$/);
    if (durMatch) {
      duration = parseInt(durMatch[1], 10) * 60 + parseInt(durMatch[2], 10);
      clean = clean.replace(/[(\[]\d{1,2}:\d{2}[)\]]$/, '').trim();
    } else if (sizeBytes > 0) {
      duration = Math.max(30, Math.round(sizeBytes / 20000));
    }

    let artist = '';
    let title = clean || filename;

    if (clean.includes(' - ')) {
      const parts = clean.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else if (clean.includes(' – ')) {
      const parts = clean.split(' – ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' – ').trim();
    }

    return {
      artist: artist || '',
      title: title || clean || filename,
      duration: duration || 180,
    };
  }

  // ─── Calendário & Grade de Horários ──────────────────────────
  getCurrentProgram() {
    if (this.state.forcedProgram) {
      return this.state.forcedProgram;
    }

    const now = new Date();
    const day = now.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
    const curTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const prog of this.scheduleConfig) {
      if (prog.days && prog.days.includes(day)) {
        if (curTime >= prog.startTime && curTime < prog.endTime) {
          return prog;
        }
      }
    }

    return {
      id: 'default',
      name: 'Connec Radio — Ao Vivo',
      playlist: 'geral',
      color: '#06B6D4',
      jingleFrequency: 3,
      description: 'Programação Musical 24 Horas',
    };
  }

  // ─── Gerenciamento da Fila (Queue) com Roteiro Personalizado ─
  refillQueue() {
    const minQueueSize = 6;
    if (this.queue.length >= minQueueSize) return;

    const currentProgram = this.getCurrentProgram();
    const targetPlaylist = currentProgram.playlist || 'geral';

    // 1. Se o programa tem faixas específicas escolhidas pelo usuário:
    let pool = [];
    if (currentProgram.tracks && Array.isArray(currentProgram.tracks) && currentProgram.tracks.length > 0) {
      pool = currentProgram.tracks
        .map(tId => this.library.find(l => l.id === tId || l.path === tId))
        .filter(Boolean);
    }

    // 2. Se não houver faixas específicas, usa a pasta da playlist selecionada
    if (pool.length === 0) {
      pool = this.library.filter(t => t.category === 'musicas');
      if (targetPlaylist !== 'geral') {
        const filtered = pool.filter(t => t.subcategory === targetPlaylist || t.path.startsWith(`musicas/${targetPlaylist}`));
        if (filtered.length > 0) pool = filtered;
      }
    }

    // Jingles reais disponíveis
    const jinglesPool = this.library.filter(t => t.category === 'vinhetas');

    if (pool.length === 0 && jinglesPool.length === 0) {
      return;
    }

    const isSequential = currentProgram.playbackMode === 'sequential';

    while (this.queue.length < minQueueSize && (pool.length > 0 || jinglesPool.length > 0)) {
      this.state.jingleCounter++;

      const jingleFreq = currentProgram.jingleFrequency || 3;
      if (this.state.jingleCounter >= jingleFreq && jinglesPool.length > 0) {
        const jingle = jinglesPool[Math.floor(Math.random() * jinglesPool.length)];
        this.queue.push({
          ...jingle,
          type: 'jingle',
          programName: currentProgram.name,
        });
        this.state.jingleCounter = 0;
        continue;
      }

      if (pool.length === 0) break;

      let chosen = null;
      if (isSequential) {
        if (this.state.programTrackIndex === undefined || this.state.programTrackIndex >= pool.length) {
          this.state.programTrackIndex = 0;
        }
        chosen = pool[this.state.programTrackIndex];
        this.state.programTrackIndex = (this.state.programTrackIndex + 1) % pool.length;
      } else {
        const available = pool.filter(t => !this.queue.some(q => q.id === t.id));
        chosen = (available.length > 0 ? available : pool)[Math.floor(Math.random() * pool.length)];
      }

      if (chosen) {
        this.queue.push({
          ...chosen,
          type: 'music',
          programName: currentProgram.name,
        });
      }
    }
  }

  get queue() {
    return this.state.queue;
  }

  // ─── Controles de Reprodução ─────────────────────────────────
  startAutoDJ() {
    this.state.autodj = true;
    this.state.playing = true;
    if (!this.state.currentTrack && this.queue.length > 0) {
      this.nextTrack();
    }
    this.broadcastStudioUpdate();
  }

  pause() {
    this.state.playing = false;
    this.broadcastStudioUpdate();
  }

  resume() {
    this.state.playing = true;
    if (!this.state.currentTrack && this.queue.length > 0) {
      this.nextTrack();
    }
    this.broadcastStudioUpdate();
  }

  nextTrack() {
    this.refillQueue();
    if (this.queue.length === 0) {
      this.state.currentTrack = null;
      this.state.playing = false;
      this.broadcastStudioUpdate();
      return;
    }

    if (this.state.currentTrack) {
      this.state.history.unshift({ ...this.state.currentTrack, playedAt: Date.now() });
      if (this.state.history.length > 30) this.state.history.pop();
    }

    const next = this.queue.shift();
    const duration = next.duration || 180;
    const startedAt = Date.now();

    this.state.currentTrack = {
      id:          next.id,
      title:       next.title,
      artist:      next.artist,
      duration:    duration,
      startedAt:   startedAt,
      type:        next.type || 'music',
      programName: next.programName || this.getCurrentProgram().name,
      path:        next.path || '',
      sizeFormatted: next.sizeFormatted || '',
    };

    this.state.playing = true;

    // Repassa metadados reais para os ouvintes
    if (this.server && this.server.updateTrack) {
      this.server.updateTrack({
        title:     this.state.currentTrack.title,
        artist:    this.state.currentTrack.artist,
        duration:  this.state.currentTrack.duration,
        startedAt: this.state.currentTrack.startedAt,
        raw:       this.state.currentTrack.artist
          ? `${this.state.currentTrack.artist} - ${this.state.currentTrack.title}`
          : this.state.currentTrack.title,
      });
    }

    this.refillQueue();
    this.broadcastStudioUpdate();
  }

  playSpecific(trackId) {
    const found = this.library.find(t => t.id === trackId);
    if (!found) return false;

    this.queue.unshift({ ...found, type: found.category === 'vinhetas' ? 'jingle' : 'music' });
    this.nextTrack();
    return true;
  }

  addToQueue(trackId) {
    const found = this.library.find(t => t.id === trackId);
    if (!found) return false;

    this.queue.push({ ...found, type: found.category === 'vinhetas' ? 'jingle' : 'music' });
    this.broadcastStudioUpdate();
    return true;
  }

  triggerJingleInstant(jingleId) {
    let jingle = this.library.find(t => t.id === jingleId && t.category === 'vinhetas');
    if (!jingle) {
      const allJingles = this.library.filter(t => t.category === 'vinhetas');
      if (allJingles.length > 0) {
        jingle = allJingles[0];
      }
    }

    if (!jingle) return false;

    this.queue.unshift({ ...jingle, type: 'jingle' });
    this.nextTrack();
    return true;
  }

  deleteTrack(trackId) {
    const found = this.library.find(t => t.id === trackId);
    if (!found) return false;

    try {
      if (fs.existsSync(found.fullPath)) {
        fs.unlinkSync(found.fullPath);
      }
      this.scanLibrary();
      this.state.queue = this.state.queue.filter(q => q.id !== trackId);
      this.broadcastStudioUpdate();
      return true;
    } catch (err) {
      console.error('[AutoDJ] Erro ao excluir arquivo:', err.message);
      return false;
    }
  }

  // ─── Loop de Avanço de Faixa (Tick) ──────────────────────────
  tick() {
    if (!this.state.playing || !this.state.autodj) return;

    if (!this.state.currentTrack) {
      if (this.queue.length > 0) {
        this.nextTrack();
      }
      return;
    }

    const elapsed = Math.floor((Date.now() - this.state.currentTrack.startedAt) / 1000);
    const duration = this.state.currentTrack.duration || 180;

    if (elapsed >= duration) {
      this.nextTrack();
    }
  }

  // ─── Estado do Studio para a API Web ─────────────────────────
  getStudioStatus() {
    const curProg = this.getCurrentProgram();
    const elapsed = this.state.currentTrack && this.state.currentTrack.startedAt
      ? Math.max(0, Math.floor((Date.now() - this.state.currentTrack.startedAt) / 1000))
      : 0;

    return {
      playing:        this.state.playing,
      autodj:         this.state.autodj,
      currentProgram: curProg,
      currentTrack:   this.state.currentTrack ? { ...this.state.currentTrack, elapsed } : null,
      queue:          this.queue.slice(0, 15),
      history:        this.state.history.slice(0, 15),
      libraryStats: {
        totalTracks:      this.library.filter(t => t.category === 'musicas').length,
        totalJingles:     this.library.filter(t => t.category === 'vinhetas').length,
        totalCommercials: this.library.filter(t => t.category === 'comerciais').length,
      },
      schedule:       this.scheduleConfig,
      playlists:      this.playlistsConfig,
      allTracks:      this.library,
      micActive:      this.state.micActive,
    };
  }

  broadcastStudioUpdate() {
    if (this.server && this.server.broadcastStatus) {
      this.server.broadcastStatus();
    }
  }
}

module.exports = AutoDJScheduler;
