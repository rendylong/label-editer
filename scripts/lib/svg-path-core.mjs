const MAX_PATH_LENGTH = 131072;
const MAX_COMMANDS = 4096;
const MAX_SAFE_GEOMETRY_MAGNITUDE = 1e12;
const MAX_SAFE_DERIVED_MAGNITUDE = MAX_SAFE_GEOMETRY_MAGNITUDE * 4;
const SOURCE_PATH = /* @__PURE__ */ Symbol("sourcePath");
const NUMBER_PATTERN = /^[+-]?(?:(?:\d+\.?(?:\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/;
const COMMAND_PARAMETERS = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7 };
function pathError(message) {
  return new Error(`Invalid SVG path: ${message}`);
}
function assertSafeNumber(value, label, maximum = MAX_SAFE_GEOMETRY_MAGNITUDE) {
  if (!Number.isFinite(value) || Math.abs(value) > maximum) throw pathError(`${label} exceeds the safe geometry range`);
  return value;
}
function assertSafePoint(point, label, maximum = MAX_SAFE_DERIVED_MAGNITUDE) {
  assertSafeNumber(point.x, `${label} x`, maximum);
  assertSafeNumber(point.y, `${label} y`, maximum);
  return point;
}
function tokenize(source) {
  if (source.length > MAX_PATH_LENGTH) throw pathError(`input exceeds ${MAX_PATH_LENGTH} characters`);
  if (source.trim() === "") throw pathError("input is empty");
  if (/[<>&]/.test(source) || /(?:javascript|script|url)\s*[:(]/i.test(source)) throw pathError("active or embedded syntax is not allowed");
  if (/^\s*,/.test(source) || /[,]\s*[,]/.test(source) || /[,]\s*$/.test(source) || /[A-Za-z]\s*,/.test(source) || /[,]\s*[A-Za-z]/.test(source)) throw pathError("malformed comma separator");
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character) || character === ",") {
      index += 1;
      continue;
    }
    if (/[A-Za-z]/.test(character)) {
      tokens.push({ type: "command", value: character });
      index += 1;
      continue;
    }
    const match = NUMBER_PATTERN.exec(source.slice(index));
    if (!match) throw pathError(`unexpected token at offset ${index}`);
    const value = Number(match[0]);
    assertSafeNumber(value, "number");
    tokens.push({ type: "number", value, raw: match[0] });
    index += match[0].length;
  }
  return tokens;
}
function numberAt(tokens, index, command) {
  const token = tokens[index];
  if (!token || token.type !== "number") throw pathError(`${command} has incomplete parameters`);
  return token;
}
function attachSource(commands, source) {
  commands.forEach(Object.freeze);
  Object.defineProperty(commands, SOURCE_PATH, { value: source, enumerable: false, configurable: false, writable: false });
  return Object.freeze(commands);
}
function parseNormalizedSvgPath(source) {
  if (typeof source !== "string") throw pathError("path data must be a string");
  const tokens = tokenize(source);
  const commands = [];
  let index = 0;
  let activeCommand;
  let currentX = 0;
  let currentY = 0;
  let subpathX = 0;
  let subpathY = 0;
  const emit = (command) => {
    if (commands.length >= MAX_COMMANDS) throw pathError(`path emits more than ${MAX_COMMANDS} commands`);
    for (const value of Object.values(command)) {
      if (typeof value === "number") assertSafeNumber(value, `${command.kind} coordinate`);
    }
    commands.push(command);
  };
  while (index < tokens.length) {
    if (tokens[index].type === "command") {
      activeCommand = tokens[index].value;
      index += 1;
      if (!/[MLHVCAQZmlhvcaqz]/.test(activeCommand)) throw pathError(`unsupported command ${activeCommand}`);
      if (activeCommand === "Z" || activeCommand === "z") {
        if (commands.length === 0) throw pathError("path must begin with M or m");
        emit({ kind: "close" });
        currentX = subpathX;
        currentY = subpathY;
        activeCommand = void 0;
        continue;
      }
    }
    if (!activeCommand) throw pathError("parameters require a preceding command");
    if (commands.length === 0 && activeCommand !== "M" && activeCommand !== "m") throw pathError("path must begin with M or m");
    const upper = activeCommand.toUpperCase();
    const parameterCount = COMMAND_PARAMETERS[upper];
    const relative = activeCommand === activeCommand.toLowerCase();
    let emittedForCommand = 0;
    while (index < tokens.length && tokens[index].type !== "command") {
      if (tokens.length - index < parameterCount) throw pathError(`${activeCommand} has incomplete parameters`);
      const values = Array.from({ length: parameterCount }, (_, offset) => numberAt(tokens, index + offset, activeCommand));
      index += parameterCount;
      const x = (value) => relative ? currentX + value : value;
      const y = (value) => relative ? currentY + value : value;
      switch (upper) {
        case "M": {
          const nextX = x(values[0].value);
          const nextY = y(values[1].value);
          if (emittedForCommand === 0) {
            emit({ kind: "moveTo", x: nextX, y: nextY });
            subpathX = nextX;
            subpathY = nextY;
          } else emit({ kind: "lineTo", x: nextX, y: nextY });
          currentX = nextX;
          currentY = nextY;
          break;
        }
        case "L": {
          currentX = x(values[0].value);
          currentY = y(values[1].value);
          emit({ kind: "lineTo", x: currentX, y: currentY });
          break;
        }
        case "H": {
          currentX = x(values[0].value);
          emit({ kind: "lineTo", x: currentX, y: currentY });
          break;
        }
        case "V": {
          currentY = y(values[0].value);
          emit({ kind: "lineTo", x: currentX, y: currentY });
          break;
        }
        case "C": {
          const command = {
            kind: "cubicTo",
            cp1x: x(values[0].value),
            cp1y: y(values[1].value),
            cp2x: x(values[2].value),
            cp2y: y(values[3].value),
            x: x(values[4].value),
            y: y(values[5].value)
          };
          emit(command);
          currentX = command.x;
          currentY = command.y;
          break;
        }
        case "Q": {
          const command = {
            kind: "quadraticTo",
            cpx: x(values[0].value),
            cpy: y(values[1].value),
            x: x(values[2].value),
            y: y(values[3].value)
          };
          emit(command);
          currentX = command.x;
          currentY = command.y;
          break;
        }
        case "A": {
          const [rx, ry, rotation, largeArc, sweep, endpointX, endpointY] = values;
          if (!(rx.value > 0) || !(ry.value > 0)) throw pathError("arc radii must be positive");
          if (largeArc.raw !== "0" && largeArc.raw !== "1" || sweep.raw !== "0" && sweep.raw !== "1") throw pathError("arc flags must be 0 or 1");
          const command = {
            kind: "arcTo",
            rx: rx.value,
            ry: ry.value,
            rotation: rotation.value,
            largeArc: largeArc.value === 1,
            sweep: sweep.value === 1,
            x: x(endpointX.value),
            y: y(endpointY.value)
          };
          emit(command);
          currentX = command.x;
          currentY = command.y;
          break;
        }
      }
      emittedForCommand += 1;
      if (upper === "M") activeCommand = relative ? "l" : "L";
    }
    if (emittedForCommand === 0) throw pathError(`${activeCommand} requires parameters`);
  }
  if (commands.length === 0 || commands[0].kind !== "moveTo") throw pathError("path must begin with M or m");
  return attachSource(commands, source);
}
function numberText(value) {
  assertSafeNumber(value, "command number");
  return Object.is(value, -0) ? "0" : String(value);
}
function serializeNormalizedSvgPath(commands) {
  const source = commands[SOURCE_PATH];
  if (source !== void 0) return source;
  return commands.map((command) => {
    switch (command.kind) {
      case "moveTo":
        return `M ${numberText(command.x)} ${numberText(command.y)}`;
      case "lineTo":
        return `L ${numberText(command.x)} ${numberText(command.y)}`;
      case "cubicTo":
        return `C ${numberText(command.cp1x)} ${numberText(command.cp1y)} ${numberText(command.cp2x)} ${numberText(command.cp2y)} ${numberText(command.x)} ${numberText(command.y)}`;
      case "quadraticTo":
        return `Q ${numberText(command.cpx)} ${numberText(command.cpy)} ${numberText(command.x)} ${numberText(command.y)}`;
      case "arcTo":
        return `A ${numberText(command.rx)} ${numberText(command.ry)} ${numberText(command.rotation)} ${command.largeArc ? 1 : 0} ${command.sweep ? 1 : 0} ${numberText(command.x)} ${numberText(command.y)}`;
      case "close":
        return "Z";
    }
  }).join(" ");
}
function vectorAngle(ux, uy, vx, vy) {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}
function arcCenter(start, command) {
  assertSafePoint(start, "arc start");
  if (start.x === command.x && start.y === command.y) throw pathError("arc endpoints must differ");
  const phi = command.rotation % 360 * Math.PI / 180;
  const cosine = Math.cos(phi);
  const sine = Math.sin(phi);
  const dx = (start.x - command.x) / 2;
  const dy = (start.y - command.y) / 2;
  const transformedX = cosine * dx + sine * dy;
  const transformedY = -sine * dx + cosine * dy;
  let rx = command.rx;
  let ry = command.ry;
  const radiiScale = transformedX ** 2 / rx ** 2 + transformedY ** 2 / ry ** 2;
  if (radiiScale > 1) {
    const scale = Math.sqrt(radiiScale);
    rx *= scale;
    ry *= scale;
  }
  const numerator = Math.max(0, rx ** 2 * ry ** 2 - rx ** 2 * transformedY ** 2 - ry ** 2 * transformedX ** 2);
  const denominator = rx ** 2 * transformedY ** 2 + ry ** 2 * transformedX ** 2;
  const coefficient = (command.largeArc === command.sweep ? -1 : 1) * Math.sqrt(denominator === 0 ? 0 : numerator / denominator);
  const centerXPrime = coefficient * rx * transformedY / ry;
  const centerYPrime = coefficient * -ry * transformedX / rx;
  const cx = cosine * centerXPrime - sine * centerYPrime + (start.x + command.x) / 2;
  const cy = sine * centerXPrime + cosine * centerYPrime + (start.y + command.y) / 2;
  const ux = (transformedX - centerXPrime) / rx;
  const uy = (transformedY - centerYPrime) / ry;
  const vx = (-transformedX - centerXPrime) / rx;
  const vy = (-transformedY - centerYPrime) / ry;
  const startAngle = vectorAngle(1, 0, ux, uy);
  let deltaAngle = vectorAngle(ux, uy, vx, vy);
  if (!command.sweep && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (command.sweep && deltaAngle < 0) deltaAngle += Math.PI * 2;
  const result = { cx, cy, rx, ry, phi, startAngle, deltaAngle };
  for (const [label, value] of Object.entries(result)) assertSafeNumber(value, `arc ${label}`, MAX_SAFE_DERIVED_MAGNITUDE);
  return result;
}
function pointOnArc(arc, angle) {
  const cosine = Math.cos(arc.phi);
  const sine = Math.sin(arc.phi);
  return assertSafePoint({
    x: arc.cx + arc.rx * cosine * Math.cos(angle) - arc.ry * sine * Math.sin(angle),
    y: arc.cy + arc.rx * sine * Math.cos(angle) + arc.ry * cosine * Math.sin(angle)
  }, "arc point");
}
function arcCubics(start, command) {
  const arc = arcCenter(start, command);
  const segmentCount = Math.max(1, Math.ceil(Math.abs(arc.deltaAngle) / (Math.PI / 2)));
  const segmentAngle = arc.deltaAngle / segmentCount;
  const commands = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const angle1 = arc.startAngle + segment * segmentAngle;
    const angle2 = angle1 + segmentAngle;
    const alpha = 4 / 3 * Math.tan((angle2 - angle1) / 4);
    const point1 = pointOnArc(arc, angle1);
    const point2 = pointOnArc(arc, angle2);
    const cosine = Math.cos(arc.phi);
    const sine = Math.sin(arc.phi);
    const derivative = (angle) => ({
      x: -arc.rx * cosine * Math.sin(angle) - arc.ry * sine * Math.cos(angle),
      y: -arc.rx * sine * Math.sin(angle) + arc.ry * cosine * Math.cos(angle)
    });
    const derivative1 = derivative(angle1);
    const derivative2 = derivative(angle2);
    const cubic = {
      kind: "cubicTo",
      cp1x: point1.x + alpha * derivative1.x,
      cp1y: point1.y + alpha * derivative1.y,
      cp2x: point2.x - alpha * derivative2.x,
      cp2y: point2.y - alpha * derivative2.y,
      x: segment === segmentCount - 1 ? command.x : point2.x,
      y: segment === segmentCount - 1 ? command.y : point2.y
    };
    for (const value of Object.values(cubic)) {
      if (typeof value === "number") assertSafeNumber(value, "arc cubic coordinate", MAX_SAFE_DERIVED_MAGNITUDE);
    }
    commands.push(cubic);
  }
  return commands;
}
function validateSvgPathViewBox(viewBox) {
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || !(viewBox[2] > 0) || !(viewBox[3] > 0)) {
    throw pathError("viewBox must contain four finite values with positive width and height");
  }
  viewBox.forEach((value) => assertSafeNumber(value, "viewBox value"));
}
function traceNormalizedSvgPath(context, commands, viewBox, width, height) {
  validateSvgPathViewBox(viewBox);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw pathError("layer dimensions must be finite and positive");
  assertSafeNumber(width, "layer width");
  assertSafeNumber(height, "layer height");
  const [minimumX, minimumY, viewBoxWidth, viewBoxHeight] = viewBox;
  const map = (point) => assertSafePoint({
    x: (point.x - minimumX) / viewBoxWidth * width - width / 2,
    y: (point.y - minimumY) / viewBoxHeight * height - height / 2
  }, "mapped coordinate");
  const operations = [];
  let current = { x: 0, y: 0 };
  let subpath = current;
  for (const command of commands) {
    switch (command.kind) {
      case "moveTo": {
        current = { x: command.x, y: command.y };
        subpath = current;
        const point = map(current);
        operations.push({ kind: "moveTo", x: point.x, y: point.y });
        break;
      }
      case "lineTo": {
        current = { x: command.x, y: command.y };
        const point = map(current);
        operations.push({ kind: "lineTo", x: point.x, y: point.y });
        break;
      }
      case "quadraticTo": {
        const end = { x: command.x, y: command.y };
        const cp1 = map({ x: current.x + 2 / 3 * (command.cpx - current.x), y: current.y + 2 / 3 * (command.cpy - current.y) });
        const cp2 = map({ x: end.x + 2 / 3 * (command.cpx - end.x), y: end.y + 2 / 3 * (command.cpy - end.y) });
        const mappedEnd = map(end);
        operations.push({ kind: "cubicTo", cp1x: cp1.x, cp1y: cp1.y, cp2x: cp2.x, cp2y: cp2.y, x: mappedEnd.x, y: mappedEnd.y });
        current = end;
        break;
      }
      case "cubicTo": {
        const cp1 = map({ x: command.cp1x, y: command.cp1y });
        const cp2 = map({ x: command.cp2x, y: command.cp2y });
        const end = map({ x: command.x, y: command.y });
        operations.push({ kind: "cubicTo", cp1x: cp1.x, cp1y: cp1.y, cp2x: cp2.x, cp2y: cp2.y, x: end.x, y: end.y });
        current = { x: command.x, y: command.y };
        break;
      }
      case "arcTo": {
        for (const cubic of arcCubics(current, command)) {
          const cp1 = map({ x: cubic.cp1x, y: cubic.cp1y });
          const cp2 = map({ x: cubic.cp2x, y: cubic.cp2y });
          const end = map({ x: cubic.x, y: cubic.y });
          operations.push({ kind: "cubicTo", cp1x: cp1.x, cp1y: cp1.y, cp2x: cp2.x, cp2y: cp2.y, x: end.x, y: end.y });
        }
        current = { x: command.x, y: command.y };
        break;
      }
      case "close":
        operations.push({ kind: "close" });
        current = subpath;
        break;
    }
  }
  for (const operation of operations) {
    switch (operation.kind) {
      case "moveTo":
        context.moveTo(operation.x, operation.y);
        break;
      case "lineTo":
        context.lineTo(operation.x, operation.y);
        break;
      case "cubicTo":
        context.bezierCurveTo(operation.cp1x, operation.cp1y, operation.cp2x, operation.cp2y, operation.x, operation.y);
        break;
      case "close":
        context.closePath();
        break;
    }
  }
}
function rootsInUnitInterval(a, b, c) {
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) < 1e-14) return [];
    const root = -c / b;
    return root > 0 && root < 1 ? [root] : [];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const squareRoot = Math.sqrt(discriminant);
  return [(-b + squareRoot) / (2 * a), (-b - squareRoot) / (2 * a)].filter((root) => root > 0 && root < 1);
}
function cubicAt(start, cp1, cp2, end, time) {
  const inverse = 1 - time;
  return inverse ** 3 * start + 3 * inverse ** 2 * time * cp1 + 3 * inverse * time ** 2 * cp2 + time ** 3 * end;
}
function angleWithinArc(angle, arc) {
  const tau = Math.PI * 2;
  const normalize = (value) => (value % tau + tau) % tau;
  if (arc.deltaAngle >= 0) return normalize(angle - arc.startAngle) <= arc.deltaAngle + 1e-12;
  return normalize(arc.startAngle - angle) <= -arc.deltaAngle + 1e-12;
}
function svgPathBounds(commands) {
  if (commands.length === 0) throw pathError("cannot bound an empty command list");
  const points = [];
  let current = { x: 0, y: 0 };
  let subpath = current;
  const include = (point) => {
    points.push(assertSafePoint(point, "bounds point"));
  };
  for (const command of commands) {
    for (const value of Object.values(command)) {
      if (typeof value === "number") assertSafeNumber(value, `${command.kind} bounds coordinate`);
    }
    switch (command.kind) {
      case "moveTo":
      case "lineTo":
        current = { x: command.x, y: command.y };
        if (command.kind === "moveTo") subpath = current;
        include(current);
        break;
      case "quadraticTo": {
        const start = current;
        const end = { x: command.x, y: command.y };
        include(end);
        for (const axis of ["x", "y"]) {
          const denominator = start[axis] - 2 * command[axis === "x" ? "cpx" : "cpy"] + end[axis];
          if (Math.abs(denominator) < 1e-14) continue;
          const time = (start[axis] - command[axis === "x" ? "cpx" : "cpy"]) / denominator;
          if (time > 0 && time < 1) {
            const inverse = 1 - time;
            include({
              x: inverse ** 2 * start.x + 2 * inverse * time * command.cpx + time ** 2 * end.x,
              y: inverse ** 2 * start.y + 2 * inverse * time * command.cpy + time ** 2 * end.y
            });
          }
        }
        current = end;
        break;
      }
      case "cubicTo": {
        const start = current;
        const end = { x: command.x, y: command.y };
        include(end);
        const times = /* @__PURE__ */ new Set();
        for (const axis of ["x", "y"]) {
          const cp1 = command[axis === "x" ? "cp1x" : "cp1y"];
          const cp2 = command[axis === "x" ? "cp2x" : "cp2y"];
          const a = 3 * (-start[axis] + 3 * cp1 - 3 * cp2 + end[axis]);
          const b = 6 * (start[axis] - 2 * cp1 + cp2);
          const c = 3 * (cp1 - start[axis]);
          rootsInUnitInterval(a, b, c).forEach((time) => times.add(time));
        }
        for (const time of times) include({
          x: cubicAt(start.x, command.cp1x, command.cp2x, end.x, time),
          y: cubicAt(start.y, command.cp1y, command.cp2y, end.y, time)
        });
        current = end;
        break;
      }
      case "arcTo": {
        const arc = arcCenter(current, command);
        include({ x: command.x, y: command.y });
        const xAngle = Math.atan2(-arc.ry * Math.sin(arc.phi), arc.rx * Math.cos(arc.phi));
        const yAngle = Math.atan2(arc.ry * Math.cos(arc.phi), arc.rx * Math.sin(arc.phi));
        for (const angle of [arc.startAngle, arc.startAngle + arc.deltaAngle, xAngle, xAngle + Math.PI, yAngle, yAngle + Math.PI]) {
          if (angleWithinArc(angle, arc)) include(pointOnArc(arc, angle));
        }
        current = { x: command.x, y: command.y };
        break;
      }
      case "close":
        current = subpath;
        include(current);
        break;
    }
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const bounds = { x: minimumX, y: minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
  for (const [label, value] of Object.entries(bounds)) assertSafeNumber(value, `bounds ${label}`, MAX_SAFE_DERIVED_MAGNITUDE);
  return bounds;
}
function traceValidatedSvgPath(context, source, viewBox, width, height) {
  const commands = parseNormalizedSvgPath(source);
  svgPathBounds(commands);
  traceNormalizedSvgPath(context, commands, viewBox, width, height);
  return commands;
}
function hasOpenSvgSubpath(commands) {
  let drawable = false;
  let closed = false;
  let hasOpen = false;
  for (const command of commands) {
    if (command.kind === "moveTo") {
      if (drawable && !closed) hasOpen = true;
      drawable = false;
      closed = false;
    } else if (command.kind === "close") {
      closed = true;
    } else {
      drawable = true;
    }
  }
  return hasOpen || drawable && !closed;
}
export {
  hasOpenSvgSubpath,
  parseNormalizedSvgPath,
  serializeNormalizedSvgPath,
  svgPathBounds,
  traceNormalizedSvgPath,
  traceValidatedSvgPath,
  validateSvgPathViewBox
};
