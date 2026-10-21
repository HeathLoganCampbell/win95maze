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

  function Screensaver(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.textures = null;
    this.texturePromise = null;

    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.time = 0;

    this.width = 0;
    this.height = 0;
    this.imageData = null;
    this.framebuffer = null;

    this.settings = null;
    this.maze = null;
    this.walker = null;

    this.viewportWidth = 0;
    this.viewportHeight = 0;

    this._frame = this._frame.bind(this);
  }

  Screensaver.prototype.ready = function () {
    if (this.textures) return Promise.resolve();
    if (!this.texturePromise) {
      var self = this;
      this.texturePromise = loadTextures(ATLAS_URL).then(function (textures) {
        self.textures = textures;
      }).catch(function (error) {
        self.texturePromise = null;
        throw error;
      });
    }
    return this.texturePromise;
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

  Screensaver.prototype.render = function () {
    var width = this.width;
    var height = this.height;
    var framebuffer = this.framebuffer;
    var walker = this.walker;

    framebuffer.fill(0xff000000);

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
  };

  global.Win95MazeScreensaver = Screensaver;
  global.Win95Maze_QUALITY = QUALITY_HEIGHT;
})(window);
