import {
  fetchVaultManifest,
  VaultSession,
  InvalidPasskeyError,
} from './crypto-engine.js';
import { CipherPlayer, formatTime, formatBytes } from './player.js';

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
    this.lockVaultStatus = document.getElementById('lockVaultStatus');
    this.keypadToggleBtn = document.getElementById('keypadToggleBtn');
    this.quickKeypad = document.getElementById('quickKeypad');

    // App Shell
    this.appShell = document.getElementById('appShell');
    this.statsPill = document.getElementById('vaultStatsPill');
    this.searchInput = document.getElementById('searchInput');
    this.clearSearchBtn = document.getElementById('clearSearchBtn');
    this.filterBtns = document.querySelectorAll('[data-filter]');
    this.lockVaultBtn = document.getElementById('lockVaultBtn');
    this.inspectorBtn = document.getElementById('inspectorBtn');

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

    // Up next grid inside watch view
    this.upNextGrid = document.getElementById('upNextGrid');

    // Vault Inspector Modal
    this.inspectorModal = document.getElementById('inspectorModal');
    this.closeInspectorBtn = document.getElementById('closeInspectorBtn');
    this.inspectorTableBody = document.getElementById('inspectorTableBody');
  }

  async boot() {
    try {
      this.vaultManifest = await fetchVaultManifest();
      const count = (this.vaultManifest.entries || []).length;
      this.lockVaultStatus.textContent = `${count} encrypted stream blobs sealed in assets/videos/`;

      // Auto-unlock if passkey stored in current tab sessionStorage
      const savedPass = sessionStorage.getItem(SESSION_KEY);
      if (savedPass) {
        this.passkeyInput.value = savedPass;
        this.rememberSessionChk.checked = true;
        await this.attemptUnlock(savedPass, true);
      } else {
        setTimeout(() => this.passkeyInput.focus(), 100);
      }
    } catch (err) {
      this.lockVaultStatus.textContent = 'Vault offline or missing assets/core.vlt';
      this.showLockError(err.message);
    }
  }

  bindGlobalEvents() {
    // Passkey visibility toggle
    this.toggleVisBtn.addEventListener('click', () => {
      const isPwd = this.passkeyInput.type === 'password';
      this.passkeyInput.type = isPwd ? 'text' : 'password';
      this.toggleVisBtn.setAttribute('aria-pressed', String(isPwd));
      this.passkeyInput.focus();
    });

    // Optional tactile keypad for touch convenience
    this.keypadToggleBtn.addEventListener('click', () => {
      const hidden = this.quickKeypad.hasAttribute('hidden');
      if (hidden) {
        this.quickKeypad.removeAttribute('hidden');
        this.keypadToggleBtn.textContent = 'Hide Keypad';
      } else {
        this.quickKeypad.setAttribute('hidden', '');
        this.keypadToggleBtn.textContent = 'Touch Keypad';
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
        this.showLockError('Enter your security passkey to decrypt the vault.');
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

    // Lock Vault button
    this.lockVaultBtn.addEventListener('click', () => {
      this.lockVault();
    });

    // Inspector modal
    this.inspectorBtn.addEventListener('click', () => {
      this.renderInspectorModal();
      this.inspectorModal.hidden = false;
    });

    this.closeInspectorBtn.addEventListener('click', () => {
      this.inspectorModal.hidden = true;
    });

    this.inspectorModal.addEventListener('click', (e) => {
      if (e.target === this.inspectorModal) {
        this.inspectorModal.hidden = true;
      }
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
      if (!this.inspectorModal.hidden) {
        this.inspectorModal.hidden = true;
        return;
      }
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

      if (!this.inspectorModal.hidden && e.key === 'Escape') {
        this.inspectorModal.hidden = true;
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

  async attemptUnlock(passkey, silentAuto) {
    if (!this.vaultManifest) {
      this.vaultManifest = await fetchVaultManifest();
    }

    this.unlockBtn.disabled = true;
    this.unlockBtnText.textContent = 'Deriving AES-256 Key...';
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
        this.showLockError('Access denied — invalid passkey.');
        this.lockCard.classList.remove('shake');
        void this.lockCard.offsetWidth;
        this.lockCard.classList.add('shake');
        this.passkeyInput.select();
      } else {
        this.showLockError(err.message || 'Failed to unlock vault.');
      }
    } finally {
      this.unlockBtn.disabled = false;
      this.unlockBtnText.textContent = 'Unlock Vault';
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
    this.inspectorModal.hidden = true;
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
    this.statsPill.textContent = `${all.length} Titles • ${this.session.rawEntriesCount} MP4 Streams`;
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
        ? `${item.title}, ${item.partCount} parts, ${formatTime(item.totalDuration)}`
        : `${item.title}, ${formatTime(item.totalDuration)}`
    );

    const subtitleText = item.isGroup
      ? `${item.parts[0].name} … ${item.parts[item.parts.length - 1].name}`
      : `${item.parts[0].name} • ${item.width}×${item.height}`;

    article.innerHTML = `
      ${item.isGroup ? `<div class="group-stack-layer layer-2"></div><div class="group-stack-layer layer-1"></div>` : ''}
      <div class="card-thumb-wrap">
        ${
          item.coverPoster
            ? `<img class="card-thumb-img" src="${item.coverPoster}" alt="${this.escapeHtml(item.title)}" loading="lazy" />`
            : `<div class="card-thumb-placeholder"><span>MP4</span></div>`
        }
        <div class="card-gradient"></div>

        <div class="card-badges-top">
          ${
            item.isGroup
              ? `<span class="badge badge-parts">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                  ${item.partCount} PARTS
                 </span>`
              : `<span class="badge badge-single">SINGLE</span>`
          }
          <span class="badge badge-mp4">MP4</span>
        </div>

        <div class="card-play-hover">
          <div class="card-play-circle">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
          </div>
        </div>

        <div class="card-badges-bottom">
          ${
            item.isGroup
              ? `<span class="card-together-hint">Playlist + Together View</span>`
              : `<span>${formatBytes(item.totalSize)}</span>`
          }
          <span class="badge-duration">${formatTime(item.totalDuration)}</span>
        </div>
      </div>

      <div class="card-body">
        <div class="card-title-row">
          <h3 class="card-title">${this.escapeHtml(item.title)}</h3>
        </div>
        <p class="card-sub">${this.escapeHtml(subtitleText)}</p>
      </div>
    `;

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

    // Header info
    this.watchTitle.textContent = item.title;
    if (item.isGroup) {
      this.watchSubtitle.textContent = `${item.partCount} grouped parts • Total ${formatTime(
        item.totalDuration
      )} • ${formatBytes(item.totalSize)}`;
      this.watchModeToggle.hidden = false;
    } else {
      const p = item.parts[0];
      this.watchSubtitle.textContent = `${p.name} • ${p.width}×${p.height} • ${formatBytes(
        p.size
      )}`;
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
            return; // Stop cleanly after last part when Loop Off
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
      // TOGETHER MODE: Show and play all parts together on one screen!
      this.playlistLayout.hidden = true;
      this.togetherLayout.hidden = false;
      this.renderTogetherPlayers();
    }
  }

  updateSidebarLoopLabel() {
    const map = {
      all: 'Loop All: ON',
      one: 'Loop Current Part',
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
      // Pre-decrypt next part in background for zero-gap transition!
      const nextPart = this.activeItem.parts[(idx + 1) % this.activeItem.parts.length];
      if (nextPart && nextPart.blobFile !== part.blobFile) {
        setTimeout(() => {
          if (this.session.unlocked) {
            this.session.getPlayableMp4(nextPart).catch(() => {});
          }
        }, 700);
      }
    }
  }

  renderActiveMetaBar(part) {
    const partBadge = this.activeItem.isGroup
      ? `<span class="meta-pill meta-pill-accent">${this.escapeHtml(part.partLabel)} / ${
          this.activeItem.partCount
        }</span>`
      : `<span class="meta-pill meta-pill-accent">Standalone MP4</span>`;

    this.activeMetaBar.innerHTML = `
      <div class="active-meta-left">
        ${partBadge}
        <span class="meta-filename">${this.escapeHtml(part.name)}</span>
        <span class="meta-dim">${part.width}×${part.height} • ${formatTime(part.duration)} • ${formatBytes(part.size)}</span>
      </div>
      <div class="active-meta-right">
        <span class="meta-cipher-tag" title="Decrypted in memory from obfuscated GitHub file">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          GitHub blob: <code>${this.escapeHtml(part.blobFile)}</code> → <code>.mp4</code>
        </span>
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
              ? `<img src="${part.poster}" alt="${this.escapeHtml(part.partLabel)}" />`
              : `<div class="part-thumb-fallback">MP4</div>`
          }
          <span class="part-dur">${formatTime(part.duration)}</span>
          <div class="part-eq" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
        </div>
        <div class="part-info">
          <div class="part-label-row">
            <span class="part-num">${this.escapeHtml(part.partLabel)}</span>
            <span class="part-mp4-tag">MP4</span>
          </div>
          <div class="part-fname">${this.escapeHtml(part.name)}</div>
          <div class="part-blob-sub">${this.escapeHtml(part.blobFile)} • ${formatBytes(part.size)}</div>
        </div>
      `;

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
            <strong>${this.escapeHtml(part.name)}</strong>
          </div>
          <span class="together-blob-tag">${this.escapeHtml(part.blobFile)} → MP4</span>
        </div>
        <div class="together-player-mount"></div>
      `;

      this.togetherGrid.appendChild(cell);
      const mount = cell.querySelector('.together-player-mount');

      // Mute parts > 0 initially so audio doesn't clash simultaneously unless user taps Unmute All
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
      ? 'Audio: Part 1 Only (Tap to Unmute All)'
      : 'Audio: All Parts Active (Tap for Part 1 Only)';
  }

  renderUpNext(currentItem) {
    this.upNextGrid.innerHTML = '';
    const others = this.session.catalog.filter((c) => c.id !== currentItem.id);
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

  renderInspectorModal() {
    this.inspectorTableBody.innerHTML = '';
    for (const item of this.session.catalog) {
      for (const part of item.parts) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><code>assets/videos/${this.escapeHtml(part.blobFile)}</code></td>
          <td><strong>${this.escapeHtml(part.name)}</strong></td>
          <td>${
            item.isGroup
              ? `<span class="table-group-pill">${this.escapeHtml(item.title)} (${this.escapeHtml(part.partLabel)})</span>`
              : `<span class="table-single-pill">Single</span>`
          }</td>
          <td>${formatTime(part.duration)} • ${formatBytes(part.size)}</td>
        `;
        this.inspectorTableBody.appendChild(tr);
      }
    }
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
