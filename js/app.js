/*
 * Windows 95 desktop shell around the maze screen saver.
 * No framework, no build step: settings live in localStorage, the screen
 * saver runs on a canvas, and the rest is bevels and nostalgia.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'win95maze.settings.v1';

  var DEFAULTS = {
    wallTheme: 'brick',
    quality: 'normal',
    bob: true,
    showHint: true,
    mazeSize: 15,
    speed: 'normal'
  };

  var VALID = {
    wallTheme: ['brick', 'cobble', 'mixed'],
    quality: ['chunky', 'normal', 'sharp'],
    speed: ['slow', 'normal', 'fast'],
    mazeSize: [11, 15, 21]
  };

  var $ = function (id) {
    return document.getElementById(id);
  };

  var desktop = $('desktop');
  var mazeIcon = $('mazeIcon');
  var readmeIcon = $('readmeIcon');
  var startHint = $('startHint');
  var startButton = $('startButton');
  var startMenu = $('startMenu');
  var clock = $('clock');
  var screensaverOverlay = $('screensaver');
  var screensaverCanvas = $('mazeCanvas');
  var ssHint = $('ssHint');
  var shutdownScreen = $('shutdownScreen');

  var settingsWindow = $('settingsWindow');
  var aboutWindow = $('aboutWindow');

  var fields = {
    wallTheme: $('wallTheme'),
    quality: $('quality'),
    bob: $('bob'),
    showHint: $('showHint'),
    mazeSize: $('mazeSize'),
    speed: $('speed')
  };

  var settings = loadSettings();
  var screensaver = new window.Win95MazeScreensaver(screensaverCanvas);
  var screensaverActive = false;
  var screensaverStartedAt = 0;
  var hintTimer = 0;
  var zCounter = 60;
  var coarsePointer = window.matchMedia('(pointer: coarse)').matches;

  /* ------------------------------------------------------------- settings */

  function loadSettings() {
    var loaded = null;
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch (error) {
      loaded = null;
    }
    return normalizeSettings(loaded);
  }

  function normalizeSettings(raw) {
    var next = {
      wallTheme: DEFAULTS.wallTheme,
      quality: DEFAULTS.quality,
      bob: DEFAULTS.bob,
      showHint: DEFAULTS.showHint,
      mazeSize: DEFAULTS.mazeSize,
      speed: DEFAULTS.speed
    };

    if (!raw || typeof raw !== 'object') return next;

    if (VALID.wallTheme.indexOf(raw.wallTheme) !== -1) next.wallTheme = raw.wallTheme;
    if (VALID.quality.indexOf(raw.quality) !== -1) next.quality = raw.quality;
    if (VALID.speed.indexOf(raw.speed) !== -1) next.speed = raw.speed;
    if (VALID.mazeSize.indexOf(Number(raw.mazeSize)) !== -1) next.mazeSize = Number(raw.mazeSize);
    if (typeof raw.bob === 'boolean') next.bob = raw.bob;
    if (typeof raw.showHint === 'boolean') next.showHint = raw.showHint;

    return next;
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      /* Private mode or file://; the saver still works for this session. */
    }
  }

  function fillForm() {
    fields.wallTheme.value = settings.wallTheme;
    fields.quality.value = settings.quality;
    fields.bob.checked = settings.bob;
    fields.showHint.checked = settings.showHint;
    fields.mazeSize.value = String(settings.mazeSize);
    fields.speed.value = settings.speed;
  }

  function readForm() {
    return normalizeSettings({
      wallTheme: fields.wallTheme.value,
      quality: fields.quality.value,
      bob: fields.bob.checked,
      showHint: fields.showHint.checked,
      mazeSize: Number(fields.mazeSize.value),
      speed: fields.speed.value
    });
  }

  /* ---------------------------------------------------------- window shell */

  function bringToFront(win) {
    zCounter += 1;
    win.style.zIndex = String(zCounter);
  }

  function centreIfNeeded(win) {
    if (!win.style.left) {
      win.style.left = '50%';
      win.style.top = '45%';
      win.style.transform = 'translate(-50%, -50%)';
    }
  }

  function openWindow(win) {
    centreIfNeeded(win);
    win.hidden = false;
    bringToFront(win);
  }

  function closeWindow(win) {
    win.hidden = true;
  }

  function makeDraggable(win) {
    var handle = win.querySelector('[data-drag]');
    var dragging = false;
    var offsetX = 0;
    var offsetY = 0;

    handle.addEventListener('pointerdown', function (event) {
      if (event.target.closest('.titlebar-button')) return;
      if (event.button !== 0 && event.pointerType === 'mouse') return;

      var rect = win.getBoundingClientRect();
      win.style.left = rect.left + 'px';
      win.style.top = rect.top + 'px';
      win.style.transform = 'none';

      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      dragging = true;
      win.classList.add('is-dragging');
      bringToFront(win);

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
      event.preventDefault();
    });

    handle.addEventListener('pointermove', function (event) {
      if (!dragging) return;

      var maxLeft = window.innerWidth - 48;
      var maxTop = window.innerHeight - 60;
      var left = Math.min(Math.max(event.clientX - offsetX, 48 - win.offsetWidth), maxLeft);
      var top = Math.min(Math.max(event.clientY - offsetY, 0), maxTop);

      win.style.left = left + 'px';
      win.style.top = top + 'px';
    });

    function stopDragging(event) {
      if (!dragging) return;
      dragging = false;
      win.classList.remove('is-dragging');
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
    }

    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
  }

  makeDraggable(settingsWindow);
  makeDraggable(aboutWindow);

  // Clicking a window raises it.
  [settingsWindow, aboutWindow].forEach(function (win) {
    win.addEventListener('pointerdown', function () {
      bringToFront(win);
    });
  });

  /* --------------------------------------------------------- settings UI */

  function switchTab(name) {
    var tabs = settingsWindow.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('is-active', active);
      tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }

    var panels = settingsWindow.querySelectorAll('.tab-panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].hidden = panels[j].getAttribute('data-panel') !== name;
    }
  }

  var tabButtons = settingsWindow.querySelectorAll('.tab');
  for (var t = 0; t < tabButtons.length; t++) {
    tabButtons[t].addEventListener('click', function () {
      switchTab(this.getAttribute('data-tab'));
    });
  }

  function openSettings() {
    fillForm();
    switchTab('screen');
    openWindow(settingsWindow);
    fields.wallTheme.focus();
  }

  function closeSettings() {
    closeWindow(settingsWindow);
    mazeIcon.focus();
  }

  function openAbout() {
    openWindow(aboutWindow);
    $('aboutOk').focus();
  }

  function closeAbout() {
    closeWindow(aboutWindow);
    mazeIcon.focus();
  }

  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsCancel').addEventListener('click', closeSettings);
  $('settingsOk').addEventListener('click', function () {
    settings = readForm();
    saveSettings();
    closeSettings();
  });
  $('settingsPreview').addEventListener('click', function () {
    settings = readForm();
    saveSettings();
    startScreenSaver();
  });

  $('aboutClose').addEventListener('click', closeAbout);
  $('aboutOk').addEventListener('click', closeAbout);

  /* ------------------------------------------------------------- start menu */

  function openStartMenu() {
    startMenu.hidden = false;
    startButton.classList.add('is-open');
    startButton.setAttribute('aria-expanded', 'true');
    $('menuMaze').focus();
  }

  function closeStartMenu() {
    startMenu.hidden = true;
    startButton.classList.remove('is-open');
    startButton.setAttribute('aria-expanded', 'false');
  }

  function toggleStartMenu() {
    if (startMenu.hidden) openStartMenu();
    else closeStartMenu();
  }

  startButton.addEventListener('click', function (event) {
    event.stopPropagation();
    toggleStartMenu();
  });

  document.addEventListener('pointerdown', function (event) {
    if (startMenu.hidden) return;
    if (startMenu.contains(event.target) || startButton.contains(event.target)) return;
    closeStartMenu();
  });

  $('menuMaze').addEventListener('click', function () {
    closeStartMenu();
    startScreenSaver();
  });

  $('menuSettings').addEventListener('click', function () {
    closeStartMenu();
    openSettings();
  });

  $('menuAbout').addEventListener('click', function () {
    closeStartMenu();
    openAbout();
  });

  $('menuShutdown').addEventListener('click', function () {
    closeStartMenu();
    showShutdown();
  });

  /* ------------------------------------------------------------ icons, clock */

  function selectIcon(icon) {
    var icons = desktop.querySelectorAll('.desktop-icon');
    for (var i = 0; i < icons.length; i++) {
      icons[i].classList.toggle('is-selected', icons[i] === icon);
    }
  }

  mazeIcon.addEventListener('click', function () {
    selectIcon(mazeIcon);
    if (coarsePointer) startScreenSaver();
  });

  mazeIcon.addEventListener('dblclick', function () {
    startScreenSaver();
  });

  readmeIcon.addEventListener('click', function () {
    selectIcon(readmeIcon);
    if (coarsePointer) openAbout();
  });

  readmeIcon.addEventListener('dblclick', function () {
    openAbout();
  });

  desktop.addEventListener('pointerdown', function (event) {
    if (event.target === desktop) {
      var icons = desktop.querySelectorAll('.desktop-icon');
      for (var i = 0; i < icons.length; i++) icons[i].classList.remove('is-selected');
    }
  });

  function hideStartHint() {
    startHint.classList.add('is-gone');
  }

  window.setTimeout(hideStartHint, 14000);

  function updateClock() {
    var now = new Date();
    var hours = now.getHours();
    var minutes = now.getMinutes();
    var suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    clock.textContent = hours + ':' + (minutes < 10 ? '0' : '') + minutes + ' ' + suffix;
  }

  updateClock();
  window.setInterval(updateClock, 5000);

  /* ---------------------------------------------------------- screen saver */

  function startScreenSaver() {
    if (screensaverActive) return;

    closeStartMenu();
    closeWindow(settingsWindow);
    hideStartHint();

    screensaverActive = true;
    screensaverStartedAt = performance.now();

    screensaverOverlay.hidden = false;
    screensaverOverlay.setAttribute('aria-hidden', 'false');
    screensaverOverlay.focus({ preventScroll: true });

    ssHint.textContent = coarsePointer
      ? 'Tap anywhere to exit'
      : 'Click anywhere or press Esc to exit';

    window.clearTimeout(hintTimer);
    ssHint.classList.remove('is-gone');
    if (settings.showHint) {
      ssHint.classList.remove('is-dim');
      hintTimer = window.setTimeout(function () {
        ssHint.classList.add('is-dim');
      }, 6000);
    } else {
      ssHint.classList.add('is-gone');
    }

    screensaver.start(settings).catch(function (error) {
      stopScreenSaver();
      startHint.classList.remove('is-gone');
      startHint.innerHTML = 'Could not load the maze assets.<br>' +
        'Serve this folder over HTTP (for example <b>python3 -m http.server</b>) and reload.';
      window.console.error(error);
    });
  }

  function stopScreenSaver() {
    if (!screensaverActive) return;

    screensaverActive = false;
    screensaver.stop();
    screensaverOverlay.hidden = true;
    screensaverOverlay.setAttribute('aria-hidden', 'true');
    ssHint.classList.add('is-gone');
    ssHint.classList.remove('is-dim');
    window.clearTimeout(hintTimer);

    mazeIcon.focus({ preventScroll: true });
  }

  $('ssExit').addEventListener('click', function () {
    stopScreenSaver();
  });

  // If the renderer throws while running, say so instead of leaving a frozen
  // picture behind. The message is shown in the screen saver hint.
  window.addEventListener('error', function (event) {
    if (!screensaverActive) return;
    ssHint.textContent = 'Screen saver error: ' + (event.message || 'unknown') + ' — click to exit';
    ssHint.classList.remove('is-gone', 'is-dim');
    window.console.error(event.error || event.message);
  });

  window.addEventListener('unhandledrejection', function (event) {
    if (!screensaverActive) return;
    var reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
    ssHint.textContent = 'Screen saver error: ' + reason + ' — click to exit';
    ssHint.classList.remove('is-gone', 'is-dim');
    window.console.error(event.reason);
  });

  // The Exit button gets to run its own click handler; everything else wakes
  // the screen saver immediately.
  window.addEventListener('pointerdown', function (event) {
    if (!screensaverActive) return;
    if (performance.now() - screensaverStartedAt < 450) return;
    if (event.target.closest && event.target.closest('#ssExit')) return;
    event.preventDefault();
    stopScreenSaver();
  }, true);

  window.addEventListener('keydown', function (event) {
    if (!screensaverActive) return;
    if (performance.now() - screensaverStartedAt < 300) return;

    event.preventDefault();
    stopScreenSaver();
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && screensaverActive) stopScreenSaver();
  });

  /* --------------------------------------------------------------- shutdown */

  function showShutdown() {
    hideStartHint();
    closeWindow(settingsWindow);
    closeWindow(aboutWindow);
    shutdownScreen.hidden = false;
    shutdownScreen.focus({ preventScroll: true });
  }

  function hideShutdown() {
    shutdownScreen.hidden = true;
    mazeIcon.focus({ preventScroll: true });
  }

  shutdownScreen.addEventListener('pointerdown', function (event) {
    event.preventDefault();
    hideShutdown();
  });

  window.addEventListener('keydown', function (event) {
    if (shutdownScreen.hidden) return;
    event.preventDefault();
    hideShutdown();
  }, true);

  /* ------------------------------------------------------------- shortcuts */

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (!startMenu.hidden) {
        closeStartMenu();
        startButton.focus();
      } else if (!settingsWindow.hidden) {
        closeSettings();
      } else if (!aboutWindow.hidden) {
        closeAbout();
      }
    }
  });

  screensaverOverlay.setAttribute('tabindex', '-1');
})();
