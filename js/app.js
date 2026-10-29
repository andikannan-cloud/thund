import {
  fetchVaultManifest,
  VaultSession,
  InvalidPasskeyError,
} from './crypto-engine.js?v=3';
import { CipherPlayer, formatTime, formatBytes } from './player.js?v=3';

const SESSION_KEY = 'cv_session_passkey_v1';

class CipherVaultApp {
  constructor() {
    this.vaultManifest = null;
    this.session = new VaultSession();

    this.activeFilter = 'all'; // 'all' | 'groups' | 'singles'
    this.searchQuery = '';

    // Watch state
    this.activeItem = null;
    this.activePartIdx = 0;
    this.watchMode = 'playlist'; // 'playlist' | 'together'
    this.playlistLoopMode = 'all'; // 'all' | 'one' | 'off'
    this.singleLoopMode = 'one'; // 'one' | 'off'
    this.togetherLoopAll = true;

    this.mainPlayer = null;
    this.togetherPlayers = [];

    this.cacheDom();
    this.bindGlobalEvents();
    this.boot();
  }

  cacheDom() {
    // Lock Screen
    this.lockScreen = document.getElementById('lockScreen');
    this.lockCard = document.getElementById('lockCard');
    this.lockForm = document.getElementById('lockForm');
    this.passkeyInput = document.getElementById('passkeyInput');
    this.toggleVisBtn = document.getElementById('togglePasskeyVis');
    this.rememberSessionChk = document.getElementById('rememberSessionChk');
    this.unlockBtn = document.getElementById('unlockBtn');
    this.unlockBtnText = document.getElementById('unlockBtnText');
    this.lockError = document.getElementById('lockError');
    this.keypadToggleBtn = document.getElementById('keypadToggleBtn');
    this.quickKeypad = document.getElementById('quickKeypad');

    // App Shell
    this.appShell = document.getElementById('appShell');
    this.statsPill = document.getElementById('vaultStatsPill');
    this.searchInput = document.getElementById('searchInput');
    this.clearSearchBtn = document.getElementById('clearSearchBtn');
    this.filterBtns = document.querySelectorAll('[data-filter]');
    this.lockVaultBtn = document.getElementById('lockVaultBtn');
    this.syncDriveBtn = document.getElementById('syncDriveBtn');

    // Views
    this.gallerySection = document.getElementById('gallerySection');
    this.galleryGrid = document.getElementById('galleryGrid');
    this.emptyState = document.getElementById('emptyState');
    this.countAll = document.getElementById('countAll');
    this.countGroups = document.getElementById('countGroups');
    this.countSingles = document.getElementById('countSingles');

    // Watch / Theater View
    this.watchSection = document.getElementById('watchSection');
    this.backToGalleryBtn = document.getElementById('backToGalleryBtn');
    this.watchTitle = document.getElementById('watchTitle');
    this.watchSubtitle = document.getElementById('watchSubtitle');
    this.watchModeToggle = document.getElementById('watchModeToggle');
    this.modePlaylistBtn = document.getElementById('modePlaylistBtn');
    this.modeTogetherBtn = document.getElementById('modeTogetherBtn');

    // Playlist layout
    this.playlistLayout = document.getElementById('playlistLayout');
    this.mainPlayerMount = document.getElementById('mainPlayerMount');
    this.activeMetaBar = document.getElementById('activeMetaBar');
    this.playlistSidebar = document.getElementById('playlistSidebar');
    this.partsListEl = document.getElementById('partsList');
    this.partsCountBadge = document.getElementById('partsCountBadge');
    this.sidebarLoopBtn = document.getElementById('sidebarLoopBtn');

    // Together layout
    this.togetherLayout = document.getElementById('togetherLayout');
    this.togetherGrid = document.getElementById('togetherGrid');
    this.syncPlayAllBtn = document.getElementById('syncPlayAllBtn');
    this.syncPauseAllBtn = document.getElementById('syncPauseAllBtn');
    this.syncRestartBtn = document.getElementById('syncRestartBtn');
    this.syncLoopAllBtn = document.getElementById('syncLoopAllBtn');
    this.syncUnmuteAllBtn = document.getElementById('syncUnmuteAllBtn');

    // More videos grid inside watch view
    this.upNextGrid = document.getElementById('upNextGrid');
  }

  async boot() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('./sw.js?v=2', { scope: './', updateViaCache: 'none' })
        .catch(() => {});
    }

    try {
      this.vaultManifest = await fetchVaultManifest();

      const savedPass = sessionStorage.getItem(SESSION_KEY);
      if (savedPass) {
        this.passkeyInput.value = savedPass;
        this.rememberSessionChk.checked = true;
        await this.attemptUnlock(savedPass, true);
      } else {
        setTimeout(() => this.passkeyInput.focus(), 100);
      }
    } catch (err) {
      this.showLockError(err.message);
    }
  }

  bindGlobalEvents() {
    this.toggleVisBtn.addEventListener('click', () => {
      const isPwd = this.passkeyInput.type === 'password';
      this.passkeyInput.type = isPwd ? 'text' : 'password';
      this.toggleVisBtn.setAttribute('aria-pressed', String(isPwd));
      this.passkeyInput.focus();
    });

    this.keypadToggleBtn.addEventListener('click', () => {
      const hidden = this.quickKeypad.hasAttribute('hidden');
      if (hidden) {
        this.quickKeypad.removeAttribute('hidden');
        this.keypadToggleBtn.textContent = 'Hide Keypad';
      } else {
        this.quickKeypad.setAttribute('hidden', '');
        this.keypadToggleBtn.textContent = 'Keypad';
      }
    });

    this.quickKeypad.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-key]');
      if (!btn) return;
      const key = btn.dataset.key;
      this.hideLockError();
      if (key === 'clear') {
        this.passkeyInput.value = '';
      } else if (key === 'back') {
        this.passkeyInput.value = this.passkeyInput.value.slice(0, -1);
      } else {
        this.passkeyInput.value += key;
      }
      this.passkeyInput.focus();
    });

    this.passkeyInput.addEventListener('input', () => {
      this.hideLockError();
    });

    this.lockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const passkey = this.passkeyInput.value.trim();
      if (!passkey) {
        this.showLockError('Enter passkey.');
        return;
      }
      await this.attemptUnlock(passkey, false);
    });

    // Search & Filters
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim().toLowerCase();
      this.clearSearchBtn.hidden = !this.searchQuery;
      this.renderGallery();
    });

    this.clearSearchBtn.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchQuery = '';
      this.clearSearchBtn.hidden = true;
      this.renderGallery();
      this.searchInput.focus();
    });

    this.filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeFilter = btn.dataset.filter;
        this.filterBtns.forEach((b) =>
          b.classList.toggle('is-active', b === btn)
        );
        if (!this.watchSection.hidden) {
          this.closeWatchView(true);
        }
        this.renderGallery();
      });
    });

    this.lockVaultBtn.addEventListener('click', () => {
      this.lockVault();
    });

    this.syncDriveBtn?.addEventListener('click', async () => {
      await this.handleManualDriveSync();
    });

    // Watch navigation & modes
    this.backToGalleryBtn.addEventListener('click', () => {
      this.closeWatchView(true);
    });

    this.modePlaylistBtn.addEventListener('click', () => {
      if (this.watchMode !== 'playlist') {
        this.switchWatchMode('playlist');
      }
    });

    this.modeTogetherBtn.addEventListener('click', () => {
      if (this.watchMode !== 'together') {
        this.switchWatchMode('together');
      }
    });

    this.sidebarLoopBtn.addEventListener('click', () => {
      if (this.mainPlayer) {
        this.mainPlayer.cycleLoopMode();
      }
    });

    // Together mode sync controls
    this.syncPlayAllBtn.addEventListener('click', () => {
      this.togetherPlayers.forEach((p) => p.play());
    });

    this.syncPauseAllBtn.addEventListener('click', () => {
      this.togetherPlayers.forEach((p) => p.pause());
    });

    this.syncRestartBtn.addEventListener('click', () => {
      this.togetherPlayers.forEach((p) => {
        p.seekTo(0);
        p.play();
      });
    });

    this.syncLoopAllBtn.addEventListener('click', () => {
      this.togetherLoopAll = !this.togetherLoopAll;
      this.syncLoopAllBtn.classList.toggle('is-active', this.togetherLoopAll);
      this.syncLoopAllBtn.querySelector('.sync-loop-state').textContent = this
        .togetherLoopAll
        ? 'ON'
        : 'OFF';
      this.togetherPlayers.forEach((p) =>
        p.setLoopMode(this.togetherLoopAll ? 'one' : 'off')
      );
    });

    this.syncUnmuteAllBtn.addEventListener('click', () => {
      const anySecondaryMuted = this.togetherPlayers
        .slice(1)
        .some((p) => p.video.muted);
      this.togetherPlayers.forEach((p, idx) => {
        if (anySecondaryMuted) {
          p.setMuted(false);
        } else {
          p.setMuted(idx > 0);
        }
      });
      this.updateUnmuteBtnLabel();
    });

    // Android hardware Back button / browser history integration
    window.addEventListener('popstate', () => {
      if (!this.watchSection.hidden) {
        this.closeWatchView(false);
      }
    });

    // Windows PC Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }

      if (this.watchSection.hidden) return;

      if (e.key === 'Escape') {
        if (!document.fullscreenElement) {
          this.closeWatchView(true);
        }
        return;
      }

      if (this.watchMode === 'playlist' && this.mainPlayer) {
        switch (e.key.toLowerCase()) {
          case ' ':
          case 'k':
            e.preventDefault();
            this.mainPlayer.togglePlay();
            break;
          case 'arrowleft':
          case 'j':
            e.preventDefault();
            this.mainPlayer.skip(-5);
            break;
          case 'arrowright':
          case 'l':
            e.preventDefault();
            this.mainPlayer.skip(5);
            break;
          case 'm':
            e.preventDefault();
            this.mainPlayer.setMuted(!this.mainPlayer.video.muted);
            break;
          case 'r':
            e.preventDefault();
            this.mainPlayer.cycleLoopMode();
            break;
          case 'f':
            e.preventDefault();
            this.mainPlayer.toggleFullscreen();
            break;
          case 'n':
            if (this.activeItem?.isGroup) {
              e.preventDefault();
              this.selectPart((this.activePartIdx + 1) % this.activeItem.parts.length);
            }
            break;
          case 'p':
            if (this.activeItem?.isGroup) {
              e.preventDefault();
              this.selectPart(
                (this.activePartIdx - 1 + this.activeItem.parts.length) %
                  this.activeItem.parts.length
              );
            }
            break;
          default:
            break;
        }
      }
    });
  }

  async handleManualDriveSync() {
    if (!this.session.hasGoogleDrive() || !this.syncDriveBtn) return;
    this.syncDriveBtn.disabled = true;
    try {
      await this.session.refreshGoogleDrive();
      this.updateCounts();
      this.renderGallery();
    } catch (err) {
      alert(`Refresh failed: ${err.message}`);
    } finally {
      this.syncDriveBtn.disabled = false;
    }
  }

  async attemptUnlock(passkey, silentAuto) {
    if (!this.vaultManifest) {
      this.vaultManifest = await fetchVaultManifest();
    }

    this.unlockBtn.disabled = true;
    this.unlockBtnText.textContent = 'Unlocking...';
    this.hideLockError();

    try {
      await this.session.unlock(this.vaultManifest, passkey);

      if (this.rememberSessionChk.checked) {
        sessionStorage.setItem(SESSION_KEY, passkey);
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }

      this.passkeyInput.value = '';
      this.enterVaultUI();
    } catch (err) {
      if (silentAuto) {
        sessionStorage.removeItem(SESSION_KEY);
        this.passkeyInput.value = '';
      } else if (err instanceof InvalidPasskeyError) {
        this.showLockError('Invalid passkey.');
        this.lockCard.classList.remove('shake');
        void this.lockCard.offsetWidth;
        this.lockCard.classList.add('shake');
        this.passkeyInput.select();
      } else {
        this.showLockError(err.message || 'Failed to unlock.');
      }
    } finally {
      this.unlockBtn.disabled = false;
      this.unlockBtnText.textContent = 'Unlock';
    }
  }

  showLockError(msg) {
    this.lockError.textContent = msg;
    this.lockError.hidden = false;
  }

  hideLockError() {
    this.lockError.hidden = true;
  }

  enterVaultUI() {
    this.lockScreen.hidden = true;
    this.appShell.hidden = false;
    this.updateCounts();
    this.renderGallery();
  }

  lockVault() {
    this.closeWatchView(false);
    sessionStorage.removeItem(SESSION_KEY);
    this.session.lock();
    this.appShell.hidden = true;
    this.lockScreen.hidden = false;
    this.passkeyInput.value = '';
    setTimeout(() => this.passkeyInput.focus(), 80);
  }

  updateCounts() {
    const all = this.session.catalog;
    const groups = all.filter((c) => c.isGroup);
    const singles = all.filter((c) => !c.isGroup);

    this.countAll.textContent = String(all.length);
    this.countGroups.textContent = String(groups.length);
    this.countSingles.textContent = String(singles.length);
    this.statsPill.textContent =
      all.length === 1 ? '1 Title' : `${all.length} Titles`;

    if (this.syncDriveBtn) {
      this.syncDriveBtn.hidden = !this.session.hasGoogleDrive();
    }
  }

  getFilteredCatalog() {
    return this.session.catalog.filter((item) => {
      if (this.activeFilter === 'groups' && !item.isGroup) return false;
      if (this.activeFilter === 'singles' && item.isGroup) return false;

      if (this.searchQuery) {
        const hay = [
          item.title,
          item.rawBase,
          item.folder,
          ...item.parts.map((p) => p.name),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(this.searchQuery)) return false;
      }
      return true;
    });
  }

  renderGallery() {
    const items = this.getFilteredCatalog();
    this.galleryGrid.innerHTML = '';

    if (items.length === 0) {
      this.emptyState.hidden = false;
      if (this.session.driveError) {
        this.emptyState.querySelector('.empty-title').textContent =
          'Unable to load videos';
        this.emptyState.querySelector('.empty-sub').textContent = this.session.driveError;
      } else {
        this.emptyState.querySelector('.empty-title').textContent =
          'No videos found';
        this.emptyState.querySelector('.empty-sub').textContent =
          'Try clearing your search or switching filters.';
      }
      return;
    }
    this.emptyState.hidden = true;

    for (const item of items) {
      const card = this.createMediaCard(item);
      this.galleryGrid.appendChild(card);
    }
  }

  createMediaCard(item) {
    const article = document.createElement('article');
    article.className = `media-card${item.isGroup ? ' is-group-card' : ''}`;
    article.tabIndex = 0;
    article.setAttribute('role', 'button');
    article.setAttribute(
      'aria-label',
      item.isGroup
        ? `${item.title}, ${item.partCount} parts`
        : item.title
    );

    const subMeta = item.isGroup
      ? `${item.partCount} parts`
      : item.folder || '';

    article.innerHTML = `
      ${item.isGroup ? `<div class="group-stack-layer layer-2"></div><div class="group-stack-layer layer-1"></div>` : ''}
      <div class="card-thumb-wrap">
        ${
          item.coverPoster
            ? `<img class="card-thumb-img" src="${item.coverPoster}" alt="${this.escapeHtml(
                item.title
              )}" loading="lazy" referrerpolicy="no-referrer" />`
            : `<div class="card-thumb-placeholder"><span>▶</span></div>`
        }
        <div class="card-gradient"></div>

        ${
          item.isGroup
            ? `<div class="card-badges-top">
                <span class="badge badge-parts">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                  ${item.partCount} PARTS
                </span>
              </div>`
            : ''
        }

        <div class="card-play-hover">
          <div class="card-play-circle">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
          </div>
        </div>

        ${
          item.totalDuration > 0
            ? `<div class="card-badges-bottom" style="justify-content:flex-end;">
                <span class="badge-duration">${formatTime(item.totalDuration)}</span>
              </div>`
            : ''
        }
      </div>

      <div class="card-body">
        <div class="card-title-row">
          <h3 class="card-title">${this.escapeHtml(item.title)}</h3>
        </div>
        ${subMeta ? `<p class="card-sub">${this.escapeHtml(subMeta)}</p>` : ''}
      </div>
    `;

    const imgEl = article.querySelector('.card-thumb-img');
    if (imgEl) {
      imgEl.addEventListener('error', () => {
        const ph = document.createElement('div');
        ph.className = 'card-thumb-placeholder';
        ph.innerHTML = '<span>▶</span>';
        imgEl.replaceWith(ph);
      });
    }

    const openHandler = () => this.openItem(item, 0, 'playlist');
    article.addEventListener('click', openHandler);
    article.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openHandler();
      }
    });

    return article;
  }

  openItem(item, partIdx = 0, mode = 'playlist') {
    const wasAlreadyOpen = !this.watchSection.hidden;
    this.destroyActivePlayers();

    this.activeItem = item;
    this.activePartIdx = partIdx;
    this.watchMode = item.isGroup ? mode : 'playlist';

    this.gallerySection.hidden = true;
    this.watchSection.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (!wasAlreadyOpen) {
      history.pushState({ watch: item.id }, '', `#watch=${encodeURIComponent(item.id)}`);
    }

    this.watchTitle.textContent = item.title;
    if (item.isGroup) {
      const durStr = item.totalDuration > 0 ? ` • ${formatTime(item.totalDuration)}` : '';
      this.watchSubtitle.textContent = `${item.partCount} parts${durStr}`;
      this.watchModeToggle.hidden = false;
    } else {
      const p = item.parts[0];
      const bits = [];
      if (p.duration > 0) bits.push(formatTime(p.duration));
      if (p.size > 0) bits.push(formatBytes(p.size));
      this.watchSubtitle.textContent = bits.join(' • ');
      this.watchModeToggle.hidden = true;
    }

    this.syncWatchModeUI();
    this.renderUpNext(item);
  }

  switchWatchMode(mode) {
    if (!this.activeItem) return;
    this.destroyActivePlayers();
    this.watchMode = mode;
    this.syncWatchModeUI();
  }

  syncWatchModeUI() {
    const item = this.activeItem;
    if (!item) return;

    this.modePlaylistBtn.classList.toggle('is-active', this.watchMode === 'playlist');
    this.modeTogetherBtn.classList.toggle('is-active', this.watchMode === 'together');

    if (this.watchMode === 'playlist') {
      this.togetherLayout.hidden = true;
      this.playlistLayout.hidden = false;
      this.playlistLayout.classList.toggle('is-single-layout', !item.isGroup);
      this.playlistSidebar.hidden = !item.isGroup;

      this.mainPlayer = new CipherPlayer(this.mainPlayerMount, {
        session: this.session,
        hasPlaylist: item.isGroup,
        loopMode: item.isGroup ? this.playlistLoopMode : this.singleLoopMode,
        autoplay: true,
        onPrevPart: () => {
          const prev = (this.activePartIdx - 1 + item.parts.length) % item.parts.length;
          this.selectPart(prev);
        },
        onNextPart: (fromEnded) => {
          const isLast = this.activePartIdx >= item.parts.length - 1;
          if (fromEnded && isLast && this.playlistLoopMode === 'off') {
            return;
          }
          const next = (this.activePartIdx + 1) % item.parts.length;
          this.selectPart(next);
        },
        onLoopModeChange: (newMode) => {
          if (item.isGroup) {
            this.playlistLoopMode = newMode;
            this.updateSidebarLoopLabel();
          } else {
            this.singleLoopMode = newMode;
          }
        },
      });

      if (item.isGroup) {
        this.partsCountBadge.textContent = `${item.partCount} Parts`;
        this.updateSidebarLoopLabel();
        this.renderPartsList();
      }

      this.selectPart(this.activePartIdx);
    } else {
      this.playlistLayout.hidden = true;
      this.togetherLayout.hidden = false;
      this.renderTogetherPlayers();
    }
  }

  updateSidebarLoopLabel() {
    const map = {
      all: 'Loop All: ON',
      one: 'Loop Part',
      off: 'Loop: OFF',
    };
    this.sidebarLoopBtn.textContent = map[this.playlistLoopMode] || 'Loop All: ON';
    this.sidebarLoopBtn.classList.toggle('is-active', this.playlistLoopMode !== 'off');
  }

  selectPart(idx) {
    if (!this.activeItem || !this.mainPlayer) return;
    this.activePartIdx = idx;
    const part = this.activeItem.parts[idx];
    this.mainPlayer.loadPart(part, true);
    this.renderActiveMetaBar(part);

    if (this.activeItem.isGroup) {
      this.highlightActivePartRow();
      const nextPart = this.activeItem.parts[(idx + 1) % this.activeItem.parts.length];
      if (nextPart && nextPart.id !== part.id) {
        setTimeout(() => {
          if (this.session.unlocked) {
            this.session.getPlayableMp4(nextPart).catch(() => {});
          }
        }, 700);
      }
    }
  }

  renderActiveMetaBar(part) {
    if (!this.activeItem.isGroup) {
      this.activeMetaBar.hidden = true;
      this.activeMetaBar.innerHTML = '';
      return;
    }

    this.activeMetaBar.hidden = false;
    const details = [];
    if (part.duration > 0) details.push(formatTime(part.duration));
    if (part.size > 0) details.push(formatBytes(part.size));

    this.activeMetaBar.innerHTML = `
      <div class="active-meta-left">
        <span class="meta-pill meta-pill-accent">${this.escapeHtml(part.partLabel)} / ${
      this.activeItem.partCount
    }</span>
        ${details.length ? `<span class="meta-dim">${details.join(' • ')}</span>` : ''}
      </div>
    `;
  }

  renderPartsList() {
    const item = this.activeItem;
    if (!item || !item.isGroup) return;
    this.partsListEl.innerHTML = '';

    item.parts.forEach((part, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `part-row${idx === this.activePartIdx ? ' is-playing' : ''}`;
      btn.dataset.partIdx = String(idx);

      btn.innerHTML = `
        <div class="part-thumb-box">
          ${
            part.poster
              ? `<img src="${part.poster}" alt="${this.escapeHtml(
                  part.partLabel
                )}" referrerpolicy="no-referrer" />`
              : `<div class="part-thumb-fallback">▶</div>`
          }
          ${part.duration > 0 ? `<span class="part-dur">${formatTime(part.duration)}</span>` : ''}
          <div class="part-eq" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
        </div>
        <div class="part-info">
          <div class="part-label-row">
            <span class="part-num">${this.escapeHtml(part.partLabel)}</span>
          </div>
          ${part.size > 0 ? `<div class="part-blob-sub">${formatBytes(part.size)}</div>` : ''}
        </div>
      `;

      const thumbImg = btn.querySelector('img');
      if (thumbImg) {
        thumbImg.addEventListener('error', () => {
          const fb = document.createElement('div');
          fb.className = 'part-thumb-fallback';
          fb.textContent = '▶';
          thumbImg.replaceWith(fb);
        });
      }

      btn.addEventListener('click', () => this.selectPart(idx));
      this.partsListEl.appendChild(btn);
    });
  }

  highlightActivePartRow() {
    const rows = this.partsListEl.querySelectorAll('.part-row');
    rows.forEach((row, idx) => {
      const active = idx === this.activePartIdx;
      row.classList.toggle('is-playing', active);
      if (active) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  renderTogetherPlayers() {
    const item = this.activeItem;
    if (!item) return;

    this.togetherGrid.innerHTML = '';
    this.togetherGrid.dataset.count = String(item.parts.length);
    this.togetherPlayers = [];

    this.syncLoopAllBtn.classList.toggle('is-active', this.togetherLoopAll);
    this.syncLoopAllBtn.querySelector('.sync-loop-state').textContent = this
      .togetherLoopAll
      ? 'ON'
      : 'OFF';

    item.parts.forEach((part, idx) => {
      const cell = document.createElement('div');
      cell.className = 'together-cell';

      cell.innerHTML = `
        <div class="together-cell-head">
          <div class="together-cell-title">
            <span class="badge badge-parts">${this.escapeHtml(part.partLabel)}</span>
          </div>
        </div>
        <div class="together-player-mount"></div>
      `;

      this.togetherGrid.appendChild(cell);
      const mount = cell.querySelector('.together-player-mount');

      const player = new CipherPlayer(mount, {
        session: this.session,
        hasPlaylist: false,
        loopMode: this.togetherLoopAll ? 'one' : 'off',
        compact: true,
        autoplay: true,
        initialMuted: idx > 0,
        onStateChange: () => this.updateUnmuteBtnLabel(),
      });

      player.loadPart(part, true);
      this.togetherPlayers.push(player);
    });

    this.updateUnmuteBtnLabel();
  }

  updateUnmuteBtnLabel() {
    if (this.togetherPlayers.length <= 1) {
      this.syncUnmuteAllBtn.hidden = true;
      return;
    }
    this.syncUnmuteAllBtn.hidden = false;
    const anySecondaryMuted = this.togetherPlayers
      .slice(1)
      .some((p) => p.video.muted);
    this.syncUnmuteAllBtn.textContent = anySecondaryMuted
      ? 'Audio: Part 1 Only'
      : 'Audio: All Parts';
  }

  renderUpNext(currentItem) {
    this.upNextGrid.innerHTML = '';
    const others = this.session.catalog.filter((c) => c.id !== currentItem.id);
    this.upNextGrid.parentElement.hidden = others.length === 0;
    for (const item of others) {
      this.upNextGrid.appendChild(this.createMediaCard(item));
    }
  }

  closeWatchView(updateHistory = false) {
    if (this.watchSection.hidden) return;
    this.destroyActivePlayers();
    this.activeItem = null;
    this.watchSection.hidden = true;
    this.gallerySection.hidden = false;

    if (updateHistory && window.location.hash.startsWith('#watch=')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  destroyActivePlayers() {
    if (this.mainPlayer) {
      this.mainPlayer.destroy();
      this.mainPlayer = null;
    }
    for (const p of this.togetherPlayers) {
      p.destroy();
    }
    this.togetherPlayers = [];
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.__cipherVault = new CipherVaultApp();
});
