/*
 * Textured raycast renderer for the 3D Maze screen saver.
 *
 * The world is a grid of unit cubes. Every frame casts one ray per column and
 * paints textured wall slices, then casts the floor rows. Textures are sampled
 * from the ClassicCraft block atlas: slot 5 is brick, 11 cobblestone and 4
 * stone. The atlas stores three 16x16 faces per block; we use the side face
 * (rows 16..31 of the slot) everywhere.
 */
(function (global) {
  'use strict';

  var ATLAS_URL = 'assets/blocks.png';
  var SLOT_ROWS = 48;
  var SIDE_ROW_OFFSET = 16;

  var SLOTS = {
    brick: 5,
    stone: 4,
    cobble: 11
  };

  var FOV = 70 * Math.PI / 180;
  var FOG_DISTANCE = 22;

  // A maze cell is three world units across and walls are 2.5 units tall, so a
  // corridor feels like a room instead of a one-block tunnel.
  var CELL_SIZE = 3;
  var WALL_HEIGHT = 2.5;

  var MAX_RAY_STEPS = 128;

  // One ClassicCraft tile is repeated this many times across a wall face and
  // over the floor cell, so the bricks read at corridor scale.
  var WALL_REPEAT = 2;
  var FLOOR_REPEAT = 2;

  var QUALITY_HEIGHT = {
    chunky: 200,
    normal: 300,
    sharp: 400
  };

  var WALK_SPEED = {
    slow: 0.95,
    normal: 1.4,
    fast: 1.95
  };

  var RAT_URL = 'assets/rat.png';
  var RAT_FRAME_WIDTH = 40;
  var RAT_FRAME_HEIGHT = 22;
  var RAT_WORLD_HEIGHT = 0.6;

  function readTile(pixels, atlasWidth, slot) {
    var r = new Uint8Array(256);
    var g = new Uint8Array(256);
    var b = new Uint8Array(256);
    var rowStart = slot * SLOT_ROWS + SIDE_ROW_OFFSET;

    for (var y = 0; y < 16; y++) {
      for (var x = 0; x < 16; x++) {
        var source = ((rowStart + y) * atlasWidth + x) * 4;
        var target = y * 16 + x;
        r[target] = pixels[source];
        g[target] = pixels[source + 1];
        b[target] = pixels[source + 2];
      }
    }

    return { r: r, g: g, b: b };
  }

  // The stone tile is very high contrast. Pull it toward its average colour so
  // the floor reads as worn slabs instead of television static.
  function softenTile(tile, keep) {
    var sumR = 0;
    var sumG = 0;
    var sumB = 0;
    var i;

    for (i = 0; i < 256; i++) {
      sumR += tile.r[i];
      sumG += tile.g[i];
      sumB += tile.b[i];
    }

    var avgR = sumR / 256;
    var avgG = sumG / 256;
    var avgB = sumB / 256;

    for (i = 0; i < 256; i++) {
      tile.r[i] = Math.round(avgR + (tile.r[i] - avgR) * keep);
      tile.g[i] = Math.round(avgG + (tile.g[i] - avgG) * keep);
      tile.b[i] = Math.round(avgB + (tile.b[i] - avgB) * keep);
    }
  }

  function loadTextures(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();

      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        var context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);

        var pixels;
        try {
          pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (error) {
          reject(error);
          return;
        }

        var stone = readTile(pixels, canvas.width, SLOTS.stone);
        softenTile(stone, 0.5);

        resolve({
          brick: readTile(pixels, canvas.width, SLOTS.brick),
          stone: stone,
          cobble: readTile(pixels, canvas.width, SLOTS.cobble)
        });
      };

      image.onerror = function () {
        reject(new Error('Could not load ' + url));
      };

      image.src = url;
    });
  }

  function loadRatSheet(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();

      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        var context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);

        var pixels;
        try {
          pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (error) {
          reject(error);
          return;
        }

        resolve({
          data: pixels,
          sheetWidth: canvas.width,
          sheetHeight: canvas.height,
          frameWidth: RAT_FRAME_WIDTH,
          frameHeight: RAT_FRAME_HEIGHT,
          frames: Math.max(1, Math.floor(canvas.width / RAT_FRAME_WIDTH))
        });
      };

      image.onerror = function () {
        reject(new Error('Could not load ' + url));
      };

      image.src = url;
    });
  }

  function Screensaver(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.textures = null;
    this.ratSheet = null;
    this.assetPromise = null;

    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.time = 0;

    this.width = 0;
    this.height = 0;
    this.imageData = null;
    this.framebuffer = null;
    this.zBuffer = null;

    this.settings = null;
    this.maze = null;
    this.walker = null;
    this.rats = [];

    this.viewportWidth = 0;
    this.viewportHeight = 0;

    this._frame = this._frame.bind(this);
  }

  Screensaver.prototype.ready = function () {
    if (this.textures && this.ratSheet) return Promise.resolve();
    if (!this.assetPromise) {
      var self = this;
      this.assetPromise = Promise.all([
        loadTextures(ATLAS_URL),
        loadRatSheet(RAT_URL)
      ]).then(function (assets) {
        self.textures = assets[0];
        self.ratSheet = assets[1];
      }).catch(function (error) {
        self.assetPromise = null;
        throw error;
      });
    }
    return this.assetPromise;
  };

  Screensaver.prototype.start = function (settings) {
    var self = this;

    return this.ready().then(function () {
      var quality = QUALITY_HEIGHT[settings.quality] ? settings.quality : 'normal';
      var speed = WALK_SPEED[settings.speed] || WALK_SPEED.normal;

      self.settings = {
        wallTheme: settings.wallTheme || 'brick',
        quality: quality,
        bob: settings.bob !== false,
        mazeSize: settings.mazeSize || 15
      };

      self.maze = global.Win95Maze.generateMaze(self.settings.mazeSize);
      self.walker = new global.Win95Maze.Walker(self.maze, speed);
      self.rats = self._placeRats();
      self.time = 0;
      self.running = true;

      self.resize(true);
      self.last = performance.now();
      self.raf = global.requestAnimationFrame(self._frame);
    });
  };

  Screensaver.prototype.stop = function () {
    this.running = false;
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.walker = null;
    this.maze = null;
    this.rats = [];
  };

  Screensaver.prototype.resize = function (force) {
    var viewportWidth = global.innerWidth || 800;
    var viewportHeight = global.innerHeight || 600;

    if (!force && viewportWidth === this.viewportWidth && viewportHeight === this.viewportHeight) {
      return;
    }

    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;

    var target = QUALITY_HEIGHT[this.settings.quality] || QUALITY_HEIGHT.normal;
    var width;
    var height;

    // The quality setting is the resolution of the short edge; the other edge
    // follows the viewport so the image never stretches.
    if (viewportWidth >= viewportHeight) {
      height = target;
      width = Math.round(height * viewportWidth / viewportHeight);
    } else {
      width = target;
      height = Math.round(width * viewportHeight / viewportWidth);
    }

    var longest = Math.max(width, height);
    if (longest > 1000) {
      var scale = 1000 / longest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    width = Math.max(160, width);
    height = Math.max(120, height);

    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.imageData = this.context.createImageData(width, height);
    this.framebuffer = new Uint32Array(this.imageData.data.buffer);
    this.zBuffer = new Float32Array(width);
  };

  Screensaver.prototype._frame = function (now) {
    if (!this.running) return;

    var dt = (now - this.last) / 1000;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    this.last = now;
    this.time += dt;

    this.resize(false);
    this.walker.update(dt);
    this.render();
    this.context.putImageData(this.imageData, 0, 0);

    this.raf = global.requestAnimationFrame(this._frame);
  };

  Screensaver.prototype._placeRats = function () {
    var maze = this.maze;
    var walker = this.walker;
    if (!maze || !walker || !maze.deadEnds || !maze.deadEnds.length) return [];

    var deadEnds = [];
    for (var i = 0; i < maze.deadEnds.length; i++) {
      var cell = maze.deadEnds[i];
      if (cell.x === maze.start.x && cell.y === maze.start.y) continue;
      deadEnds.push(cell);
    }
    if (!deadEnds.length) return [];

    var byKey = {};
    for (var d = 0; d < deadEnds.length; d++) {
      byKey[deadEnds[d].x + ',' + deadEnds[d].y] = deadEnds[d];
    }

    // Dead ends the camera will actually walk into, in the order it reaches
    // them. The first one gets a guaranteed rat.
    var pathCells = walker.path.cells;
    var pathKeys = {};
    var visitIndex = {};
    for (var p = 0; p < pathCells.length; p++) {
      var pathKey = pathCells[p].x + ',' + pathCells[p].y;
      pathKeys[pathKey] = true;
      if (byKey[pathKey] && visitIndex[pathKey] === undefined) {
        visitIndex[pathKey] = p;
      }
    }

    var visited = [];
    var adjacent = [];
    for (var e = 0; e < deadEnds.length; e++) {
      var deadEnd = deadEnds[e];
      var deadEndKey = deadEnd.x + ',' + deadEnd.y;
      if (visitIndex[deadEndKey] !== undefined) {
        visited.push({ cell: deadEnd, index: visitIndex[deadEndKey] });
      } else if (pathKeys[deadEnd.open.x + ',' + deadEnd.open.y]) {
        adjacent.push(deadEnd);
      }
    }

    visited.sort(function (a, b) {
      return a.index - b.index;
    });

    var wanted = maze.size <= 11 ? 2 : maze.size <= 15 ? 3 : 4;
    var chosen = [];
    var chosenKeys = {};

    function add(cell) {
      var key = cell.x + ',' + cell.y;
      if (chosenKeys[key] || chosen.length >= wanted) return;
      chosenKeys[key] = true;
      chosen.push(cell);
    }

    // One rat is always on the walked route.
    if (visited.length) add(visited[0].cell);
    else if (adjacent.length) add(adjacent[(Math.random() * adjacent.length) | 0]);

    function shuffle(list) {
      for (var s = list.length - 1; s > 0; s--) {
        var t = (Math.random() * (s + 1)) | 0;
        var tmp = list[s];
        list[s] = list[t];
        list[t] = tmp;
      }
      return list;
    }

    // Fill the remaining dead ends, favouring ones that open onto the route.
    var pool = shuffle(adjacent.slice()).concat(shuffle(deadEnds.slice()));
    for (var q = 0; q < pool.length && chosen.length < wanted; q++) {
      add(pool[q]);
    }

    var rats = [];
    for (var r = 0; r < chosen.length; r++) {
      var spot = chosen[r];
      var centreX = (spot.x + 0.5) * CELL_SIZE;
      var centreY = (spot.y + 0.5) * CELL_SIZE;
      var openX = (spot.open.x + 0.5) * CELL_SIZE;
      var openY = (spot.open.y + 0.5) * CELL_SIZE;
      var awayX = centreX - openX;
      var awayY = centreY - openY;
      var awayLength = Math.sqrt(awayX * awayX + awayY * awayY) || 1;

      rats.push({
        x: centreX + (awayX / awayLength) * 0.75,
        y: centreY + (awayY / awayLength) * 0.75,
        scale: 0.88 + Math.random() * 0.24,
        phase: Math.random() * Math.PI * 2
      });
    }

    return rats;
  };

  Screensaver.prototype._drawFloor = function (dirX, dirY, planeX, planeY, horizon, texture) {
    var width = this.width;
    var height = this.height;
    var framebuffer = this.framebuffer;
    var px = this.walker.x * CELL_SIZE;
    var py = this.walker.y * CELL_SIZE;

    var ray0x = dirX - planeX;
    var ray0y = dirY - planeY;
    var ray1x = dirX + planeX;
    var ray1y = dirY + planeY;

    var sr = texture.r;
    var sg = texture.g;
    var sb = texture.b;

    for (var y = Math.max(0, horizon + 1); y < height; y++) {
      var p = y - horizon;
      var rowDistance = (WALL_HEIGHT * 0.5 * height) / p;
      if (rowDistance >= FOG_DISTANCE) continue;

      var fog = 1 - rowDistance / FOG_DISTANCE;
      var factor = ((0.08 + 0.55 * fog * fog) * 255) | 0;

      var stepX = rowDistance * (ray1x - ray0x) / width;
      var stepY = rowDistance * (ray1y - ray0y) / width;
      var floorX = px + rowDistance * ray0x;
      var floorY = py + rowDistance * ray0y;

      var row = y * width;

      for (var x = 0; x < width; x++) {
        var texX = ((floorX * 16 * FLOOR_REPEAT) | 0) & 15;
        var texY = ((floorY * 16 * FLOOR_REPEAT) | 0) & 15;
        var index = texY * 16 + texX;

        var r = (sr[index] * factor) >> 8;
        var g = (sg[index] * factor) >> 8;
        var b = (sb[index] * factor) >> 8;

        framebuffer[row + x] = 0xff000000 | (b << 16) | (g << 8) | r;

        floorX += stepX;
        floorY += stepY;
      }
    }
  };

  Screensaver.prototype._drawCeiling = function (dirX, dirY, planeX, planeY, horizon, texture) {
    var width = this.width;
    var height = this.height;
    var framebuffer = this.framebuffer;
    var px = this.walker.x * CELL_SIZE;
    var py = this.walker.y * CELL_SIZE;

    var ray0x = dirX - planeX;
    var ray0y = dirY - planeY;
    var ray1x = dirX + planeX;
    var ray1y = dirY + planeY;

    var sr = texture.r;
    var sg = texture.g;
    var sb = texture.b;

    for (var y = 0; y < horizon; y++) {
      var p = horizon - y;
      if (p <= 0) continue;

      var rowDistance = (WALL_HEIGHT * 0.5 * height) / p;
      if (rowDistance >= FOG_DISTANCE) continue;

      var fog = 1 - rowDistance / FOG_DISTANCE;
      var factor = ((0.045 + 0.42 * fog * fog) * 255) | 0;

      var stepX = rowDistance * (ray1x - ray0x) / width;
      var stepY = rowDistance * (ray1y - ray0y) / width;
      var ceilingX = px + rowDistance * ray0x;
      var ceilingY = py + rowDistance * ray0y;

      var row = y * width;

      for (var x = 0; x < width; x++) {
        var texX = ((ceilingX * 16 * FLOOR_REPEAT) | 0) & 15;
        var texY = ((ceilingY * 16 * FLOOR_REPEAT) | 0) & 15;
        var index = texY * 16 + texX;

        var r = (sr[index] * factor) >> 8;
        var g = (sg[index] * factor) >> 8;
        var b = (sb[index] * factor) >> 8;

        framebuffer[row + x] = 0xff000000 | (b << 16) | (g << 8) | r;

        ceilingX += stepX;
        ceilingY += stepY;
      }
    }
  };

  Screensaver.prototype._drawWalls = function (dirX, dirY, planeX, planeY, horizon) {
    var width = this.width;
    var height = this.height;
    var framebuffer = this.framebuffer;
    var maze = this.maze;
    var grid = maze.grid;
    var size = maze.size;
    var textures = this.textures;
    var theme = this.settings.wallTheme;
    var px = this.walker.x * CELL_SIZE;
    var py = this.walker.y * CELL_SIZE;
    var gridX = this.walker.x;
    var gridY = this.walker.y;

    for (var x = 0; x < width; x++) {
      var cameraX = 2 * x / width - 1;
      var rayX = dirX + planeX * cameraX;
      var rayY = dirY + planeY * cameraX;

      // DDA in maze-cell space; t comes back in world units because the ray
      // components are divided by the cell size.
      var rayGridX = rayX / CELL_SIZE;
      var rayGridY = rayY / CELL_SIZE;

      var mapX = Math.floor(gridX);
      var mapY = Math.floor(gridY);

      var deltaX = rayGridX === 0 ? 1e30 : Math.abs(1 / rayGridX);
      var deltaY = rayGridY === 0 ? 1e30 : Math.abs(1 / rayGridY);

      var stepX;
      var stepY;
      var sideDistanceX;
      var sideDistanceY;

      if (rayGridX < 0) {
        stepX = -1;
        sideDistanceX = (gridX - mapX) * deltaX;
      } else {
        stepX = 1;
        sideDistanceX = (mapX + 1 - gridX) * deltaX;
      }

      if (rayGridY < 0) {
        stepY = -1;
        sideDistanceY = (gridY - mapY) * deltaY;
      } else {
        stepY = 1;
        sideDistanceY = (mapY + 1 - gridY) * deltaY;
      }

      var side = 0;
      var hit = false;

      for (var step = 0; step < MAX_RAY_STEPS; step++) {
        if (sideDistanceX < sideDistanceY) {
          sideDistanceX += deltaX;
          mapX += stepX;
          side = 0;
        } else {
          sideDistanceY += deltaY;
          mapY += stepY;
          side = 1;
        }

        if (mapX < 0 || mapY < 0 || mapX >= size || mapY >= size) break;
        if (grid[mapY * size + mapX] === 1) {
          hit = true;
          break;
        }
      }

      if (!hit) continue;

      var perpendicular = side === 0
        ? (mapX - gridX + (1 - stepX) * 0.5) / rayGridX
        : (mapY - gridY + (1 - stepY) * 0.5) / rayGridY;

      if (perpendicular < 0.03) perpendicular = 0.03;
      if (perpendicular > FOG_DISTANCE) continue;

      this.zBuffer[x] = perpendicular;

      var texture = textures.brick;
      if (theme === 'cobble') {
        texture = textures.cobble;
      } else if (theme === 'mixed' && (mapX * 7 + mapY * 13) % 5 === 0) {
        texture = textures.cobble;
      }

      // Texture coordinates run in world units, so the pattern is continuous
      // across the two-unit wall face instead of restarting at the cell edge.
      var hitX = px + perpendicular * rayX;
      var hitY = py + perpendicular * rayY;
      var texX = (((side === 0 ? hitY : hitX) * 16 * WALL_REPEAT) | 0) & 15;

      var lineHeight = height * WALL_HEIGHT / perpendicular;
      var top = horizon - lineHeight * 0.5;
      var bottom = top + lineHeight;

      var yStart = Math.max(0, Math.ceil(top));
      var yEnd = Math.min(height, Math.ceil(bottom));
      if (yEnd <= yStart) continue;

      var fog = 1 - perpendicular / FOG_DISTANCE;
      var sideShade = side === 0 ? 0.76 : 1;
      var factor = ((0.05 + 0.8 * fog * fog) * sideShade * 255) | 0;

      var texStep = 16 * WALL_REPEAT * WALL_HEIGHT / lineHeight;
      var texPosition = (yStart - top) * texStep;

      var tr = texture.r;
      var tg = texture.g;
      var tb = texture.b;

      for (var y = yStart; y < yEnd; y++) {
        var texY = (texPosition | 0) & 15;
        texPosition += texStep;

        var index = texY * 16 + texX;
        var r = (tr[index] * factor) >> 8;
        var g = (tg[index] * factor) >> 8;
        var b = (tb[index] * factor) >> 8;

        framebuffer[y * width + x] = 0xff000000 | (b << 16) | (g << 8) | r;
      }
    }
  };

  Screensaver.prototype._drawRats = function (dirX, dirY, planeX, planeY, horizon) {
    var width = this.width;
    var height = this.height;
    var framebuffer = this.framebuffer;
    var sheet = this.ratSheet;
    var rats = this.rats;

    if (!sheet || !rats.length) return;

    var px = this.walker.x * CELL_SIZE;
    var py = this.walker.y * CELL_SIZE;
    var invDet = 1 / (planeX * dirY - dirX * planeY);
    var visible = [];

    for (var i = 0; i < rats.length; i++) {
      var rat = rats[i];
      var relX = rat.x - px;
      var relY = rat.y - py;
      var transformX = invDet * (dirY * relX - dirX * relY);
      var transformY = invDet * (-planeY * relX + planeX * relY);

      if (transformY > 0.2) {
        visible.push({ rat: rat, tx: transformX, ty: transformY });
      }
    }

    if (!visible.length) return;

    // Paint far sprites first so nearer rats overlap them.
    visible.sort(function (a, b) {
      return b.ty - a.ty;
    });

    var data = sheet.data;
    var sheetWidth = sheet.sheetWidth;

    for (var s = 0; s < visible.length; s++) {
      var sprite = visible[s];
      var ty = sprite.ty;
      if (ty > FOG_DISTANCE) continue;

      var screenX = (width * 0.5) * (1 + sprite.tx / ty);
      var spriteHeight = (RAT_WORLD_HEIGHT * sprite.rat.scale * height) / ty;
      var spriteWidth = spriteHeight * (RAT_FRAME_WIDTH / RAT_FRAME_HEIGHT);
      var bottom = horizon + (WALL_HEIGHT * 0.5 * height) / ty;
      var top = bottom - spriteHeight;
      var left = screenX - spriteWidth * 0.5;

      var xStart = Math.max(0, Math.floor(left));
      var xEnd = Math.min(width, Math.ceil(left + spriteWidth));
      var yStart = Math.max(0, Math.floor(top));
      var yEnd = Math.min(height, Math.ceil(bottom));
      if (xEnd <= xStart || yEnd <= yStart) continue;

      // Tail flick at about 2.5 fps, with the occasional blink.
      var blink = ((this.time + sprite.rat.phase * 2.3) % 6.5) > 6.25;
      var frame = blink ? 2 : Math.floor((this.time + sprite.rat.phase) * 2.6) % 2;
      if (frame >= sheet.frames) frame = 0;
      var frameOffset = frame * RAT_FRAME_WIDTH;

      var fog = 1 - ty / FOG_DISTANCE;
      var factor = ((0.12 + 0.88 * fog * fog) * 255) | 0;

      for (var x = xStart; x < xEnd; x++) {
        if (ty >= this.zBuffer[x]) continue;

        var texX = Math.floor((x - left) * RAT_FRAME_WIDTH / spriteWidth);
        if (texX < 0 || texX >= RAT_FRAME_WIDTH) continue;

        for (var y = yStart; y < yEnd; y++) {
          var texY = Math.floor((y - top) * RAT_FRAME_HEIGHT / spriteHeight);
          if (texY < 0 || texY >= RAT_FRAME_HEIGHT) continue;

          var source = (texY * sheetWidth + frameOffset + texX) * 4;
          if (data[source + 3] < 128) continue;

          var r = (data[source] * factor) >> 8;
          var g = (data[source + 1] * factor) >> 8;
          var b = (data[source + 2] * factor) >> 8;

          framebuffer[y * width + x] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
      }
    }
  };

  Screensaver.prototype.render = function () {
    var width = this.width;
    var height = this.height;
    var framebuffer = this.framebuffer;
    var walker = this.walker;

    framebuffer.fill(0xff000000);
    this.zBuffer.fill(Infinity);

    var dirX = Math.cos(walker.angle);
    var dirY = Math.sin(walker.angle);
    var planeScale = Math.tan(FOV * 0.5);
    var planeX = -dirY * planeScale;
    var planeY = dirX * planeScale;

    var bob = this.settings.bob
      ? Math.sin(walker.distance * Math.PI * 2.1) * height * 0.006
      : 0;
    var horizon = Math.round(height * 0.5 + bob);

    this._drawCeiling(dirX, dirY, planeX, planeY, horizon, this.textures.stone);
    this._drawFloor(dirX, dirY, planeX, planeY, horizon, this.textures.stone);
    this._drawWalls(dirX, dirY, planeX, planeY, horizon);
    this._drawRats(dirX, dirY, planeX, planeY, horizon);
  };

  global.Win95MazeScreensaver = Screensaver;
  global.Win95Maze_QUALITY = QUALITY_HEIGHT;
})(window);
