/*
 * 3D Pinball — a self-contained pinball table for the Windows 95 desktop.
 *
 * No assets, no dependencies. The table, physics, sprites, and synthesized
 * sound effects are all original. Physics runs on a fixed 240 Hz timestep so
 * the ball behaves the same on a 60 Hz laptop and a 144 Hz monitor.
 */
(function (global) {
  'use strict';

  var W = 400;
  var H = 640;
  var BALL_R = 7.5;
  var GRAVITY = 1450;
  var MAX_SPEED = 1750;
  var STEP = 1 / 240;
  var HIGH_KEY = 'win95pinball.high.v1';
  var MUTE_KEY = 'win95pinball.muted.v1';

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  function extend(target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  function moveToward(current, target, maxDelta) {
    if (current < target) return Math.min(current + maxDelta, target);
    return Math.max(current - maxDelta, target);
  }

  function hypot(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  /* --------------------------------------------------------------- audio */

  function AudioKit() {
    this.ctx = null;
    this.muted = false;
    try {
      this.muted = global.localStorage.getItem(MUTE_KEY) === '1';
    } catch (error) {
      this.muted = false;
    }
  }

  AudioKit.prototype.enable = function () {
    if (!this.ctx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (Ctor) {
        try {
          this.ctx = new Ctor();
        } catch (error) {
          this.ctx = null;
        }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  };

  AudioKit.prototype.beep = function (freq, endFreq, duration, type, volume) {
    if (this.muted || !this.ctx) return;
    var ctx = this.ctx;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();

    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq && endFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + duration);
    }

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume || 0.05), t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  };

  AudioKit.prototype.bumper = function () {
    this.beep(420, 880, 0.09, 'square', 0.055);
  };
  AudioKit.prototype.sling = function () {
    this.beep(180, 320, 0.055, 'triangle', 0.05);
  };
  AudioKit.prototype.flipper = function () {
    this.beep(95, 55, 0.045, 'square', 0.035);
  };
  AudioKit.prototype.launch = function () {
    this.beep(120, 720, 0.3, 'sawtooth', 0.04);
  };
  AudioKit.prototype.target = function () {
    this.beep(760, 1020, 0.07, 'square', 0.045);
  };
  AudioKit.prototype.rollover = function () {
    this.beep(620, 940, 0.06, 'sine', 0.05);
  };
  AudioKit.prototype.spinner = function () {
    this.beep(320, 520, 0.05, 'triangle', 0.035);
  };
  AudioKit.prototype.saucer = function () {
    var self = this;
    this.beep(520, 900, 0.1, 'square', 0.05);
    global.setTimeout(function () { self.beep(780, 1300, 0.12, 'square', 0.05); }, 90);
  };
  AudioKit.prototype.drain = function () {
    this.beep(300, 70, 0.45, 'sawtooth', 0.05);
  };
  AudioKit.prototype.extra = function () {
    var self = this;
    this.beep(600, 600, 0.1, 'square', 0.05);
    global.setTimeout(function () { self.beep(900, 900, 0.1, 'square', 0.05); }, 110);
    global.setTimeout(function () { self.beep(1250, 1250, 0.16, 'square', 0.05); }, 220);
  };
  AudioKit.prototype.gameOver = function () {
    this.beep(440, 55, 0.9, 'triangle', 0.06);
  };
  AudioKit.prototype.tilt = function () {
    this.beep(140, 90, 0.5, 'sawtooth', 0.06);
  };

  /* --------------------------------------------------------------- table */

  function makeTable(game) {
    var table = {
      segments: [],
      bumpers: [],
      posts: [],
      targets: [],
      rollovers: [],
      slings: [],
      saucer: { x: 200, y: 340, r: 14, pulse: 0, inside: false },
      spinner: { x: 318, y: 340, r: 14, angle: 0, omega: 0, inside: false },
      stars: []
    };

    function segment(ax, ay, bx, by, options) {
      var s = extend({
        ax: ax, ay: ay, bx: bx, by: by,
        hr: 4, e: 0.4, kick: 0, kind: 'wall', gate: false,
        nextHit: 0, target: null
      }, options || {});
      table.segments.push(s);
      return s;
    }

    function arc(cx, cy, radius, a0, a1, steps, options) {
      var prevX = cx + Math.cos(a0) * radius;
      var prevY = cy + Math.sin(a0) * radius;
      for (var i = 1; i <= steps; i++) {
        var angle = a0 + (a1 - a0) * (i / steps);
        var x = cx + Math.cos(angle) * radius;
        var y = cy + Math.sin(angle) * radius;
        segment(prevX, prevY, x, y, options);
        prevX = x;
        prevY = y;
      }
    }

    /* Outer shell: rounded top, straight sides, launch lane on the right. */
    segment(18, 150, 18, 500);
    segment(18, 500, 66, 592);
    segment(348, 510, 300, 592);
    segment(348, 636, 382, 636);
    segment(348, 200, 348, 636, { hr: 4.5 });
    segment(382, 150, 382, 636);
    arc(130, 150, 112, Math.PI, Math.PI * 1.5, 16);
    segment(130, 38, 270, 38);
    arc(270, 150, 112, Math.PI * 1.5, Math.PI * 2, 16);

    /* One-way gate at the top of the launch lane. It only blocks a ball that
       is coming back down, so a launched ball passes straight through. */
    segment(350, 206, 381, 192, { gate: true, e: 0.2, kind: 'gate' });

    /* Slingshots: a kicker face plus the two sides of the triangle. */
    function sling(ax, ay, bx, by, cx, cy) {
      var face = segment(ax, ay, bx, by, { e: 0.55, kick: 245, kind: 'sling' });
      face.onHit = function () {
        game.addScore(50 * game.multiplier);
        game.audio.sling();
        game.spark((ax + bx) / 2, (ay + by) / 2, '#ffd76a', 4);
      };
      segment(ax, ay, cx, cy, { e: 0.35 });
      segment(cx, cy, bx, by, { e: 0.35 });
      table.slings.push({ ax: ax, ay: ay, bx: bx, by: by, cx: cx, cy: cy });
    }
    sling(128, 486, 94, 552, 130, 552);
    sling(272, 486, 306, 552, 270, 552);

    /* Pop bumpers. */
    table.bumpers.push(
      { x: 120, y: 205, r: 18, color: '#ff7a3d', nextHit: 0, pulse: 0 },
      { x: 200, y: 165, r: 18, color: '#49d7ff', nextHit: 0, pulse: 0 },
      { x: 280, y: 205, r: 18, color: '#ffd34d', nextHit: 0, pulse: 0 }
    );
    for (var b = 0; b < table.bumpers.length; b++) {
      (function (bumper) {
        bumper.onHit = function () {
          game.addScore(100 * game.multiplier);
          game.audio.bumper();
          game.spark(bumper.x, bumper.y, bumper.color, 7);
        };
      })(table.bumpers[b]);
    }

    /* Small posts in the upper playfield. */
    table.posts.push({ x: 70, y: 252, r: 7 }, { x: 330, y: 252, r: 7 });

    /* Drop-target bank on the left. */
    var targetYs = [296, 330, 364];
    for (var i = 0; i < targetYs.length; i++) {
      var target = {
        x1: 33, x2: 84, y: targetYs[i], active: true, glow: 0
      };
      target.seg = segment(target.x1, target.y, target.x2, target.y, {
        hr: 5, e: 0.45, kind: 'target', target: target
      });
      table.targets.push(target);
    }

    /* Top rollovers spell DEEP. */
    table.rollovers.push(
      { x: 150, y: 94, label: 'D', lit: false, inside: false },
      { x: 200, y: 78, label: 'E', lit: false, inside: false },
      { x: 250, y: 94, label: 'P', lit: false, inside: false }
    );

    /* Star field, generated once from a deterministic seed. */
    var seed = 1337;
    function random() {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    }
    for (var s = 0; s < 74; s++) {
      table.stars.push({
        x: 24 + random() * 352,
        y: 46 + random() * 520,
        r: 0.5 + random() * 1.1,
        phase: random() * Math.PI * 2,
        speed: 0.4 + random() * 0.8
      });
    }

    return table;
  }

  /* ---------------------------------------------------------------- game */

  function Pinball(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('Pinball needs a 2D canvas');

    this.audio = new AudioKit();
    this.el = {
      score: document.getElementById('pbScore'),
      high: document.getElementById('pbHigh'),
      ball: document.getElementById('pbBall'),
      mult: document.getElementById('pbMult'),
      tip: document.getElementById('pbTip'),
      sound: document.getElementById('pbSound'),
      pause: document.getElementById('pbPause')
    };

    this.high = 0;
    try {
      this.high = parseInt(global.localStorage.getItem(HIGH_KEY), 10) || 0;
    } catch (error) {
      this.high = 0;
    }

    this.running = false;
    this.paused = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.accumulator = 0;
    this.time = 0;
    this.keys = { left: false, right: false };
    this.pointerId = null;
    this.table = makeTable(this);

    this.leftFlipper = {
      px: 132, py: 584, len: 60, r: 6.5,
      rest: 0.45, up: -0.55, angle: 0.45, omega: 0
    };
    this.rightFlipper = {
      px: 268, py: 584, len: 60, r: 6.5,
      rest: Math.PI - 0.45, up: Math.PI + 0.55,
      angle: Math.PI - 0.45, omega: 0
    };

    this.ball = { x: 365, y: 624, vx: 0, vy: 0, r: BALL_R };
    this.trail = [];
    this.particles = [];
    this.message = '';
    this.messageUntil = 0;
    this.lastTip = '';
    this.dpr = 1;

    this.newGame();
    this.sizeCanvas();
    this.bindEvents();
    this.draw(global.performance ? global.performance.now() : Date.now());
    this.updateHud();
  }

  Pinball.prototype.newGame = function () {
    this.score = 0;
    this.ballsLeft = 3;
    this.multiplier = 1;
    this.state = 'ready';
    this.charging = false;
    this.charge = 0;
    this.serveTimer = 0;
    this.saucerCaptured = false;
    this.saucerTimer = 0;
    this.extraAwarded = false;
    this.nextExtra = 75000;
    this.tiltWarnings = 0;
    this.lastNudge = -99;
    this.nudgeLock = 0;
    this.slowTime = 0;
    this.bankResetAt = 0;
    this.spinnerTimer = 0;
    this.message = '';
    this.messageUntil = 0;
    this.particles.length = 0;
    this.trail.length = 0;
    this.paused = false;
    this.clearTargets();
    this.resetRollovers();
    this.resetFlippers();
    this.serveBall();
    this.updateHud();
    if (this.running) this.audio.enable();
    if (this.running) {
      this.lastFrame = global.performance.now();
      this.accumulator = 0;
    }
  };

  Pinball.prototype.resetFlippers = function () {
    this.leftFlipper.angle = this.leftFlipper.rest;
    this.leftFlipper.omega = 0;
    this.rightFlipper.angle = this.rightFlipper.rest;
    this.rightFlipper.omega = 0;
  };

  Pinball.prototype.clearTargets = function () {
    for (var i = 0; i < this.table.targets.length; i++) {
      this.table.targets[i].active = true;
      this.table.targets[i].glow = 0;
    }
    this.bankResetAt = 0;
  };

  Pinball.prototype.resetRollovers = function () {
    for (var i = 0; i < this.table.rollovers.length; i++) {
      this.table.rollovers[i].lit = false;
      this.table.rollovers[i].inside = false;
    }
  };

  Pinball.prototype.serveBall = function () {
    this.ball.x = 365;
    this.ball.y = 624;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.trail.length = 0;
    this.state = 'ready';
    this.charging = false;
    this.charge = 0;
    this.serveTimer = 0;
    this.saucerCaptured = false;
    this.slowTime = 0;
    this.ballSaveArmed = true;
    this.ballSaveUntil = 0;
    this.updateHud();
  };

  Pinball.prototype.ballInLane = function () {
    return this.ball.x > 350 && this.ball.y > 300;
  };

  /* ------------------------------------------------------------- controls */

  Pinball.prototype.bindEvents = function () {
    var self = this;

    document.addEventListener('keydown', function (event) {
      if (!self.running || self.paused) return;
      var key = event.key;

      if (key === 'Enter' && self.state === 'gameover') {
        event.preventDefault();
        self.newGame();
        return;
      }

      if (key === 'ArrowLeft' || key === 'a' || key === 'A' || key === 'z' || key === 'Z') {
        event.preventDefault();
        self.setFlipper('left', true);
      } else if (key === 'ArrowRight' || key === 'd' || key === 'D' || key === '/' ||
                 key === 'l' || key === 'L') {
        event.preventDefault();
        self.setFlipper('right', true);
      } else if (key === ' ' || key === 'Spacebar') {
        event.preventDefault();
        self.beginCharge();
      } else if (key === 'n' || key === 'N' || key === 'ArrowDown') {
        event.preventDefault();
        self.nudge();
      }
    });

    document.addEventListener('keyup', function (event) {
      if (!self.running) return;
      var key = event.key;
      if (key === 'ArrowLeft' || key === 'a' || key === 'A' || key === 'z' || key === 'Z') {
        self.setFlipper('left', false);
      } else if (key === 'ArrowRight' || key === 'd' || key === 'D' || key === '/' ||
                 key === 'l' || key === 'L') {
        self.setFlipper('right', false);
      } else if (key === ' ' || key === 'Spacebar') {
        self.releaseCharge();
      }
    });

    this.canvas.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      self.audio.enable();
      self.canvas.focus({ preventScroll: true });

      if (self.paused) {
        self.resume();
        return;
      }

      if (self.state === 'gameover') {
        self.newGame();
        return;
      }

      var rect = self.canvas.getBoundingClientRect();
      var x = (event.clientX - rect.left) / Math.max(1, rect.width);
      self.pointerId = event.pointerId;
      self.setFlipper(x < 0.5 ? 'left' : 'right', true);
      try {
        self.canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
      event.preventDefault();
    });

    function releasePointer(event) {
      if (self.pointerId === null) return;
      self.pointerId = null;
      self.setFlipper('left', false);
      self.setFlipper('right', false);
      if (self.charging) self.releaseCharge();
      try {
        self.canvas.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
    }
    this.canvas.addEventListener('pointerup', releasePointer);
    this.canvas.addEventListener('pointercancel', releasePointer);

    var launch = document.getElementById('pbLaunch');
    if (launch) {
      launch.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        self.audio.enable();
        self.beginCharge();
        try {
          launch.setPointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
      });
      launch.addEventListener('pointerup', function (event) {
        event.preventDefault();
        self.releaseCharge();
      });
      launch.addEventListener('pointercancel', function () {
        self.releaseCharge();
      });
    }

    var newButton = document.getElementById('pbNew');
    if (newButton) {
      newButton.addEventListener('click', function () {
        self.audio.enable();
        self.newGame();
        self.resume();
      });
    }

    if (this.el.pause) {
      this.el.pause.addEventListener('click', function () {
        if (self.paused) self.resume();
        else self.pause();
      });
    }

    if (this.el.sound) {
      this.el.sound.addEventListener('click', function () {
        self.audio.enable();
        self.audio.muted = !self.audio.muted;
        try {
          global.localStorage.setItem(MUTE_KEY, self.audio.muted ? '1' : '0');
        } catch (error) {
          /* ignore */
        }
        self.updateHud();
      });
    }

    global.addEventListener('resize', function () { self.sizeCanvas(); });
    global.addEventListener('beforeunload', function () { self.saveHigh(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && self.running && !self.paused) self.pause();
    });
  };

  Pinball.prototype.setFlipper = function (side, down) {
    if (!this.running || this.paused) return;
    var flipper = side === 'left' ? this.leftFlipper : this.rightFlipper;
    var wasDown = side === 'left' ? this.keys.left : this.keys.right;
    if (down) {
      if (side === 'left') this.keys.left = true;
      else this.keys.right = true;
      if (!wasDown && !this.charging) this.audio.flipper();
    } else {
      if (side === 'left') this.keys.left = false;
      else this.keys.right = false;
    }
  };

  Pinball.prototype.beginCharge = function () {
    if (!this.running || this.paused) return;
    if (this.state === 'gameover') {
      this.newGame();
      return;
    }
    if (this.state === 'ready' ||
        (this.ballInLane() && this.ball.y > 590 && hypot(this.ball.vx, this.ball.vy) < 220)) {
      if (!this.charging) this.audio.flipper();
      this.charging = true;
      this.state = 'ready';
      this.ball.x = 365;
      this.ball.y = 624;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.trail.length = 0;
    }
  };

  Pinball.prototype.releaseCharge = function () {
    if (!this.charging) return;
    this.charging = false;
    if (this.state !== 'ready') return;

    var power = this.charge;
    this.charge = 0;
    this.state = 'playing';
    this.ball.vx = (Math.random() - 0.5) * 26;
    this.ball.vy = -(1230 + 430 * power);
    if (this.ballSaveArmed) {
      this.ballSaveArmed = false;
      this.ballSaveUntil = this.time + 7;
    }
    this.audio.launch();
    this.slowTime = 0;
    this.setMessage('LAUNCH!', 0.7);
    this.updateHud();
  };

  Pinball.prototype.nudge = function () {
    if (!this.running || this.paused || this.state !== 'playing') return;
    if (this.time < this.nudgeLock) return;

    this.nudgeLock = this.time + 0.35;
    this.lastNudge = this.time;
    this.tiltWarnings += 1;
    this.ball.vx += (Math.random() * 2 - 1) * 150;
    this.ball.vy -= 120;
    this.audio.flipper();

    if (this.tiltWarnings >= 4) {
      this.tilt();
    } else if (this.tiltWarnings >= 2) {
      this.setMessage('TILT WARNING', 1.1);
    }
  };

  Pinball.prototype.tilt = function () {
    this.tiltWarnings = 0;
    this.audio.tilt();
    this.setMessage('TILT!', 1.5);
    this.loseBall(true);
  };

  /* --------------------------------------------------------------- engine */

  Pinball.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.audio.enable();
    this.lastFrame = global.performance.now();
    this.accumulator = 0;
    var self = this;
    this.raf = global.requestAnimationFrame(function (time) { self.loop(time); });
    this.updateHud();
  };

  Pinball.prototype.loop = function (time) {
    if (!this.running) return;
    var delta = (time - this.lastFrame) / 1000;
    this.lastFrame = time;
    if (!isFinite(delta) || delta < 0) delta = 0;
    delta = Math.min(delta, 0.06);
    this.accumulator += delta;

    var guard = 0;
    while (this.accumulator >= STEP && guard < 24) {
      this.update(STEP);
      this.accumulator -= STEP;
      guard += 1;
    }
    if (guard >= 24) this.accumulator = 0;

    this.updateHud();
    this.draw(time);
    var self = this;
    this.raf = global.requestAnimationFrame(function (next) { self.loop(next); });
  };

  Pinball.prototype.pause = function () {
    if (!this.running) {
      this.draw(global.performance ? global.performance.now() : Date.now());
      return;
    }
    this.running = false;
    this.paused = true;
    this.charging = false;
    this.keys.left = false;
    this.keys.right = false;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.draw(global.performance ? global.performance.now() : Date.now());
    this.saveHigh();
    this.updateHud();
  };

  Pinball.prototype.resume = function () {
    if (this.running) return;
    if (this.state === 'gameover') {
      this.newGame();
    }
    this.start();
  };

  Pinball.prototype.stop = function () {
    this.running = false;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.charging = false;
    this.keys.left = false;
    this.keys.right = false;
    this.saveHigh();
  };

  Pinball.prototype.update = function (dt) {
    this.time += dt;

    this.updateFlipper(this.leftFlipper, this.keys.left, dt);
    this.updateFlipper(this.rightFlipper, this.keys.right, dt);

    if (this.bankResetAt && this.time >= this.bankResetAt) {
      this.clearTargets();
      this.setMessage('TARGETS RESET', 0.8);
    }
    if (this.spinnerTimer > 0) this.spinnerTimer -= dt;
    this.table.spinner.angle += this.table.spinner.omega * dt;
    this.table.spinner.omega *= 0.985;
    if (Math.abs(this.table.spinner.omega) < 0.2) this.table.spinner.omega = 0;

    for (var p = this.particles.length - 1; p >= 0; p--) {
      var particle = this.particles[p];
      particle.life -= dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 240 * dt;
      if (particle.life <= 0) this.particles.splice(p, 1);
    }

    if (this.messageUntil && this.time > this.messageUntil) {
      this.message = '';
      this.messageUntil = 0;
    }
    if (this.tiltWarnings > 0 && this.time - this.lastNudge > 4.5) {
      this.tiltWarnings = 0;
    }

    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this.serveBall();
    }

    if (this.state === 'ready') {
      if (this.charging) {
        this.charge = Math.min(1, this.charge + dt / 1.05);
        this.ball.y = 624 + this.charge * 4;
      }
      this.ball.x = 365;
      this.ball.vx = 0;
      this.ball.vy = 0;
      return;
    }

    if (this.state === 'gameover') {
      return;
    }

    if (this.saucerCaptured) {
      this.saucerTimer -= dt;
      this.ball.x = this.table.saucer.x;
      this.ball.y = this.table.saucer.y;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.table.saucer.pulse = Math.min(1, this.table.saucer.pulse + dt * 2);
      if (this.saucerTimer <= 0) this.ejectSaucer();
      return;
    }

    if (this.state === 'playing') {
      this.stepBall(dt);
    }
  };

  Pinball.prototype.updateFlipper = function (flipper, active, dt) {
    var previous = flipper.angle;
    var target = active ? flipper.up : flipper.rest;
    flipper.angle = moveToward(flipper.angle, target, 28 * dt);
    flipper.omega = dt > 0 ? (flipper.angle - previous) / dt : 0;
  };

  Pinball.prototype.stepBall = function (dt) {
    var ball = this.ball;
    ball.vy += GRAVITY * dt;
    ball.vx *= 0.9995;
    ball.vy *= 0.9995;

    var speed = hypot(ball.vx, ball.vy);
    if (speed > MAX_SPEED) {
      ball.vx = (ball.vx / speed) * MAX_SPEED;
      ball.vy = (ball.vy / speed) * MAX_SPEED;
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    /* Two resolution passes settle corners and flipper/ball contacts. */
    for (var pass = 0; pass < 2; pass++) {
      this.collideSegments();
      this.collideCircles();
      this.collideFlipper(this.leftFlipper);
      this.collideFlipper(this.rightFlipper);
    }

    speed = hypot(ball.vx, ball.vy);
    if (speed > MAX_SPEED) {
      ball.vx = (ball.vx / speed) * MAX_SPEED;
      ball.vy = (ball.vy / speed) * MAX_SPEED;
    }

    this.checkSensors();

    if (Math.abs(ball.vx) + Math.abs(ball.vy) < 26) {
      this.slowTime += dt;
      if (this.slowTime > 4.5) {
        this.slowTime = 0;
        ball.vx += (Math.random() * 2 - 1) * 180;
        ball.vy -= 160;
        this.setMessage('AUTO NUDGE', 0.8);
      }
    } else {
      this.slowTime = 0;
    }

    if (ball.y > H + 24 || ball.x < -30 || ball.x > W + 30 || ball.y < -80) {
      this.loseBall(false);
      return;
    }

    /* If a weak plunge drops back onto the spring, let the player try again. */
    if (this.ballInLane() && ball.y > 570 && hypot(ball.vx, ball.vy) < 42) {
      this.state = 'ready';
      this.ball.x = 365;
      this.ball.y = 624;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.trail.length = 0;
    }
  };

  Pinball.prototype.collideSegments = function () {
    var ball = this.ball;
    var segments = this.table.segments;

    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (s.target && !s.target.active) continue;

      var abx = s.bx - s.ax;
      var aby = s.by - s.ay;
      var ab2 = abx * abx + aby * aby || 1;
      var apx = ball.x - s.ax;
      var apy = ball.y - s.ay;
      var t = clamp((apx * abx + apy * aby) / ab2, 0, 1);
      var cx = s.ax + abx * t;
      var cy = s.ay + aby * t;
      var dx = ball.x - cx;
      var dy = ball.y - cy;
      var distance = hypot(dx, dy);
      var minimum = ball.r + s.hr;

      if (distance >= minimum) continue;
      if (s.gate && ball.vy < -5) continue;

      var nx;
      var ny;
      if (distance < 0.0001) {
        var length = Math.sqrt(ab2);
        nx = -aby / length;
        ny = abx / length;
        if (ball.vx * nx + ball.vy * ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        distance = 0;
      } else {
        nx = dx / distance;
        ny = dy / distance;
      }

      ball.x += nx * (minimum - distance);
      ball.y += ny * (minimum - distance);

      var vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        var e = s.e;
        ball.vx -= (1 + e) * vn * nx;
        ball.vy -= (1 + e) * vn * ny;

        if (s.kick && this.time >= s.nextHit) {
          s.nextHit = this.time + 0.12;
          ball.vx += nx * s.kick;
          ball.vy += ny * s.kick;
          if (s.onHit) s.onHit();
        } else if (s.target) {
          this.hitTarget(s.target);
        } else if (s.kind === 'wall' && Math.abs(vn) > 320) {
          this.audio.beep(120, 90, 0.03, 'triangle', 0.015);
        }
      }
    }
  };

  Pinball.prototype.collideCircles = function () {
    var ball = this.ball;
    var items = this.table.bumpers.concat(this.table.posts);

    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      var dx = ball.x - c.x;
      var dy = ball.y - c.y;
      var distance = hypot(dx, dy);
      var minimum = ball.r + c.r;
      if (distance >= minimum) continue;

      var nx = distance > 0.001 ? dx / distance : 0;
      var ny = distance > 0.001 ? dy / distance : -1;
      ball.x = c.x + nx * minimum;
      ball.y = c.y + ny * minimum;

      var vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        ball.vx -= 1.85 * vn * nx;
        ball.vy -= 1.85 * vn * ny;
      }

      if (c.onHit && this.time >= c.nextHit) {
        c.nextHit = this.time + 0.1;
        c.pulse = 1;
        ball.vx += nx * 370;
        ball.vy += ny * 370;
        c.onHit();
      }
    }
  };

  Pinball.prototype.collideFlipper = function (f) {
    var ball = this.ball;
    var tipX = f.px + Math.cos(f.angle) * f.len;
    var tipY = f.py + Math.sin(f.angle) * f.len;
    var abx = tipX - f.px;
    var aby = tipY - f.py;
    var ab2 = abx * abx + aby * aby || 1;
    var t = clamp(((ball.x - f.px) * abx + (ball.y - f.py) * aby) / ab2, 0, 1);
    var cx = f.px + abx * t;
    var cy = f.py + aby * t;
    var dx = ball.x - cx;
    var dy = ball.y - cy;
    var distance = hypot(dx, dy);
    var minimum = ball.r + f.r;

    if (distance >= minimum) return;

    var nx;
    var ny;
    if (distance < 0.0001) {
      var length = Math.sqrt(ab2);
      nx = -aby / length;
      ny = abx / length;
      distance = 0;
    } else {
      nx = dx / distance;
      ny = dy / distance;
    }

    ball.x += nx * (minimum - distance);
    ball.y += ny * (minimum - distance);

    var rx = cx - f.px;
    var ry = cy - f.py;
    var surfaceVx = -f.omega * ry;
    var surfaceVy = f.omega * rx;
    var relVx = ball.vx - surfaceVx;
    var relVy = ball.vy - surfaceVy;
    var vn = relVx * nx + relVy * ny;

    if (vn < 0) {
      var e = 0.48;
      relVx -= (1 + e) * vn * nx;
      relVy -= (1 + e) * vn * ny;
      ball.vx = relVx + surfaceVx;
      ball.vy = relVy + surfaceVy;

      if (Math.abs(f.omega) > 9 && Math.random() < 0.5) {
        this.audio.flipper();
      }
    }
  };

  Pinball.prototype.checkSensors = function () {
    var ball = this.ball;
    var i;

    for (i = 0; i < this.table.rollovers.length; i++) {
      var r = this.table.rollovers[i];
      var inside = hypot(ball.x - r.x, ball.y - r.y) < ball.r + 13;
      if (inside && !r.inside) this.hitRollover(r);
      r.inside = inside;
    }

    var spinner = this.table.spinner;
    var spinnerInside = hypot(ball.x - spinner.x, ball.y - spinner.y) < ball.r + spinner.r;
    if (spinnerInside && !spinner.inside && this.spinnerTimer <= 0) {
      spinner.omega = 22;
      this.spinnerTimer = 0.35;
      this.addScore(250 * this.multiplier);
      this.audio.spinner();
      this.spark(spinner.x, spinner.y, '#7fe3ff', 3);
    }
    spinner.inside = spinnerInside;

    var saucer = this.table.saucer;
    var saucerInside = hypot(ball.x - saucer.x, ball.y - saucer.y) < ball.r + saucer.r;
    if (saucerInside && !saucer.inside && !this.saucerCaptured) {
      this.captureSaucer();
    }
    saucer.inside = saucerInside;
  };

  Pinball.prototype.hitRollover = function (rollover) {
    if (rollover.lit) return;
    rollover.lit = true;
    this.addScore(250 * this.multiplier);
    this.audio.rollover();
    this.spark(rollover.x, rollover.y, '#8fe8ff', 4);
    this.setMessage(rollover.label + ' LIT', 0.8);

    var all = true;
    for (var i = 0; i < this.table.rollovers.length; i++) {
      if (!this.table.rollovers[i].lit) all = false;
    }
    if (all) {
      this.multiplier = Math.min(5, this.multiplier + 1);
      this.addScore(2000 * this.multiplier);
      this.audio.saucer();
      this.setMessage('DEEP BONUS — MULTIPLIER x' + this.multiplier, 2.2);
      for (var j = 0; j < this.table.rollovers.length; j++) {
        this.table.rollovers[j].lit = false;
        this.table.rollovers[j].inside = true;
      }
    }
  };

  Pinball.prototype.hitTarget = function (target) {
    if (!target.active) return;
    target.active = false;
    target.glow = 1;
    this.addScore(500 * this.multiplier);
    this.audio.target();
    this.spark((target.x1 + target.x2) / 2, target.y, '#65ffb0', 5);

    var remaining = 0;
    for (var i = 0; i < this.table.targets.length; i++) {
      if (this.table.targets[i].active) remaining += 1;
    }
    if (remaining === 0) {
      this.multiplier = Math.min(5, this.multiplier + 1);
      this.addScore(4000 * this.multiplier);
      this.audio.saucer();
      this.setMessage('BANK CLEARED — MULTIPLIER x' + this.multiplier, 2.2);
      this.bankResetAt = this.time + 2;
    }
  };

  Pinball.prototype.captureSaucer = function () {
    this.saucerCaptured = true;
    this.saucerTimer = 1.35;
    this.table.saucer.pulse = 0;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.trail.length = 0;
    this.addScore(5000 * this.multiplier);
    this.audio.saucer();
    this.spark(this.table.saucer.x, this.table.saucer.y, '#ffdf7a', 10);
    this.setMessage('SAUCER +' + (5000 * this.multiplier), 1.4);
  };

  Pinball.prototype.ejectSaucer = function () {
    this.saucerCaptured = false;
    this.saucerTimer = 0;
    this.ball.x = this.table.saucer.x;
    this.ball.y = this.table.saucer.y - 6;
    this.ball.vx = (Math.random() * 2 - 1) * 110;
    this.ball.vy = -780;
    this.table.saucer.inside = true;
    this.setMessage('SAUCER EJECT', 0.8);
    this.updateHud();
  };

  Pinball.prototype.loseBall = function (tilted) {
    if (this.state === 'draining' || this.state === 'gameover') return;

    this.state = 'draining';
    this.charging = false;
    this.charge = 0;
    this.audio.drain();

    /* Seven seconds of ball save after each launch. */
    if (!tilted && this.time < this.ballSaveUntil) {
      this.ballSaveUntil = 0;
      this.audio.rollover();
      this.setMessage('BALL SAVE', 1.2);
      this.serveTimer = 0.9;
      this.ball.x = 365;
      this.ball.y = 624;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.trail.length = 0;
      this.slowTime = 0;
      return;
    }

    this.ballsLeft -= 1;
    this.spark(this.ball.x, Math.min(this.ball.y, H - 10), '#ff6a4d', 8);
    this.trail.length = 0;
    this.slowTime = 0;

    if (this.ballsLeft <= 0) {
      this.ballsLeft = 0;
      this.state = 'gameover';
      this.charging = false;
      this.ball.x = 365;
      this.ball.y = 624;
      this.ball.vx = 0;
      this.ball.vy = 0;
      if (this.score > this.high) this.high = this.score;
      this.saveHigh();
      this.audio.gameOver();
      this.setMessage(tilted ? 'TILT — GAME OVER' : 'GAME OVER', 0);
      this.updateHud();
      return;
    }

    this.setMessage(tilted ? 'TILT — BALL LOST' : 'BALL LOST', 1.1);
    this.serveTimer = 1.25;
    this.ball.x = 365;
    this.ball.y = 624;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.updateHud();
  };

  /* --------------------------------------------------------------- scoring */

  Pinball.prototype.addScore = function (points) {
    this.score += points;
    if (this.score >= this.nextExtra && !this.extraAwarded) {
      this.extraAwarded = true;
      this.ballsLeft += 1;
      this.audio.extra();
      this.setMessage('EXTRA BALL!', 2);
    }
    if (this.score > this.high) this.high = this.score;
    this.updateHud();
  };

  Pinball.prototype.saveHigh = function () {
    try {
      global.localStorage.setItem(HIGH_KEY, String(this.high));
    } catch (error) {
      /* Private mode or file://; the score still lasts for this session. */
    }
  };

  Pinball.prototype.setMessage = function (text, seconds) {
    this.message = text;
    this.messageUntil = seconds > 0 ? this.time + seconds : 0;
  };

  Pinball.prototype.spark = function (x, y, color, count) {
    for (var i = 0; i < count; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 40 + Math.random() * 150;
      this.particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30,
        life: 0.3 + Math.random() * 0.35,
        maxLife: 0.65,
        color: color,
        radius: 1.2 + Math.random() * 1.6
      });
    }
  };

  Pinball.prototype.updateHud = function () {
    if (this.el.score) this.el.score.textContent = this.score.toLocaleString('en-US');
    if (this.el.high) this.el.high.textContent = this.high.toLocaleString('en-US');
    if (this.el.ball) this.el.ball.textContent = String(this.ballsLeft);
    if (this.el.mult) this.el.mult.textContent = 'x' + this.multiplier;
    if (this.el.sound) this.el.sound.textContent = this.audio.muted ? 'Sound: Off' : 'Sound: On';
    if (this.el.pause) this.el.pause.textContent = this.paused ? 'Resume' : 'Pause';

    var tip;
    if (this.paused) {
      tip = 'Paused — press Resume';
    } else if (this.state === 'gameover') {
      tip = 'Game over — press New Game or Enter';
    } else if (this.state === 'ready') {
      tip = this.charging
        ? 'Charging ' + Math.round(this.charge * 100) + '% — release to launch'
        : 'Hold SPACE or Launch to charge';
    } else if (this.saucerCaptured) {
      tip = 'Saucer bonus…';
    } else {
      tip = '\u2190 / \u2192 flippers · N to nudge';
    }
    if (tip !== this.lastTip) {
      this.lastTip = tip;
      if (this.el.tip) this.el.tip.textContent = tip;
    }
  };

  /* -------------------------------------------------------------- drawing */

  Pinball.prototype.sizeCanvas = function () {
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    if (this.dpr === dpr && this.canvas.width === Math.round(W * dpr)) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(global.performance ? global.performance.now() : Date.now());
  };

  Pinball.prototype.draw = function (now) {
    var ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    this.drawBackground(ctx, now);
    this.drawTable(ctx, now);
    this.drawTargets(ctx, now);
    this.drawBumpers(ctx, now);
    this.drawPosts(ctx);
    this.drawRollovers(ctx, now);
    this.drawSaucer(ctx, now);
    this.drawSpinner(ctx, now);
    this.drawSlingshots(ctx, now);
    this.drawWalls(ctx);
    this.drawPlunger(ctx);
    this.drawTrail(ctx);
    this.drawBall(ctx);
    this.drawFlippers(ctx);
    this.drawParticles(ctx);
    this.drawText(ctx, now);
    this.drawOverlay(ctx);
    ctx.restore();
  };

  Pinball.prototype.drawBackground = function (ctx, now) {
    var background = ctx.createLinearGradient(0, 0, 0, H);
    background.addColorStop(0, '#04060f');
    background.addColorStop(0.45, '#081429');
    background.addColorStop(1, '#05090f');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    var nebula = ctx.createRadialGradient(315, 140, 10, 315, 140, 220);
    nebula.addColorStop(0, 'rgba(46, 120, 200, .22)');
    nebula.addColorStop(0.5, 'rgba(32, 72, 150, .1)');
    nebula.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = nebula;
    ctx.fillRect(0, 0, W, H);

    var nebula2 = ctx.createRadialGradient(70, 430, 5, 70, 430, 190);
    nebula2.addColorStop(0, 'rgba(150, 42, 120, .14)');
    nebula2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = nebula2;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  };

  Pinball.prototype.tablePath = function (ctx) {
    ctx.beginPath();
    ctx.moveTo(18, 636);
    ctx.lineTo(18, 150);
    ctx.arc(130, 150, 112, Math.PI, Math.PI * 1.5);
    ctx.lineTo(270, 38);
    ctx.arc(270, 150, 112, Math.PI * 1.5, Math.PI * 2);
    ctx.lineTo(382, 636);
    ctx.closePath();
  };

  Pinball.prototype.drawTable = function (ctx, now) {
    this.tablePath(ctx);
    var fill = ctx.createLinearGradient(0, 38, 0, H);
    fill.addColorStop(0, '#0e2b4d');
    fill.addColorStop(0.35, '#0a1d36');
    fill.addColorStop(0.75, '#081527');
    fill.addColorStop(1, '#060e19');
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    this.tablePath(ctx);
    ctx.clip();

    /* Launch lane gets a slightly lighter floor. */
    var lane = ctx.createLinearGradient(348, 0, 382, 0);
    lane.addColorStop(0, 'rgba(38, 78, 120, .55)');
    lane.addColorStop(1, 'rgba(16, 36, 62, .35)');
    ctx.fillStyle = lane;
    ctx.fillRect(348, 150, 34, 486);

    /* Faint centre guides, like a printed playfield. */
    ctx.strokeStyle = 'rgba(80, 160, 220, .09)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(200, 150, 62 + i * 18, Math.PI * 0.12, Math.PI * 0.88);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(80, 160, 220, .08)';
    ctx.beginPath();
    ctx.moveTo(200, 120);
    ctx.lineTo(200, 470);
    ctx.stroke();

    /* Stars. */
    for (var s = 0; s < this.table.stars.length; s++) {
      var star = this.table.stars[s];
      var twinkle = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(now / 700 * star.speed + star.phase));
      ctx.globalAlpha = twinkle;
      ctx.fillStyle = s % 5 === 0 ? '#bfe8ff' : '#8fa9c9';
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* Title. */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 17px "Trebuchet MS", "MS Sans Serif", sans-serif';
    ctx.fillStyle = 'rgba(130, 205, 255, .38)';
    ctx.shadowColor = 'rgba(70, 170, 255, .6)';
    ctx.shadowBlur = 12;
    ctx.fillText('D E E P   S P A C E', 200, 126);
    ctx.shadowBlur = 0;
    ctx.font = '700 8px "MS Sans Serif", Tahoma, sans-serif';
    ctx.fillStyle = 'rgba(155, 185, 215, .35)';
    ctx.fillText('3D PINBALL', 200, 141);

    ctx.restore();
  };

  Pinball.prototype.drawWalls = function (ctx) {
    var segments = this.table.segments;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (s.kind === 'target' || s.kind === 'sling') continue;

      if (s.gate) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(96, 205, 255, .5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(s.ax, s.ay);
        ctx.lineTo(s.bx, s.by);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }

      /* Dark outline, then a chrome face with a bright inner edge. */
      ctx.strokeStyle = '#03070d';
      ctx.lineWidth = s.hr * 2 + 4;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();

      ctx.strokeStyle = '#50789c';
      ctx.lineWidth = s.hr * 2;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();

      ctx.strokeStyle = '#9fc8e6';
      ctx.lineWidth = Math.max(1, s.hr * 0.55);
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, .5)';
      ctx.lineWidth = Math.max(0.6, s.hr * 0.2);
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay - s.hr * 0.5);
      ctx.lineTo(s.bx, s.by - s.hr * 0.5);
      ctx.stroke();
    }

    ctx.restore();
  };

  Pinball.prototype.drawSlingshots = function (ctx, now) {
    var slings = this.table.slings;
    for (var i = 0; i < slings.length; i++) {
      var s = slings[i];
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.lineTo(s.cx, s.cy);
      ctx.closePath();

      var gradient = ctx.createLinearGradient(s.ax, s.ay, s.bx, s.by);
      gradient.addColorStop(0, '#1b4c72');
      gradient.addColorStop(1, '#0a2036');
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.strokeStyle = '#7db7dc';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      var glow = 0.55 + 0.25 * Math.sin(now / 260 + i * Math.PI);
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.strokeStyle = 'rgba(255, 200, 90, ' + glow.toFixed(3) + ')';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 245, 200, .8)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  };

  Pinball.prototype.drawBumpers = function (ctx, now) {
    var bumpers = this.table.bumpers;
    for (var i = 0; i < bumpers.length; i++) {
      var b = bumpers[i];
      if (b.pulse > 0) b.pulse = Math.max(0, b.pulse - 0.045);
      var scale = 1 + b.pulse * 0.14;
      var radius = b.r * scale;

      var glow = ctx.createRadialGradient(b.x, b.y, b.r * 0.4, b.x, b.y, b.r * 2.4);
      glow.addColorStop(0, b.color);
      glow.addColorStop(0.35, 'rgba(255, 255, 255, .18)');
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.globalAlpha = 0.5 + b.pulse * 0.4;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
      var body = ctx.createRadialGradient(b.x - 5, b.y - 6, 2, b.x, b.y, radius);
      body.addColorStop(0, '#ffffff');
      body.addColorStop(0.28, b.color);
      body.addColorStop(0.8, '#16222f');
      body.addColorStop(1, '#050a10');
      ctx.fillStyle = body;
      ctx.fill();
      ctx.strokeStyle = '#b9e6ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(b.x, b.y, radius * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, .16)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, Math.PI * 1.1, Math.PI * 1.7);
      ctx.strokeStyle = 'rgba(255, 255, 255, .45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  Pinball.prototype.drawPosts = function (ctx) {
    var posts = this.table.posts;
    for (var i = 0; i < posts.length; i++) {
      var p = posts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#0a1725';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      var gradient = ctx.createRadialGradient(p.x - 2, p.y - 2, 1, p.x, p.y, p.r);
      gradient.addColorStop(0, '#e7f6ff');
      gradient.addColorStop(0.4, '#6c9cc0');
      gradient.addColorStop(1, '#1a3349');
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  };

  Pinball.prototype.drawTargets = function (ctx) {
    var targets = this.table.targets;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.glow > 0) t.glow = Math.max(0, t.glow - 0.03);

      if (t.active) {
        ctx.save();
        ctx.shadowColor = 'rgba(80, 235, 180, .8)';
        ctx.shadowBlur = 8 + t.glow * 10;
        ctx.fillStyle = t.glow > 0 ? '#d8fff0' : '#4fe3a5';
        this.roundRect(ctx, t.x1, t.y - 4, t.x2 - t.x1, 8, 4);
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = '#0b3d2d';
        ctx.lineWidth = 1;
        this.roundRect(ctx, t.x1, t.y - 4, t.x2 - t.x1, 8, 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1a2a32';
        this.roundRect(ctx, t.x1, t.y - 2, t.x2 - t.x1, 4, 2);
        ctx.fill();
        ctx.strokeStyle = '#2d4a50';
        ctx.lineWidth = 1;
        this.roundRect(ctx, t.x1, t.y - 2, t.x2 - t.x1, 4, 2);
        ctx.stroke();
      }
    }
  };

  Pinball.prototype.drawRollovers = function (ctx, now) {
    var rollovers = this.table.rollovers;
    for (var i = 0; i < rollovers.length; i++) {
      var r = rollovers[i];
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, 17, 11, 0, 0, Math.PI * 2);
      ctx.fillStyle = r.lit ? 'rgba(80, 220, 255, .35)' : 'rgba(20, 50, 70, .55)';
      ctx.fill();
      ctx.strokeStyle = r.lit ? '#9feaff' : '#3a6b88';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      if (r.lit) {
        ctx.save();
        ctx.shadowColor = '#70e8ff';
        ctx.shadowBlur = 10 + 4 * Math.sin(now / 140);
        ctx.fillStyle = '#d9f8ff';
      } else {
        ctx.fillStyle = 'rgba(130, 170, 195, .55)';
      }
      ctx.font = '700 9px "MS Sans Serif", Tahoma, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.label, r.x, r.y + 0.5);
      if (r.lit) ctx.restore();
    }
  };

  Pinball.prototype.drawSaucer = function (ctx, now) {
    var s = this.table.saucer;
    if (s.pulse > 0) s.pulse = Math.max(0, s.pulse - 0.02);
    var pulse = this.saucerCaptured ? 1 : s.pulse;

    ctx.save();
    ctx.shadowColor = 'rgba(255, 210, 90, ' + (0.5 + pulse * 0.5) + ')';
    ctx.shadowBlur = 8 + pulse * 18;
    for (var i = 2; i >= 0; i--) {
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.r + i * 5, s.r * 0.75 + i * 3.4, 0, 0, Math.PI * 2);
      ctx.strokeStyle = i === 0
        ? (this.saucerCaptured ? '#fff2b8' : '#c9a73d')
        : 'rgba(150, 190, 220, ' + (0.35 - i * 0.08) + ')';
      ctx.lineWidth = i === 0 ? 2 : 1;
      ctx.stroke();
    }
    ctx.restore();

    ctx.beginPath();
    ctx.ellipse(s.x, s.y, s.r * 0.6, s.r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, .65)';
    ctx.fill();

    if (!this.saucerCaptured) {
      var glow = 0.25 + 0.15 * Math.sin(now / 420);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.r + 8, s.r * 0.9 + 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 200, 70, ' + glow.toFixed(3) + ')';
      ctx.fill();
    }
  };

  Pinball.prototype.drawSpinner = function (ctx, now) {
    var s = this.table.spinner;
    var cos = Math.cos(s.angle);
    var sin = Math.sin(s.angle);

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.strokeStyle = 'rgba(125, 220, 255, .55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(12, 0);
    ctx.stroke();

    ctx.strokeStyle = s.omega > 0.5 ? '#e8fbff' : '#85bfd8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-10 * cos, -10 * sin);
    ctx.lineTo(10 * cos, 10 * sin);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(90, 190, 240, .5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  Pinball.prototype.drawPlunger = function (ctx) {
    var charge = this.state === 'ready' ? this.charge : 0;
    var top = 632 - charge * 4;
    ctx.save();
    ctx.strokeStyle = '#5e7f9b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(365, top);
    ctx.lineTo(365, 630);
    ctx.stroke();

    ctx.strokeStyle = '#d8e9f7';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i = 0; i < 4; i++) {
      var y = 630 - i * 4 + charge * 3;
      ctx.moveTo(359, y);
      ctx.lineTo(371, y - 2);
    }
    ctx.stroke();

    ctx.fillStyle = '#ff5a3c';
    ctx.fillRect(356, 632, 18, 5);
    ctx.strokeStyle = '#2a0803';
    ctx.lineWidth = 1;
    ctx.strokeRect(356.5, 632.5, 17, 4);
    ctx.restore();
  };

  Pinball.prototype.drawTrail = function (ctx) {
    if (this.trail.length === 0) return;
    for (var i = this.trail.length - 1; i >= 0; i--) {
      var point = this.trail[i];
      var alpha = (1 - i / this.trail.length) * 0.2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, BALL_R * (1 - i * 0.05), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(170, 220, 255, ' + alpha.toFixed(3) + ')';
      ctx.fill();
    }
  };

  Pinball.prototype.drawBall = function (ctx) {
    if (this.state === 'gameover') return;
    var b = this.ball;
    if (this.saucerCaptured) return;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(b.x + 2, b.y + 5, BALL_R * 0.95, BALL_R * 0.55, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, .45)';
    ctx.fill();

    var gradient = ctx.createRadialGradient(b.x - 2.5, b.y - 3, 1, b.x, b.y, BALL_R);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.35, '#dbe9f5');
    gradient.addColorStop(0.75, '#8ba3b8');
    gradient.addColorStop(1, '#3e5265');
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, .65)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.restore();

    this.trail.unshift({ x: b.x, y: b.y });
    if (this.trail.length > 7) this.trail.pop();
  };

  Pinball.prototype.drawFlippers = function (ctx) {
    this.drawFlipper(ctx, this.leftFlipper);
    this.drawFlipper(ctx, this.rightFlipper);
  };

  Pinball.prototype.drawFlipper = function (ctx, f) {
    var tipX = f.px + Math.cos(f.angle) * f.len;
    var tipY = f.py + Math.sin(f.angle) * f.len;

    ctx.save();
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#02060b';
    ctx.lineWidth = f.r * 2 + 5;
    ctx.stroke();

    var gradient = ctx.createLinearGradient(f.px, f.py, tipX, tipY);
    gradient.addColorStop(0, '#f2fbff');
    gradient.addColorStop(0.4, '#b6d3e8');
    gradient.addColorStop(0.75, '#6b8aa7');
    gradient.addColorStop(1, '#cfe6f5');
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = f.r * 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(f.px - Math.sin(f.angle) * 2, f.py + Math.cos(f.angle) * 2);
    ctx.lineTo(tipX - Math.sin(f.angle) * 2, tipY + Math.cos(f.angle) * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, .6)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(f.px, f.py, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#20384c';
    ctx.fill();
    ctx.strokeStyle = '#9fc5df';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  };

  Pinball.prototype.drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var particle = this.particles[i];
      var alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Pinball.prototype.drawText = function (ctx, now) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (this.state === 'ready' && !this.charging && !this.saucerCaptured) {
      var pulse = 0.45 + 0.25 * Math.sin(now / 300);
      ctx.font = '700 11px "MS Sans Serif", Tahoma, sans-serif';
      ctx.fillStyle = 'rgba(180, 230, 255, ' + pulse.toFixed(3) + ')';
      ctx.shadowColor = 'rgba(80, 190, 255, .9)';
      ctx.shadowBlur = 8;
      ctx.fillText('HOLD SPACE TO LAUNCH', 200, 470);
      ctx.shadowBlur = 0;
    }

    if (this.message) {
      ctx.font = '700 13px "MS Sans Serif", Tahoma, sans-serif';
      ctx.fillStyle = 'rgba(255, 240, 180, .96)';
      ctx.shadowColor = '#ffb52e';
      ctx.shadowBlur = 10;
      ctx.fillText(this.message, 200, 452);
      ctx.shadowBlur = 0;
    }

    if (this.tiltWarnings > 0) {
      ctx.font = '700 8px "MS Sans Serif", Tahoma, sans-serif';
      for (var i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(184 + i * 10, 480, 3, 0, Math.PI * 2);
        ctx.fillStyle = i < this.tiltWarnings ? '#ff6a4d' : 'rgba(120, 150, 170, .3)';
        ctx.fill();
      }
    }

    ctx.restore();
  };

  Pinball.prototype.drawOverlay = function (ctx) {
    if (this.paused) {
      ctx.fillStyle = 'rgba(2, 6, 12, .62)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 28px "Trebuchet MS", "MS Sans Serif", sans-serif';
      ctx.fillStyle = '#bfe9ff';
      ctx.shadowColor = '#3499dd';
      ctx.shadowBlur = 18;
      ctx.fillText('PAUSED', 200, 300);
      ctx.shadowBlur = 0;
      ctx.font = '11px "MS Sans Serif", Tahoma, sans-serif';
      ctx.fillStyle = 'rgba(190, 220, 240, .8)';
      ctx.fillText('Press Resume or click the table', 200, 332);
      return;
    }

    if (this.state === 'gameover') {
      ctx.fillStyle = 'rgba(2, 6, 12, .7)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.font = '700 31px "Trebuchet MS", "MS Sans Serif", sans-serif';
      ctx.fillStyle = '#ffe6a1';
      ctx.shadowColor = '#ff9f2e';
      ctx.shadowBlur = 20;
      ctx.fillText('GAME OVER', 200, 270);
      ctx.shadowBlur = 0;

      ctx.font = '700 15px "Courier New", monospace';
      ctx.fillStyle = '#ff7a5c';
      ctx.fillText(this.score.toLocaleString('en-US'), 200, 314);

      ctx.font = '10px "MS Sans Serif", Tahoma, sans-serif';
      ctx.fillStyle = 'rgba(200, 225, 240, .8)';
      ctx.fillText('HIGH SCORE  ' + this.high.toLocaleString('en-US'), 200, 338);
      ctx.fillText('Click the table, press Enter, or choose New Game', 200, 370);
    }
  };

  Pinball.prototype.roundRect = function (ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  global.Win95Pinball = Pinball;
})(window);
