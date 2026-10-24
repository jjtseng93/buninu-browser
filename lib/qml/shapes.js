// Solid QML paths keep the existing SVG DOM path. A gradient path uses a normal
// page canvas because this browser's inline-SVG painter has no gradient support.
// No image encoding, readback or extra CanvasKit instance is involved.
export function createQmlShapes(api) {
  const { elements, parents, owners, children, cssColor } = api;
  const roots = new WeakMap(),
    canvases = new WeakMap();
  function multiline(paths) {
    return (paths || []).map(points => points.map((p,i) => {
      const x = Number(p.x ?? p[0]), y = Number(p.y ?? p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw Error('Invalid PathMultiline point');
      return `${i ? 'L' : 'M'}${x} ${y}`;
    }).join(' ')).join(' ');
  }
  function path(ctx, source) {
    const tokens =
      String(source).match(
        /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g,
      ) || [];
    let i = 0,
      x = 0,
      y = 0,
      sx = 0,
      sy = 0,
      cx = 0,
      cy = 0,
      previous = '',
      command = '';
    const number = () => {
      const n = Number(tokens[i++]);
      if (!Number.isFinite(n)) throw Error('Invalid QML SVG path');
      return n;
    };
    const point = (relative) => {
      const a = number(),
        b = number();
      return [a + (relative ? x : 0), b + (relative ? y : 0)];
    };
    while (i < tokens.length) {
      if (/^[a-zA-Z]$/.test(tokens[i])) command = tokens[i++];
      if (!command) throw Error('Missing SVG path command');
      const relative = command === command.toLowerCase(),
        kind = command.toUpperCase();
      if (kind === 'Z') {
        ctx.closePath();
        x = sx;
        y = sy;
        previous = kind;
        command = '';
        continue;
      }
      if (kind === 'M' || kind === 'L' || kind === 'T') {
        const [nx, ny] = point(relative);
        if (kind === 'M') {
          ctx.moveTo(nx, ny);
          sx = nx;
          sy = ny;
          command = relative ? 'l' : 'L';
        } else if (kind === 'T') {
          const a = ['Q', 'T'].includes(previous) ? 2 * x - cx : x,
            b = ['Q', 'T'].includes(previous) ? 2 * y - cy : y;
          ctx.quadraticCurveTo(a, b, nx, ny);
          cx = a;
          cy = b;
        } else ctx.lineTo(nx, ny);
        x = nx;
        y = ny;
      } else if (kind === 'H') {
        x = number() + (relative ? x : 0);
        ctx.lineTo(x, y);
      } else if (kind === 'V') {
        y = number() + (relative ? y : 0);
        ctx.lineTo(x, y);
      } else if (kind === 'C') {
        const a = point(relative),
          b = point(relative),
          end = point(relative);
        ctx.bezierCurveTo(...a, ...b, ...end);
        [cx, cy] = b;
        [x, y] = end;
      } else if (kind === 'S') {
        const a = ['C', 'S'].includes(previous)
            ? [2 * x - cx, 2 * y - cy]
            : [x, y],
          b = point(relative),
          end = point(relative);
        ctx.bezierCurveTo(...a, ...b, ...end);
        [cx, cy] = b;
        [x, y] = end;
      } else if (kind === 'Q') {
        const a = point(relative),
          end = point(relative);
        ctx.quadraticCurveTo(...a, ...end);
        [cx, cy] = a;
        [x, y] = end;
      } else if (kind === 'A') {
        let rx = Math.abs(number()),
          ry = Math.abs(number());
        const phi = (number() * Math.PI) / 180,
          large = number() !== 0,
          sweep = number() !== 0,
          [nx, ny] = point(relative);
        if (!rx || !ry) ctx.lineTo(nx, ny);
        else if (x !== nx || y !== ny) {
          const cos = Math.cos(phi),
            sin = Math.sin(phi),
            dx = (x - nx) / 2,
            dy = (y - ny) / 2,
            px = cos * dx + sin * dy,
            py = -sin * dx + cos * dy;
          const scale = (px * px) / (rx * rx) + (py * py) / (ry * ry);
          if (scale > 1) {
            rx *= Math.sqrt(scale);
            ry *= Math.sqrt(scale);
          }
          const numerator = Math.max(
              0,
              rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px,
            ),
            denominator = rx * rx * py * py + ry * ry * px * px;
          const factor =
              (large === sweep ? -1 : 1) * Math.sqrt(numerator / denominator),
            ax = (factor * rx * py) / ry,
            ay = (-factor * ry * px) / rx;
          const centerX = cos * ax - sin * ay + (x + nx) / 2,
            centerY = sin * ax + cos * ay + (y + ny) / 2;
          const start = Math.atan2((py - ay) / ry, (px - ax) / rx),
            end = Math.atan2((-py - ay) / ry, (-px - ax) / rx);
          ctx.ellipse(centerX, centerY, rx, ry, phi, start, end, !sweep);
        }
        x = nx;
        y = ny;
      } else throw Error('Unsupported QML SVG command: ' + command);
      previous = kind;
    }
  }
  function make(v, type, element, parent) {
    if (type === 'Shape') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
      while (element.firstChild) svg.appendChild(element.firstChild);
      element.appendChild(svg);
      roots.set(v, svg);
    } else if (type === 'ShapePath' && roots.has(parent))
      roots.get(parent).appendChild(element);
  }
  function paint(v, type) {
    if (type === 'Shape') {
      const svg = roots.get(v);
      svg.setAttribute('width', String(v.width));
      svg.setAttribute('height', String(v.height));
      svg.setAttribute(
        'viewBox',
        '0 0 ' + (v.width || 1) + ' ' + (v.height || 1),
      );
    }
    if (type !== 'ShapePath') return;
    const element = elements.get(v),
      root = parents.get(v),
      gradient = v.fillGradient,
      fillItem = v.fillItem;
    if (!gradient && !fillItem) {
      const old = canvases.get(v);
      if (old) old.style.display = 'none';
      return;
    }
    if (gradient && owners.get(gradient)?.type !== 'LinearGradient')
      throw Error('Unsupported QML shape gradient');
    const host = elements.get(root);
    let canvas = canvases.get(v);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('data-qml-gradient', '');
      canvas.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none';
      host.appendChild(canvas);
      canvases.set(v, canvas);
      api.cleanup(() => {
        canvas.width = 1;
        canvas.height = 1;
        canvas.remove();
      });
    }
    canvas.style.display = 'block';
    element.style.display = 'none';
    const width = Math.max(1, Math.ceil(root.width)),
      height = Math.max(1, Math.ceil(root.height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = root.width + 'px';
    canvas.style.height = root.height + 'px';
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.beginPath();
    for (const child of children(v)) {
      const type = owners.get(child)?.type;
      if (type === 'PathSvg') path(context, child.path);
      else if (type === 'PathMultiline') path(context, multiline(child.paths));
      else if (type === 'PathRectangle') {
        const radii = [
          'topLeftRadius',
          'topRightRadius',
          'bottomRightRadius',
          'bottomLeftRadius',
        ].map((key) => child[key] ?? child.radius ?? 0);
        // CanvasKit's 2D shim lacks roundRect; build the same path with arcTo.
        const x = child.x, y = child.y, w = child.width, h = child.height;
        const r = radii.map(value => Math.max(0, Number(value) || 0));
        const factor = Math.min(1, w / (r[0] + r[1] || 1), w / (r[2] + r[3] || 1),
          h / (r[0] + r[3] || 1), h / (r[1] + r[2] || 1));
        for (let i = 0; i < 4; i++) r[i] *= Math.max(0, factor);
        context.moveTo(x + r[0], y);
        context.lineTo(x + w - r[1], y);context.arcTo(x + w, y, x + w, y + r[1], r[1]);
        context.lineTo(x + w, y + h - r[2]);context.arcTo(x + w, y + h, x + w - r[2], y + h, r[2]);
        context.lineTo(x + r[3], y + h);context.arcTo(x, y + h, x, y + h - r[3], r[3]);
        context.lineTo(x, y + r[0]);context.arcTo(x, y, x + r[0], y, r[0]);
        context.closePath();
      }
    }
    if (fillItem) {
      const bitmap = api.texture(fillItem);
      if (bitmap) {
        context.save();
        context.clip(v.fillRule === 0 ? 'evenodd' : 'nonzero');
        context.drawImage(bitmap, 0, 0, width, height);
        context.restore();
      }
    } else {
      const fill = context.createLinearGradient(gradient.x1, gradient.y1, gradient.x2, gradient.y2);
      for (const stop of children(gradient))
        fill.addColorStop(Math.max(0, Math.min(1, stop.position)), cssColor(stop.color));
      context.fillStyle = fill;
      context.fill(v.fillRule === 0 ? 'evenodd' : 'nonzero');
    }
    if (v.strokeWidth > 0) {
      context.strokeStyle = cssColor(v.strokeColor);
      context.lineWidth = v.strokeWidth;
      context.lineCap =
        v.capStyle === 32 ? 'round' : v.capStyle === 16 ? 'square' : 'butt';
      context.lineJoin =
        v.joinStyle === 128 ? 'round' : v.joinStyle === 64 ? 'bevel' : 'miter';
      context.setLineDash(
        v.strokeStyle === 2 ? v.dashPattern.map((n) => n * v.strokeWidth) : [],
      );
      context.lineDashOffset = v.dashOffset * v.strokeWidth;
      context.stroke();
    }
  }
  return { make, paint, multiline };
}
