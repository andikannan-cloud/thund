/**
 * CipherPlayer — Custom Inbuilt HTML5 MP4 Player
 * Engineered for both Android (touch gestures, playsinline, pointer scrubbing)
 * and Windows PC (mouse hover, keyboard shortcuts, PiP, fullscreen).
 */

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ICONS = {
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`,
  back5: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" stroke="none" fill="currentColor">5</text></svg>`,
  fwd5: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" stroke="none" fill="currentColor">5</text></svg>`,
  volHigh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
  volMute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
  loop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
  pip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="11" y="11" width="9" height="7" rx="1" fill="currentColor"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  fullscreen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`,
  exitFs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`,
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export class CipherPlayer {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   *   - session: VaultSession
   *   - hasPlaylist: boolean
   *   - loopMode: 'all' | 'one' | 'off' (for playlist) OR 'one' | 'off' (for single)
   *   - compact: boolean (true in Side-by-Side Together grid)
   *   - autoplay: boolean
   *   - initialMuted: boolean
   *   - onPrevPart: () => void
   *   - onNextPart: (fromEnded: boolean) => void
   *   - onLoopModeChange: (mode: string) => void
   *   - onStateChange: () => void
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.session = opts.session;
    this.hasPlaylist = Boolean(opts.hasPlaylist);
    this.loopMode = opts.loopMode || (this.hasPlaylist ? 'all' : 'one');
    this.compact = Boolean(opts.compact);
    this.autoplay = opts.autoplay !== false;
    this.onPrevPart = opts.onPrevPart || null;
    this.onNextPart = opts.onNextPart || null;
    this.onLoopModeChange = opts.onLoopModeChange || null;
    this.onStateChange = opts.onStateChange || null;

    this.currentPart = null;
    this.currentUrl = null;
    this.speedIndex = 2; // 1x
    this.isScrubbing = false;
    this.hideTimer = null;
    this.destroyed = false;
    this.lastTapTime = 0;
    this.singleTapTimeout = null;

    this.renderShell(Boolean(opts.initialMuted));
    this.bindEvents();
  }

  renderShell(initialMuted) {
    this.container.innerHTML = '';
    this.root = document.createElement('div');
    this.root.className = `cp-player state-paused controls-visible${
      this.compact ? ' cp-compact' : ''
    }`;

    this.root.innerHTML = `
      <video class="cp-video" playsinline webkit-playsinline preload="auto"></video>

      <div class="cp-top-bar">
        <div class="cp-stream-pill">
          <span class="cp-mp4-dot"></span>
          <span class="cp-filename">—</span>
        </div>
        <div class="cp-source-tag"></div>
      </div>

      <div class="cp-loader" hidden>
        <div class="cp-spinner"></div>
        <div class="cp-loader-label">Decrypting stream...</div>
        <div class="cp-loader-bar"><span class="cp-loader-fill"></span></div>
      </div>

      <div class="cp-seek-ripple cp-ripple-left" hidden>-5s</div>
      <div class="cp-seek-ripple cp-ripple-right" hidden>+5s</div>

      <button type="button" class="cp-center-play" aria-label="Play or pause video">
        ${ICONS.play}
      </button>

      <div class="cp-controls">
        <div class="cp-timeline" role="slider" aria-label="Seek timeline" tabindex="0">
          <div class="cp-timeline-track">
            <div class="cp-timeline-buffer"></div>
            <div class="cp-timeline-progress"></div>
            <div class="cp-timeline-thumb"></div>
          </div>
          <div class="cp-timeline-tooltip">0:00</div>
        </div>

        <div class="cp-bar">
          <div class="cp-bar-left">
            ${
              this.hasPlaylist
                ? `<button type="button" class="cp-btn cp-prev-btn" title="Previous Part">${ICONS.prev}</button>`
                : ''
            }
            <button type="button" class="cp-btn cp-play-btn" title="Play / Pause">${ICONS.play}</button>
            ${
              this.hasPlaylist
                ? `<button type="button" class="cp-btn cp-next-btn" title="Next Part">${ICONS.next}</button>`
                : ''
            }
            <button type="button" class="cp-btn cp-back5-btn" title="Rewind 5s">${ICONS.back5}</button>
            <button type="button" class="cp-btn cp-fwd5-btn" title="Forward 5s">${ICONS.fwd5}</button>

            <div class="cp-vol-group">
              <button type="button" class="cp-btn cp-mute-btn" title="Mute / Unmute">${ICONS.volHigh}</button>
              <input type="range" class="cp-vol-slider" min="0" max="1" step="0.02" value="1" aria-label="Volume" />
            </div>

            <span class="cp-time"><span class="cp-cur">0:00</span> <span class="cp-sep">/</span> <span class="cp-dur">0:00</span></span>
          </div>

          <div class="cp-bar-right">
            <button type="button" class="cp-btn cp-pill-btn cp-loop-btn" title="Toggle Loop Mode">
              <span class="cp-loop-icon">${ICONS.loop}</span>
              <span class="cp-loop-text">Loop</span>
            </button>
            <button type="button" class="cp-btn cp-pill-btn cp-speed-btn" title="Playback Speed">1x</button>
            <button type="button" class="cp-btn cp-pip-btn" title="Picture-in-Picture">${ICONS.pip}</button>
            <button type="button" class="cp-btn cp-dl-btn" title="Save restored .mp4">${ICONS.download}</button>
            <button type="button" class="cp-btn cp-fs-btn" title="Fullscreen">${ICONS.fullscreen}</button>
          </div>
        </div>
      </div>
    `;

    this.container.appendChild(this.root);

    this.video = this.root.querySelector('.cp-video');
    this.filenameEl = this.root.querySelector('.cp-filename');
    this.sourceTagEl = this.root.querySelector('.cp-source-tag');
    this.loaderEl = this.root.querySelector('.cp-loader');
    this.loaderLabelEl = this.root.querySelector('.cp-loader-label');
    this.loaderFillEl = this.root.querySelector('.cp-loader-fill');
    this.centerPlayBtn = this.root.querySelector('.cp-center-play');
    this.rippleLeft = this.root.querySelector('.cp-ripple-left');
    this.rippleRight = this.root.querySelector('.cp-ripple-right');

    this.timelineEl = this.root.querySelector('.cp-timeline');
    this.bufferEl = this.root.querySelector('.cp-timeline-buffer');
    this.progressEl = this.root.querySelector('.cp-timeline-progress');
    this.thumbEl = this.root.querySelector('.cp-timeline-thumb');
    this.tooltipEl = this.root.querySelector('.cp-timeline-tooltip');

    this.playBtn = this.root.querySelector('.cp-play-btn');
    this.prevBtn = this.root.querySelector('.cp-prev-btn');
    this.nextBtn = this.root.querySelector('.cp-next-btn');
    this.back5Btn = this.root.querySelector('.cp-back5-btn');
    this.fwd5Btn = this.root.querySelector('.cp-fwd5-btn');
    this.muteBtn = this.root.querySelector('.cp-mute-btn');
    this.volSlider = this.root.querySelector('.cp-vol-slider');
    this.curTimeEl = this.root.querySelector('.cp-cur');
    this.durTimeEl = this.root.querySelector('.cp-dur');

    this.loopBtn = this.root.querySelector('.cp-loop-btn');
    this.loopTextEl = this.root.querySelector('.cp-loop-text');
    this.speedBtn = this.root.querySelector('.cp-speed-btn');
    this.pipBtn = this.root.querySelector('.cp-pip-btn');
    this.dlBtn = this.root.querySelector('.cp-dl-btn');
    this.fsBtn = this.root.querySelector('.cp-fs-btn');

    if (!document.pictureInPictureEnabled) {
      this.pipBtn.hidden = true;
    }

    const savedVol = parseFloat(localStorage.getItem('cv_volume') ?? '0.9');
    this.video.volume = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 0.9;
    this.video.muted = initialMuted;
    this.volSlider.value = this.video.muted ? '0' : String(this.video.volume);
    this.syncVolumeUI();
    this.syncLoopUI();
  }

  bindEvents() {
    // Video surface pointer handling: smart touch vs mouse distinction!
    this.video.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        const now = Date.now();
        const rect = this.video.getBoundingClientRect();
        const relX = (e.clientX - rect.left) / Math.max(1, rect.width);

        if (now - this.lastTapTime < 280) {
          clearTimeout(this.singleTapTimeout);
          this.lastTapTime = 0;
          if (relX < 0.36) {
            this.skip(-5);
            this.flashRipple(this.rippleLeft);
          } else if (relX > 0.64) {
            this.skip(5);
            this.flashRipple(this.rippleRight);
          } else {
            this.togglePlay();
          }
          return;
        }

        this.lastTapTime = now;
        this.singleTapTimeout = setTimeout(() => {
          if (this.root.classList.contains('controls-visible') && !this.video.paused) {
            this.hideControls();
          } else {
            this.showControls();
          }
        }, 250);
      } else {
        // Mouse click toggles play/pause
        this.togglePlay();
      }
    });

    this.video.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.toggleFullscreen();
    });

    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') {
        this.showControls();
      }
    });

    this.root.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this.video.paused && !this.isScrubbing) {
        this.hideControls();
      }
    });

    this.centerPlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlay();
    });

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.prevBtn?.addEventListener('click', () => this.onPrevPart?.());
    this.nextBtn?.addEventListener('click', () => this.onNextPart?.(false));
    this.back5Btn.addEventListener('click', () => {
      this.skip(-5);
      this.flashRipple(this.rippleLeft);
    });
    this.fwd5Btn.addEventListener('click', () => {
      this.skip(5);
      this.flashRipple(this.rippleRight);
    });

    this.muteBtn.addEventListener('click', () => {
      this.setMuted(!this.video.muted);
    });

    this.volSlider.addEventListener('input', () => {
      const val = parseFloat(this.volSlider.value);
      this.video.volume = val;
      this.video.muted = val === 0;
      if (val > 0) localStorage.setItem('cv_volume', String(val));
      this.syncVolumeUI();
    });

    this.loopBtn.addEventListener('click', () => this.cycleLoopMode());

    this.speedBtn.addEventListener('click', () => {
      this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
      const spd = SPEEDS[this.speedIndex];
      this.video.playbackRate = spd;
      this.speedBtn.textContent = `${spd}x`;
      this.showControls();
    });

    this.pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (this.video.readyState >= 1) {
          await this.video.requestPictureInPicture();
        }
      } catch {
        // ignore if unsupported
      }
    });

    this.dlBtn.addEventListener('click', () => {
      if (!this.currentUrl || !this.currentPart) return;
      const a = document.createElement('a');
      a.href = this.currentUrl;
      a.download = this.currentPart.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    this.fsBtn.addEventListener('click', () => this.toggleFullscreen());

    this.onFsChange = () => {
      const isFs =
        document.fullscreenElement === this.root ||
        document.webkitFullscreenElement === this.root;
      this.root.classList.toggle('is-fullscreen', isFs);
      this.fsBtn.innerHTML = isFs ? ICONS.exitFs : ICONS.fullscreen;
    };
    document.addEventListener('fullscreenchange', this.onFsChange);
    document.addEventListener('webkitfullscreenchange', this.onFsChange);

    // Scrubber pointer events (Android touch + Windows mouse)
    const calcRatio = (clientX) => {
      const rect = this.timelineEl.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    };

    const updateTooltip = (clientX) => {
      const ratio = calcRatio(clientX);
      const dur = this.video.duration || this.currentPart?.duration || 0;
      this.tooltipEl.textContent = formatTime(ratio * dur);
      this.tooltipEl.style.left = `${ratio * 100}%`;
    };

    this.timelineEl.addEventListener('pointermove', (e) => {
      updateTooltip(e.clientX);
      if (this.isScrubbing) {
        const ratio = calcRatio(e.clientX);
        const dur = this.video.duration || 0;
        if (dur > 0) {
          this.video.currentTime = ratio * dur;
          this.updateTimelineUI(ratio * dur, dur);
        }
      }
    });

    this.timelineEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.isScrubbing = true;
      this.root.classList.add('is-scrubbing');
      try {
        this.timelineEl.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      updateTooltip(e.clientX);
      const ratio = calcRatio(e.clientX);
      const dur = this.video.duration || 0;
      if (dur > 0) {
        this.video.currentTime = ratio * dur;
        this.updateTimelineUI(ratio * dur, dur);
      }
    });

    const endScrub = (e) => {
      if (!this.isScrubbing) return;
      this.isScrubbing = false;
      this.root.classList.remove('is-scrubbing');
      try {
        this.timelineEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      this.showControls();
    };
    this.timelineEl.addEventListener('pointerup', endScrub);
    this.timelineEl.addEventListener('pointercancel', endScrub);

    // Media events
    this.video.addEventListener('play', () => {
      this.root.classList.remove('state-paused');
      this.root.classList.add('state-playing');
      this.playBtn.innerHTML = ICONS.pause;
      this.centerPlayBtn.innerHTML = ICONS.pause;
      this.showControls();
      this.onStateChange?.();
    });

    this.video.addEventListener('pause', () => {
      this.root.classList.remove('state-playing');
      this.root.classList.add('state-paused');
      this.playBtn.innerHTML = ICONS.play;
      this.centerPlayBtn.innerHTML = ICONS.play;
      this.showControls(true);
      this.onStateChange?.();
    });

    this.video.addEventListener('loadedmetadata', () => {
      const dur = this.video.duration || this.currentPart?.duration || 0;
      this.durTimeEl.textContent = formatTime(dur);
      this.video.playbackRate = SPEEDS[this.speedIndex];
      this.applyNativeLoopFlag();
    });

    this.video.addEventListener('timeupdate', () => {
      if (this.isScrubbing) return;
      const cur = this.video.currentTime || 0;
      const dur = this.video.duration || this.currentPart?.duration || 0;
      this.updateTimelineUI(cur, dur);
    });

    this.video.addEventListener('progress', () => {
      const dur = this.video.duration || 0;
      if (dur > 0 && this.video.buffered.length > 0) {
        const end = this.video.buffered.end(this.video.buffered.length - 1);
        this.bufferEl.style.width = `${Math.min(100, (end / dur) * 100)}%`;
      }
    });

    this.video.addEventListener('waiting', () => {
      this.loaderEl.hidden = false;
      this.loaderLabelEl.textContent = 'Buffering...';
    });

    this.video.addEventListener('playing', () => {
      this.loaderEl.hidden = true;
    });

    this.video.addEventListener('canplay', () => {
      this.loaderEl.hidden = true;
    });

    this.video.addEventListener('ended', () => {
      if (this.hasPlaylist && this.loopMode !== 'one') {
        this.onNextPart?.(true);
      } else if (!this.hasPlaylist && this.loopMode === 'one') {
        this.video.currentTime = 0;
        this.video.play().catch(() => {});
      }
      this.onStateChange?.();
    });
  }

  updateTimelineUI(cur, dur) {
    this.curTimeEl.textContent = formatTime(cur);
    if (dur > 0) {
      this.durTimeEl.textContent = formatTime(dur);
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      this.progressEl.style.width = `${pct}%`;
      this.thumbEl.style.left = `${pct}%`;
    }
  }

  flashRipple(el) {
    el.hidden = false;
    el.classList.remove('animate');
    void el.offsetWidth;
    el.classList.add('animate');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.hidden = true;
    }, 520);
  }

  showControls(keepVisible = false) {
    this.root.classList.add('controls-visible');
    clearTimeout(this.hideTimer);
    if (!keepVisible && !this.video.paused && !this.isScrubbing) {
      this.hideTimer = setTimeout(() => {
        if (!this.video.paused && !this.isScrubbing) {
          this.root.classList.remove('controls-visible');
        }
      }, 2800);
    }
  }

  hideControls() {
    clearTimeout(this.hideTimer);
    this.root.classList.remove('controls-visible');
  }

  syncVolumeUI() {
    const muted = this.video.muted || this.video.volume === 0;
    this.muteBtn.innerHTML = muted ? ICONS.volMute : ICONS.volHigh;
    this.volSlider.value = muted ? '0' : String(this.video.volume);
  }

  applyNativeLoopFlag() {
    // Use native seamless loop when looping single video/part
    this.video.loop = this.loopMode === 'one';
  }

  syncLoopUI() {
    this.applyNativeLoopFlag();
    const isActive = this.loopMode !== 'off';
    this.loopBtn.classList.toggle('is-active', isActive);
    if (this.hasPlaylist) {
      if (this.loopMode === 'all') {
        this.loopTextEl.textContent = 'Loop All';
      } else if (this.loopMode === 'one') {
        this.loopTextEl.textContent = 'Loop Part';
      } else {
        this.loopTextEl.textContent = 'Loop Off';
      }
    } else {
      this.loopTextEl.textContent = isActive ? 'Loop ON' : 'Loop OFF';
    }
  }

  cycleLoopMode() {
    if (this.hasPlaylist) {
      const order = ['all', 'one', 'off'];
      const next = order[(order.indexOf(this.loopMode) + 1) % order.length];
      this.setLoopMode(next);
    } else {
      this.setLoopMode(this.loopMode === 'one' ? 'off' : 'one');
    }
    this.onLoopModeChange?.(this.loopMode);
    this.showControls();
  }

  setLoopMode(mode) {
    this.loopMode = mode;
    this.syncLoopUI();
  }

  setMuted(muted) {
    this.video.muted = muted;
    if (!muted && this.video.volume === 0) {
      this.video.volume = 0.8;
    }
    this.syncVolumeUI();
    this.onStateChange?.();
  }

  async loadPart(part, autoPlayNow = this.autoplay) {
    this.currentPart = part;
    const reqToken = Symbol('loadPart');
    this._activeLoadToken = reqToken;

    this.filenameEl.textContent = part.name;
    this.sourceTagEl.textContent = `${part.blobFile} → MP4`;
    if (part.poster) {
      this.video.poster = part.poster;
    } else {
      this.video.removeAttribute('poster');
    }

    this.progressEl.style.width = '0%';
    this.thumbEl.style.left = '0%';
    this.bufferEl.style.width = '0%';
    this.curTimeEl.textContent = '0:00';
    this.durTimeEl.textContent = formatTime(part.duration || 0);

    this.loaderEl.hidden = false;
    this.loaderFillEl.style.width = '5%';
    this.loaderLabelEl.textContent = `Decrypting ${part.blobFile}...`;

    try {
      const { url } = await this.session.getPlayableMp4(part, (pct, msg) => {
        if (this.destroyed || this._activeLoadToken !== reqToken) return;
        this.loaderFillEl.style.width = `${pct}%`;
        this.loaderLabelEl.textContent = `${msg} (${pct}%)`;
      });

      if (this.destroyed || this._activeLoadToken !== reqToken) return;

      this.currentUrl = url;
      this.video.src = url;
      this.applyNativeLoopFlag();
      this.video.playbackRate = SPEEDS[this.speedIndex];
      this.loaderEl.hidden = true;

      if (autoPlayNow) {
        try {
          await this.video.play();
        } catch {
          // If autoplay with audio is blocked by mobile policy on initial gesture mismatch, stay ready
          this.showControls(true);
        }
      }
    } catch (err) {
      if (this.destroyed || this._activeLoadToken !== reqToken) return;
      this.loaderLabelEl.textContent = `Decryption error: ${err.message}`;
      this.loaderFillEl.style.width = '100%';
    }
  }

  togglePlay() {
    if (this.video.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  play() {
    return this.video.play().catch(() => {});
  }

  pause() {
    this.video.pause();
  }

  skip(deltaSec) {
    const dur = this.video.duration || 0;
    if (dur <= 0) return;
    this.video.currentTime = Math.min(dur, Math.max(0, this.video.currentTime + deltaSec));
    this.showControls();
  }

  seekTo(sec) {
    this.video.currentTime = Math.max(0, sec);
  }

  async toggleFullscreen() {
    try {
      const isFs =
        document.fullscreenElement === this.root ||
        document.webkitFullscreenElement === this.root;
      if (isFs) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (this.root.requestFullscreen) {
        await this.root.requestFullscreen();
        if (
          screen.orientation?.lock &&
          this.video.videoWidth > this.video.videoHeight
        ) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      } else if (this.root.webkitRequestFullscreen) {
        this.root.webkitRequestFullscreen();
      } else if (this.video.webkitEnterFullscreen) {
        this.video.webkitEnterFullscreen();
      }
    } catch {
      if (this.video.webkitEnterFullscreen) {
        try {
          this.video.webkitEnterFullscreen();
        } catch {
          // ignore
        }
      }
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.hideTimer);
    clearTimeout(this.singleTapTimeout);
    document.removeEventListener('fullscreenchange', this.onFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onFsChange);
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      // ignore
    }
    this.container.innerHTML = '';
  }
}
