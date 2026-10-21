/*
 * Maze generation and the wandering path used by the screen saver.
 *
 * The maze is a classic recursive-backtracker grid: odd cells are corridors,
 * even cells are walls. A few walls are knocked out afterwards so the random
 * walk gets loops instead of endless dead ends.
 */
(function (global) {
  'use strict';

  var DIRECTIONS = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 }
  ];

  var CORNER_RADIUS = 0.33;
  var LOOK_AHEAD = 1.0;
  var CORNER_STEPS = 7;

  function generateMaze(requestedSize) {
    var size = Math.max(5, Math.round(requestedSize) || 15);
    if (size % 2 === 0) size += 1;

    var grid = new Uint8Array(size * size);
    grid.fill(1);

    // Carve from (1, 1), two cells at a time.
    var start = { x: 1, y: 1 };
    grid[1 * size + 1] = 0;
    var stack = [start];

    while (stack.length) {
      var current = stack[stack.length - 1];
      var options = [];

      for (var d = 0; d < DIRECTIONS.length; d++) {
        var dir = DIRECTIONS[d];
        var nx = current.x + dir.x * 2;
        var ny = current.y + dir.y * 2;
        if (nx > 0 && ny > 0 && nx < size - 1 && ny < size - 1 &&
            grid[ny * size + nx] === 1) {
          options.push({ x: nx, y: ny, dx: dir.x, dy: dir.y });
        }
      }

      if (!options.length) {
        stack.pop();
        continue;
      }

      var pick = options[(Math.random() * options.length) | 0];
      grid[(current.y + pick.dy) * size + (current.x + pick.dx)] = 0;
      grid[pick.y * size + pick.x] = 0;
      stack.push({ x: pick.x, y: pick.y });
    }

    // Punch a few loops. Exactly one of the two tests below is true for a
    // removable wall between two parallel corridors.
    for (var y = 1; y < size - 1; y++) {
      for (var x = 1; x < size - 1; x++) {
        if (grid[y * size + x] === 0) continue;
        var horizontal = grid[y * size + x - 1] === 0 && grid[y * size + x + 1] === 0;
        var vertical = grid[(y - 1) * size + x] === 0 && grid[(y + 1) * size + x] === 0;
        if (horizontal !== vertical && Math.random() < 0.085) {
          grid[y * size + x] = 0;
        }
      }
    }

    // Dead ends are where the rats live.
    var deadEnds = [];
    for (var ey = 1; ey < size - 1; ey++) {
      for (var ex = 1; ex < size - 1; ex++) {
        if (grid[ey * size + ex] !== 0) continue;
        var exits = openNeighbours({ grid: grid, size: size }, { x: ex, y: ey });
        if (exits.length === 1) {
          deadEnds.push({ x: ex, y: ey, open: exits[0] });
        }
      }
    }

    return {
      grid: grid,
      size: size,
      start: start,
      deadEnds: deadEnds
    };
  }

  function openNeighbours(maze, cell) {
    var out = [];
    var grid = maze.grid;
    var size = maze.size;

    for (var i = 0; i < DIRECTIONS.length; i++) {
      var dir = DIRECTIONS[i];
      var x = cell.x + dir.x;
      var y = cell.y + dir.y;
      if (x > 0 && y > 0 && x < size - 1 && y < size - 1 &&
          grid[y * size + x] === 0) {
        out.push({ x: x, y: y });
      }
    }

    return out;
  }

  function centre(cell) {
    return { x: cell.x + 0.5, y: cell.y + 0.5 };
  }

  /*
   * A long random walk through the maze, rounded into a smooth polyline.
   * Distances are in maze cells; the camera follows this path at a constant
   * speed, so corners are arcs rather than sudden 90 degree snaps.
   */
  function SmoothPath(maze) {
    this.maze = maze;
    this.cells = [{ x: maze.start.x, y: maze.start.y }];
    this.points = [centre(maze.start)];
    this.cum = [0];
    this._extend(140);
  }

  SmoothPath.prototype.length = function () {
    return this.cum[this.cum.length - 1];
  };

  SmoothPath.prototype._push = function (x, y) {
    var last = this.points[this.points.length - 1];
    var dx = x - last.x;
    var dy = y - last.y;
    if (dx * dx + dy * dy < 1e-10) return;

    this.points.push({ x: x, y: y });
    this.cum.push(this.cum[this.cum.length - 1] + Math.sqrt(dx * dx + dy * dy));
  };

  SmoothPath.prototype._addCorner = function (a, b, c) {
    var inLength = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
    var outLength = Math.sqrt((c.x - b.x) * (c.x - b.x) + (c.y - b.y) * (c.y - b.y));
    if (inLength < 1e-6 || outLength < 1e-6) return;

    var radius = Math.min(CORNER_RADIUS, inLength * 0.45, outLength * 0.45);
    var inX = (b.x - a.x) / inLength;
    var inY = (b.y - a.y) / inLength;
    var outX = (c.x - b.x) / outLength;
    var outY = (c.y - b.y) / outLength;

    var p0x = b.x - inX * radius;
    var p0y = b.y - inY * radius;
    var p2x = b.x + outX * radius;
    var p2y = b.y + outY * radius;

    this._push(p0x, p0y);
    for (var i = 1; i <= CORNER_STEPS; i++) {
      var t = i / CORNER_STEPS;
      var mt = 1 - t;
      this._push(
        mt * mt * p0x + 2 * mt * t * b.x + t * t * p2x,
        mt * mt * p0y + 2 * mt * t * b.y + t * t * p2y
      );
    }
  };

  SmoothPath.prototype._chooseNext = function (previous, last) {
    var options = openNeighbours(this.maze, last).filter(function (cell) {
      return !previous || cell.x !== previous.x || cell.y !== previous.y;
    });

    if (!options.length) {
      var back = openNeighbours(this.maze, last)[0];
      return back ? { x: back.x, y: back.y } : { x: last.x, y: last.y };
    }

    var weights = [];
    var total = 0;

    for (var i = 0; i < options.length; i++) {
      var cell = options[i];
      var weight = 1;

      if (previous) {
        var sameDirection = cell.x - last.x === last.x - previous.x &&
                            cell.y - last.y === last.y - previous.y;
        if (sameDirection) {
          weight = 5.5;
        } else if (openNeighbours(this.maze, cell).length <= 1) {
          weight = 0.05;
        }
      }

      weights.push(weight);
      total += weight;
    }

    var roll = Math.random() * total;
    for (var j = 0; j < options.length; j++) {
      roll -= weights[j];
      if (roll <= 0) return { x: options[j].x, y: options[j].y };
    }

    return options[options.length - 1];
  };

  SmoothPath.prototype._extend = function (count) {
    for (var i = 0; i < count; i++) {
      var cells = this.cells;
      var last = cells[cells.length - 1];
      var previous = cells.length > 1 ? cells[cells.length - 2] : null;
      var next = this._chooseNext(previous, last);
      cells.push(next);

      var n = cells.length;
      if (n >= 3) {
        this._addCorner(centre(cells[n - 3]), centre(cells[n - 2]), centre(cells[n - 1]));
      }
    }
  };

  SmoothPath.prototype.ensureAhead = function (distance, ahead) {
    var guard = 0;
    while (this.length() - distance < ahead && guard < 50) {
      this._extend(100);
      guard++;
    }
  };

  SmoothPath.prototype.pointAt = function (distance) {
    var count = this.points.length;
    if (count === 1) return { x: this.points[0].x, y: this.points[0].y };

    var s = Math.max(0, Math.min(distance, this.length()));

    var lo = 0;
    var hi = count - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }

    var segment = this.cum[lo + 1] - this.cum[lo];
    var t = segment > 1e-9 ? (s - this.cum[lo]) / segment : 0;
    var a = this.points[lo];
    var b = this.points[lo + 1];

    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t
    };
  };

  function angleTowards(current, target, response, dt) {
    var delta = target - current;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    return current + delta * (1 - Math.exp(-response * dt));
  }

  function Walker(maze, speed) {
    this.path = new SmoothPath(maze);
    this.distance = 0;
    this.speed = speed;
    this.time = 0;

    var start = this.path.pointAt(0);
    var ahead = this.path.pointAt(LOOK_AHEAD);
    this.x = start.x;
    this.y = start.y;
    this.angle = Math.atan2(ahead.y - start.y, ahead.x - start.x);
  }

  Walker.prototype.update = function (dt) {
    this.time += dt;

    // Ease off the gas when the corridor bends, so the camera turns into the
    // new hallway instead of scraping past the corner brickwork.
    var aheadNow = this.path.pointAt(this.distance + LOOK_AHEAD);
    var current = this.path.pointAt(this.distance);
    var targetNow = Math.atan2(aheadNow.y - current.y, aheadNow.x - current.x);
    var delta = Math.atan2(Math.sin(targetNow - this.angle), Math.cos(targetNow - this.angle));
    var speedScale = 1 - Math.min(0.65, Math.abs(delta) * 0.9);

    this.distance += this.speed * dt * speedScale;
    this.path.ensureAhead(this.distance, 4);

    var position = this.path.pointAt(this.distance);
    var lookAhead = this.path.pointAt(this.distance + LOOK_AHEAD);
    var target = Math.atan2(lookAhead.y - position.y, lookAhead.x - position.x);

    this.angle = angleTowards(this.angle, target, 12, dt);
    this.x = position.x;
    this.y = position.y;
  };

  global.Win95Maze = {
    generateMaze: generateMaze,
    SmoothPath: SmoothPath,
    Walker: Walker
  };
})(window);
