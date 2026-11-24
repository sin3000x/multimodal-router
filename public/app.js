import { createEndpointPicker } from './endpoint-picker.js';

const KEY_AVOID_IDS = new Set([
  'CP_SUEZ',
  'CP_BAB',
  'CP_HORMUZ',
  'CP_MALACCA',
  'CP_PANAMA',
  'CP_CAPE',
  'AS_RUSSIA',
  'AS_MIDEAST',
]);

const ROLE_LABELS = {
  origin: '起运地',
  destination: '目的地',
  gateway: '口岸/机场',
  chokepoint: '咽喉/空域',
  border: '陆路口岸',
  hub: '中转枢纽',
};

const MODE_LABELS = { sea: '海运', air: '空运', rail: '铁路', road: '公路', local: '本地接驳' };
const NODE_GROUPS = {
  port: { label: '港口', color: 'sea' },
  airport: { label: '机场', color: 'air' },
  city: { label: '城市', color: 'city' },
  land: { label: '陆铁枢纽与口岸', color: 'rail' },
  passage: { label: '咽喉与空域', color: 'road' },
};
const NODE_SHORT_NAMES = { HKG: '香港机场', PVG: '上海浦东机场' };
const THEME_KEY = 'mmr-theme';

let worldGeo = null;
let currentRoutes = [];
let currentEndpoints = { origin: null, destination: null };
let activeRouteId = null;
let activeLeg = null;
let cardAnchor = null;
let cardOpen = false;

// Web Mercator coordinate helpers (mx in [0, 1), my in [0, 1])
function clampLat(lat) {
  return Math.max(-80, Math.min(83, lat));
}

function lonToMx(lon) {
  const norm = ((lon + 180) % 360 + 360) % 360;
  return norm / 360;
}

function latToMy(lat) {
  const rad = (clampLat(lat) * Math.PI) / 180;
  const sin = Math.sin(rad);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return Math.max(0, Math.min(1, y));
}

const DEFAULT_CENTER_MY = latToMy(20);

// Interactive map viewport state (isotropic Web Mercator)
const routeView = { zoom: 1, centerMx: 0.5, centerMy: DEFAULT_CENTER_MY };
const graphView = { ...routeView };
let view = routeView;
let fitRoutesOnReturn = false;
let graphNodes = null;
let graphLinks = null;
let nodesRequest = null;
let linksRequest = null;
let selectedGraphNode = null;
let renderedMarkers = [];
let renderedLegs = [];
let hoveredWaypointId = null;
let hoveredLeg = null;

function nodeLabel(node) {
  const code = node.code || node.id;
  const name = NODE_SHORT_NAMES[code] || node.name_zh || node.name_en || node.name || code;
  return code && name !== code && !code.startsWith('COORD_') ? `${name}（${code}）` : name;
}

function nodeGroups(node) {
  if (['chokepoint', 'airspace', 'sea_area'].includes(node.type)) return ['passage'];
  if (['airport', 'hub_airport'].includes(node.type)) return ['airport'];
  const groups = ['city', 'port'].filter((type) => node.type === type || node.functions?.includes(type));
  if (!['city', 'port'].includes(node.type)) groups.push('land');
  return groups;
}

function describeEndpoint(node) {
  const name = NODE_SHORT_NAMES[node.code || node.id] || node.name_zh || node.name_en || node.id;
  const types = nodeGroups(node).map((group) => NODE_GROUPS[group].label);
  return {
    title: name === node.id ? name : `${name}（${node.code || node.id}）`,
    detail: [...types, node.country, node.name_en !== name && node.name_en].filter(Boolean).join(' · '),
  };
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function getCssTokens() {
  const s = getComputedStyle(document.documentElement);
  const get = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    ocean: get('--map-ocean', '#dbeafe'),
    land: get('--map-land', '#ffffff'),
    coast: get('--map-coast', '#64748b'),
    grid: get('--map-grid', 'rgba(15, 23, 42, 0.08)'),
    labelBg: get('--map-label-bg', 'rgba(255, 255, 255, 0.92)'),
    labelText: get('--map-label-text', '#0f172a'),
    labelBorder: get('--map-label-border', '#94a3b8'),
    modes: {
      sea: get('--sea', '#0284c7'),
      air: get('--air', '#7c3aed'),
      rail: get('--rail', '#059669'),
      road: get('--road', '#d97706'),
      local: get('--road', '#d97706'),
      city: get('--map-label-text', '#0f172a'),
    },
  };
}

function applyTheme(theme) {
  const valid = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
  document.documentElement.setAttribute('data-theme', valid);
  localStorage.setItem(THEME_KEY, valid);
  for (const btn of document.querySelectorAll('.theme-btn')) {
    btn.classList.toggle('active', btn.dataset.theme === valid);
  }
  drawWorldMap(currentRoutes, activeRouteId);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(saved);
  for (const btn of document.querySelectorAll('.theme-btn')) {
    btn.onclick = () => applyTheme(btn.dataset.theme);
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.getAttribute('data-theme') === 'system') {
      drawWorldMap(currentRoutes, activeRouteId);
    }
  });
}

function getCanvasMetrics() {
  const canvas = document.getElementById('world-map');
  if (!canvas) return null;
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 440;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  return { canvas, cssW, cssH, dpr };
}

function syncCanvasSize() {
  const m = getCanvasMetrics();
  if (!m) return null;
  const targetW = Math.round(m.cssW * m.dpr);
  const targetH = Math.round(m.cssH * m.dpr);
  if (m.canvas.width !== targetW || m.canvas.height !== targetH) {
    m.canvas.width = targetW;
    m.canvas.height = targetH;
  }
  return m;
}

function wrapUnit(u) {
  return ((u % 1) + 1) % 1;
}

function clampZoom(zoom, aspect) {
  return Math.max(Math.min(0.8, 0.76 * aspect), Math.min(12, zoom));
}

function clampView() {
  const m = getCanvasMetrics();
  const aspectRatio = m ? m.cssH / m.cssW : 0.48;
  view.zoom = clampZoom(view.zoom, aspectRatio);
  view.centerMx = wrapUnit(view.centerMx);
  const halfMySpan = Math.min(0.49, (aspectRatio / view.zoom) * 0.5);
  const minMy = Math.max(latToMy(82), halfMySpan * 0.7);
  const maxMy = Math.min(latToMy(-76), 1 - halfMySpan * 0.7);
  view.centerMy = Math.max(minMy, Math.min(maxMy, view.centerMy));
  const badge = document.getElementById('zoom-level');
  if (badge) badge.textContent = `${view.zoom.toFixed(1)}x`;
}

function projectRaw(mx, my, cssW, cssH) {
  const worldPx = cssW * view.zoom;
  const x = cssW / 2 + (mx - view.centerMx) * worldPx;
  const y = cssH / 2 + (my - view.centerMy) * worldPx;
  return [x, y];
}

function* visibleWorldOffsets(minMx = 0, maxMx = 1) {
  const halfWidth = 0.5 / view.zoom;
  const first = Math.ceil(view.centerMx - halfWidth - maxMx);
  const last = Math.floor(view.centerMx + halfWidth - minMx);
  for (let offset = first; offset <= last; offset++) yield offset;
}

function nearestCopyMx(mx) {
  const candidates = [mx - 1, mx, mx + 1];
  let best = mx;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - view.centerMx);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function unwrapMxs(coords) {
  if (!coords.length) return [];
  const out = [[lonToMx(coords[0][0]), latToMy(coords[0][1])]];
  for (let i = 1; i < coords.length; i++) {
    let mx = lonToMx(coords[i][0]);
    const prevMx = out[i - 1][0];
    while (mx - prevMx > 0.5) mx -= 1;
    while (mx - prevMx < -0.5) mx += 1;
    out.push([mx, latToMy(coords[i][1])]);
  }
  return out;
}

function fitRoutesToView(routes) {
  const m = getCanvasMetrics();
  if (!m) return;

  const longitudeRanges = [];
  let minMy = Infinity;
  let maxMy = -Infinity;

  function includePath(points) {
    if (!points.length) return;
    let minMx = Infinity;
    let maxMx = -Infinity;
    for (const [mx, my] of points) {
      minMx = Math.min(minMx, mx);
      maxMx = Math.max(maxMx, mx);
      minMy = Math.min(minMy, my);
      maxMy = Math.max(maxMy, my);
    }

    const span = maxMx - minMx;
    const start = wrapUnit(minMx);
    const end = start + span;
    if (span >= 1) longitudeRanges.push([0, 1]);
    else if (end > 1) longitudeRanges.push([start, 1], [0, end - 1]);
    else longitudeRanges.push([start, end]);
  }

  for (const route of routes) {
    for (const leg of route.legs || []) includePath(unwrapMxs(leg.geometry || []));
    for (const wp of route.waypoints || []) includePath([[lonToMx(wp.lon), latToMy(wp.lat)]]);
  }
  if (!longitudeRanges.length) return;

  // Place the wrap seam in the largest gap between paths.
  longitudeRanges.sort((a, b) => a[0] - b[0]);
  const firstStart = longitudeRanges[0][0];
  let coveredUntil = firstStart;
  let maxGap = 0;
  let gapEnd = 0;
  for (const [start, end] of [...longitudeRanges, [firstStart + 1, firstStart + 1]]) {
    const gap = start - coveredUntil;
    if (gap > maxGap) {
      maxGap = gap;
      gapEnd = start;
    }
    coveredUntil = Math.max(coveredUntil, end);
  }

  const mxSpan = 1 - maxGap;
  view.centerMx = gapEnd + mxSpan / 2;
  view.centerMy = (minMy + maxMy) / 2;
  const zx = 0.8 / Math.max(0.04, mxSpan);
  const zy = (0.76 * m.cssH) / (m.cssW * Math.max(0.03, maxMy - minMy));
  view.zoom = Math.min(9, zx, zy);
  clampView();
}

function boxesOverlap(a, b, pad = 4) {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

function drawWaypointMarker(ctx, wp, x, y, modeColor, isHovered) {
  ctx.save();
  if (isHovered) {
    ctx.fillStyle = 'rgba(2, 132, 199, 0.22)';
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  }

  if (wp.role === 'origin' || wp.role === 'destination') {
    ctx.fillStyle = wp.role === 'origin' ? '#059669' : '#dc2626';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, isHovered ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (wp.role === 'chokepoint' || wp.role === 'border' || wp.role === 'hub') {
    const r = isHovered ? 6 : 4.5;
    ctx.fillStyle = wp.role === 'chokepoint' ? '#f59e0b' : '#10b981';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = modeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, isHovered ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawWaypointLabels(ctx, items, tokens, cssW, cssH) {
  const placed = [];
  const priority = { origin: 0, destination: 0, chokepoint: 1, border: 2, gateway: 3, hub: 4 };
  const sorted = [...items].sort(
    (a, b) => (priority[a.wp.role] ?? 5) - (priority[b.wp.role] ?? 5)
  );

  ctx.save();
  ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';

  for (const item of sorted) {
    const { wp, x, y } = item;
    if (x < -10 || x > cssW + 10 || y < -10 || y > cssH + 10) continue;

    const label = nodeLabel(wp);
    const textW = ctx.measureText(label).width;
    const padX = 6;
    const boxW = textW + padX * 2;
    const boxH = 19;

    const offsets = [
      [10, -boxH / 2],
      [-boxW - 10, -boxH / 2],
      [-boxW / 2, -boxH - 10],
      [-boxW / 2, 10],
    ];

    let chosen = null;
    for (const [dx, dy] of offsets) {
      const box = { x: x + dx, y: y + dy, w: boxW, h: boxH };
      if (box.x < 4 || box.x + box.w > cssW - 4 || box.y < 4 || box.y + box.h > cssH - 4) continue;
      if (!placed.some((p) => boxesOverlap(box, p, 4))) {
        chosen = box;
        break;
      }
    }

    if (!chosen && (wp.role === 'origin' || wp.role === 'destination')) {
      chosen = {
        x: Math.max(4, Math.min(cssW - boxW - 4, x + 10)),
        y: Math.max(4, Math.min(cssH - boxH - 4, y - boxH / 2)),
        w: boxW,
        h: boxH,
      };
    }
    if (!chosen) continue;

    placed.push(chosen);
    ctx.fillStyle = tokens.labelBg;
    ctx.strokeStyle = wp.id === hoveredWaypointId ? tokens.modes.sea : tokens.labelBorder;
    ctx.lineWidth = wp.id === hoveredWaypointId ? 1.5 : 1;
    ctx.beginPath();
    ctx.roundRect(chosen.x, chosen.y, chosen.w, chosen.h, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = tokens.labelText;
    ctx.fillText(label, chosen.x + padX, chosen.y + chosen.h / 2 + 0.5);
  }
  ctx.restore();
}

function drawGraphLinks(ctx, tokens, width, height) {
  if (!graphLinks) return;
  for (const [layer, paths] of Object.entries(graphLinks)) {
    if (!document.getElementById(`${layer}-layer`).checked) continue;
    ctx.save();
    ctx.globalAlpha = layer === 'sea' ? 0.42 : 0.78;
    ctx.lineWidth = layer === 'sea' ? 1 : 1.7;
    for (const [mode, segments] of paths) {
      ctx.strokeStyle = tokens.modes[mode] || tokens.modes.rail;
      ctx.beginPath();
      for (const { points, minMx, maxMx, minMy, maxMy } of segments) {
        const [, top] = projectRaw(0, minMy, width, height);
        const [, bottom] = projectRaw(0, maxMy, width, height);
        if (top > height || bottom < 0) continue;
        for (const offset of visibleWorldOffsets(minMx, maxMx)) {
          points.forEach(([mx, my], index) => {
            const [x, y] = projectRaw(mx + offset, my, width, height);
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawNodeGraph(ctx, tokens, width, height) {
  renderedMarkers = [];
  renderedLegs = [];
  if (!graphNodes) return;
  drawGraphLinks(ctx, tokens, width, height);
  const filter = document.getElementById('graph-type').value;
  const cells = new Map();
  const markers = [];
  for (const node of graphNodes) {
    const selected = node === selectedGraphNode;
    if (!selected && ((filter && !node.groups.includes(filter)) || (view.zoom < 2 && !node.featured))) continue;
    const [x, y] = projectRaw(nearestCopyMx(node.mx), node.my, width, height);
    if (x < 0 || x > width || y < 0 || y > height) continue;
    const marker = { wp: node, x, y };
    if (selected || view.zoom >= 8) {
      markers.push(marker);
      continue;
    }
    const key = `${Math.floor(x / 32)},${Math.floor(y / 32)}`;
    const cell = cells.get(key) || [];
    cell.push(marker);
    cells.set(key, cell);
  }

  for (const cell of cells.values()) {
    if (cell.length === 1) {
      markers.push(cell[0]);
      continue;
    }
    const x = cell.reduce((sum, marker) => sum + marker.x, 0) / cell.length;
    const y = cell.reduce((sum, marker) => sum + marker.y, 0) / cell.length;
    markers.push({ count: cell.length, x, y });
  }

  markers.sort((a, b) => Number(a.wp === selectedGraphNode) - Number(b.wp === selectedGraphNode));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
  for (const marker of markers) {
    const { wp, x, y, count } = marker;
    const emphasis = wp && (wp === selectedGraphNode || wp.id === hoveredWaypointId);
    const radius = count ? Math.min(15, 9 + Math.log2(count)) : emphasis ? 7 : 4;
    const group = wp && (filter && wp.groups.includes(filter) ? filter : wp.groups[0]);
    ctx.fillStyle = group ? tokens.modes[NODE_GROUPS[group].color] : tokens.labelBg;
    ctx.strokeStyle = count ? tokens.labelBorder : tokens.land;
    ctx.lineWidth = emphasis ? 2 : 1;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (count) {
      ctx.fillStyle = tokens.labelText;
      ctx.fillText(count, x, y + 0.5);
    }
    renderedMarkers.push({ ...marker, radius });
  }
  ctx.restore();
  drawWaypointLabels(ctx, renderedMarkers.filter(({ wp }) =>
    wp && (wp === selectedGraphNode || wp.id === hoveredWaypointId)), tokens, width, height);
}

function drawWorldMap(routes, highlightedId) {
  const m = syncCanvasSize();
  if (!m) return;
  const { canvas, cssW, cssH, dpr } = m;
  const ctx = canvas.getContext('2d');
  const tokens = getCssTokens();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = tokens.ocean;
  ctx.fillRect(0, 0, cssW, cssH);

  // Graticule across wrapped world copies
  ctx.strokeStyle = tokens.grid;
  ctx.lineWidth = 1;
  for (const mxOffset of visibleWorldOffsets()) {
    for (let lon = -150; lon <= 150; lon += 30) {
      const [x] = projectRaw(lonToMx(lon) + mxOffset, 0.5, cssW, cssH);
      if (x < 0 || x > cssW) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = projectRaw(0.5, latToMy(lat), cssW, cssH);
    if (y < 0 || y > cssH) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
  }

  // Land polygons in each visible copy keep longitude wrapping seamless.
  if (worldGeo?.features) {
    ctx.fillStyle = tokens.land;
    ctx.strokeStyle = tokens.coast;
    ctx.lineWidth = 0.8;
    for (const mxOffset of visibleWorldOffsets()) {
      for (const f of worldGeo.features) {
        const rings =
          f.geometry?.type === 'Polygon'
            ? [f.geometry.coordinates[0]]
            : f.geometry?.type === 'MultiPolygon'
            ? f.geometry.coordinates.map((p) => p[0])
            : [];
        for (const ring of rings) {
          if (!ring?.length) continue;
          ctx.beginPath();
          ring.forEach((pt, idx) => {
            const mx = (pt[0] + 180) / 360 + mxOffset;
            const my = latToMy(pt[1]);
            const [x, y] = projectRaw(mx, my, cssW, cssH);
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  if (view === graphView) {
    drawNodeGraph(ctx, tokens, cssW, cssH);
    return;
  }

  // Draw hovered routes last and use the same projected paths for hit testing.
  const priority = (route) => hoveredLeg?.route === route ? 2 : Number(route.routeId === highlightedId);
  const ordered = [...routes].sort((a, b) => priority(a) - priority(b));
  renderedLegs = [];

  for (const route of ordered) {
    const isSelected = highlightedId === route.routeId;
    const isHovered = hoveredLeg?.route === route;
    const color = tokens.modes[route.mode] || tokens.modes.sea;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const dash = route.mode === 'air' ? [6, 4] : route.mode === 'rail' ? [3, 3.5] : [];

    for (const leg of route.legs || []) {
      const unwrapped = unwrapMxs(leg.geometry || []);
      if (unwrapped.length < 2) continue;
      const longitudes = unwrapped.map(([mx]) => mx);

      for (const extraShift of visibleWorldOffsets(Math.min(...longitudes), Math.max(...longitudes))) {
        const points = unwrapped.map(([mx, my]) => projectRaw(mx + extraShift, my, cssW, cssH));
        renderedLegs.push({ route, leg, points });
        ctx.beginPath();
        ctx.moveTo(...points[0]);
        for (const point of points.slice(1)) ctx.lineTo(...point);

        const isFocusedLeg = leg === hoveredLeg?.leg || leg === activeLeg;
        if (isFocusedLeg) {
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = tokens.labelBg;
          ctx.lineWidth = 9;
          ctx.stroke();
        }
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.globalAlpha = isSelected || isHovered ? 0.98 : highlightedId ? 0.46 : 0.8;
        ctx.lineWidth = isFocusedLeg ? 5 : isSelected || isHovered ? 3 : 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Waypoint markers & labels for selected route (fallback to origin/destination)
  const activeRoute = routes.find((r) => r.routeId === highlightedId) ?? routes[0];
  let waypoints = activeRoute?.waypoints ?? [];
  if (!waypoints.length && currentEndpoints.origin && currentEndpoints.destination) {
    waypoints = [
      { ...currentEndpoints.origin, role: 'origin' },
      { ...currentEndpoints.destination, role: 'destination' },
    ];
  }

  const activeColor = tokens.modes[activeRoute?.mode] || tokens.modes.sea;
  renderedMarkers = [];
  for (const wp of waypoints) {
    const mxCopy = nearestCopyMx(lonToMx(wp.lon));
    const [x, y] = projectRaw(mxCopy, latToMy(wp.lat), cssW, cssH);
    renderedMarkers.push({ wp, x, y });
    drawWaypointMarker(ctx, wp, x, y, activeColor, wp.id === hoveredWaypointId);
  }
  drawWaypointLabels(ctx, renderedMarkers, tokens, cssW, cssH);
  positionRouteCard(cssW, cssH, activeColor);
}

function closestPointOnSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
  return [ax + t * dx, ay + t * dy];
}

function clipMapSegment(a, b, width, height, x = 0, y = 0) {
  let start = 0;
  let end = 1;
  const lower = [x, y];
  const upper = [x + width, y + height];
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis];
    if (delta === 0) {
      if (a[axis] < lower[axis] || a[axis] > upper[axis]) return null;
      continue;
    }
    const entry = (lower[axis] - a[axis]) / delta;
    const exit = (upper[axis] - a[axis]) / delta;
    start = Math.max(start, Math.min(entry, exit));
    end = Math.min(end, Math.max(entry, exit));
    if (start > end) return null;
  }
  return [start, end].map((t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

function routeCardAnchor(width, height) {
  const inside = ([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height;
  if (cardAnchor) {
    const [mx, my] = cardAnchor;
    const point = projectRaw(nearestCopyMx(wrapUnit(mx)), my, width, height);
    if (inside(point)) return point;
  }

  let anchor = null;
  let bestScore = Infinity;
  const centerX = width / 2;
  const centerY = height / 2;
  for (const { route, leg, points } of renderedLegs) {
    if (route.routeId !== activeRouteId) continue;
    for (let i = 1; i < points.length; i++) {
      const segment = clipMapSegment(points[i - 1], points[i], width, height);
      if (!segment) continue;
      const [x, y] = closestPointOnSegment(centerX, centerY, ...segment);
      const focusPenalty = activeLeg && leg !== activeLeg ? width + height : 0;
      const score = Math.hypot(x - centerX, y - centerY) + focusPenalty;
      if (score < bestScore) {
        anchor = [x, y];
        bestScore = score;
      }
    }
  }
  if (anchor) return anchor;
  const marker = renderedMarkers.find(({ x, y }) => inside([x, y]));
  return marker ? [marker.x, marker.y] : null;
}

function cardIntersectsRoutes(x, y, width, height) {
  const padding = 8;
  const left = x - padding;
  const right = x + width + padding;
  const top = y - padding;
  const bottom = y + height + padding;
  for (const { points } of renderedLegs) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.max(a[0], b[0]) < left || Math.min(a[0], b[0]) > right ||
          Math.max(a[1], b[1]) < top || Math.min(a[1], b[1]) > bottom) continue;
      if (clipMapSegment(a, b, right - left, bottom - top, left, top)) return true;
    }
  }
  return false;
}

function positionRouteCard(width, height, color) {
  const card = document.getElementById('map-route-card');
  const stage = card.parentElement;
  const docked = stage.classList.contains('route-card-docked');
  const anchor = cardOpen ? routeCardAnchor(width, height) : null;
  const visible = cardOpen && (anchor || docked);
  card.classList.toggle('hidden', !visible);
  if (!visible) return;

  const [x, y] = anchor ?? [width, height / 2];
  const { offsetWidth: cardWidth, offsetHeight: cardHeight } = card;
  const controls = document.querySelector('.map-controls');
  const minX = 8;
  const minY = controls.offsetTop + controls.offsetHeight + 6;
  const maxX = width - cardWidth - 8;
  const maxY = height - cardHeight - 8;
  const gap = 12;
  const clampX = (value) => Math.max(minX, Math.min(maxX, value));
  const clampY = (value) => Math.max(minY, Math.min(maxY, value));
  const centeredX = clampX(x - cardWidth / 2);
  const centeredY = clampY(y - cardHeight / 2);
  let position = [width + 10, centeredY];
  if (!docked) {
    const candidates = [
      [x + gap, centeredY], [x - cardWidth - gap, centeredY],
      [centeredX, y + gap], [centeredX, y - cardHeight - gap],
      [minX, centeredY], [maxX, centeredY], [centeredX, minY], [centeredX, maxY],
      [minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY],
    ];
    position = candidates.find(([left, top]) => left >= minX && left <= maxX &&
      top >= minY && top <= maxY && !cardIntersectsRoutes(left, top, cardWidth, cardHeight));
    if (!position) {
      stage.classList.add('route-card-docked');
      clampView();
      drawWorldMap(currentRoutes, activeRouteId);
      return;
    }
  }

  const [cardX, cardY] = position;
  card.style.left = `${cardX + 1}px`;
  card.style.top = `${cardY + 1}px`;
  card.style.setProperty('--route-color', color);
}

function mapTargetAt(x, y, pointerType) {
  const radius = pointerType === 'touch' ? 18 : 10;
  let marker = null;
  let bestDistance = radius ** 2;
  for (let i = renderedMarkers.length - 1; i >= 0; i--) {
    const item = renderedMarkers[i];
    const distance = (item.x - x) ** 2 + (item.y - y) ** 2;
    const hitRadius = Math.max(radius, item.radius || 0);
    if (distance < hitRadius ** 2 && (!marker || distance < bestDistance)) {
      bestDistance = distance;
      marker = item;
    }
  }
  if (marker) return marker;

  let target = null;
  // Prefer the topmost stroke when two paths are equally close.
  for (let i = renderedLegs.length - 1; i >= 0; i--) {
    const item = renderedLegs[i];
    for (let j = 1; j < item.points.length; j++) {
      const closest = closestPointOnSegment(x, y, item.points[j - 1], item.points[j]);
      const distance = (x - closest[0]) ** 2 + (y - closest[1]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        target = { ...item, anchor: closest };
      }
    }
  }
  return target;
}

function legSummary(leg) {
  return `${MODE_LABELS[leg.mode] || leg.mode} · ${leg.fromName} → ${leg.toName} · ${leg.distanceKm} km`;
}

function clearMapHover() {
  const changed = Boolean(hoveredWaypointId || hoveredLeg);
  hoveredWaypointId = null;
  hoveredLeg = null;
  document.getElementById('map-tooltip').classList.add('hidden');
  document.getElementById('world-map').classList.remove('map-target');
  return changed;
}

function initMapInteractions() {
  const canvas = document.getElementById('world-map');
  const tooltip = document.getElementById('map-tooltip');
  const panel = document.getElementById('map-panel');
  const stage = panel.querySelector('.map-stage');
  let gesture = null;
  let pinchScale = null;

  function cssPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left - canvas.clientLeft, y: e.clientY - rect.top - canvas.clientTop };
  }

  function showMapTarget(target, x, y) {
    const waypoint = target?.wp;
    const nextWaypointId = waypoint?.id ?? null;
    const nextLeg = target?.leg ? target : null;
    const changed = hoveredWaypointId !== nextWaypointId || hoveredLeg?.leg !== nextLeg?.leg;
    hoveredWaypointId = nextWaypointId;
    hoveredLeg = nextLeg;
    if (changed) drawWorldMap(currentRoutes, activeRouteId);

    canvas.classList.toggle('map-target', Boolean(target));
    tooltip.classList.toggle('hidden', !target);
    if (!target) return;

    if (waypoint) {
      const role = waypoint.groups?.map((group) => NODE_GROUPS[group].label).join(' / ')
        || ROLE_LABELS[waypoint.role] || waypoint.type;
      tooltip.textContent = `${nodeLabel(waypoint)} · ${role}`;
    } else {
      tooltip.textContent = target.count ? `${target.count} 个节点 · 点击放大` : legSummary(target.leg);
    }
    const { offsetWidth, offsetHeight } = tooltip;
    tooltip.style.left = `${Math.max(8, Math.min(canvas.clientWidth - offsetWidth - 8, x + 12))}px`;
    const top = y - offsetHeight - 10;
    tooltip.style.top = `${Math.max(8, Math.min(canvas.clientHeight - offsetHeight - 8, top < 8 ? y + 14 : top))}px`;
  }

  function zoomAt(factor, x, y) {
    const m = getCanvasMetrics();
    if (!m) return;
    const oldWorldPx = m.cssW * view.zoom;
    const mxUnder = view.centerMx + (x - m.cssW / 2) / oldWorldPx;
    const myUnder = view.centerMy + (y - m.cssH / 2) / oldWorldPx;

    view.zoom = Math.max(Math.min(1, view.zoom), Math.min(12, view.zoom * factor));
    const newWorldPx = m.cssW * view.zoom;
    view.centerMx = mxUnder - (x - m.cssW / 2) / newWorldPx;
    view.centerMy = myUnder - (y - m.cssH / 2) / newWorldPx;
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (pinchScale !== null) return;
    const unit = e.deltaMode;
    const pixelsPerUnit = unit === WheelEvent.DOM_DELTA_LINE ? 16
      : unit === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
    const delta = e.deltaY * pixelsPerUnit;
    if (!delta) return;
    const sensitivity = e.ctrlKey ? 0.0045 : 0.0016;
    const step = Math.max(-0.16, Math.min(0.16, -delta * sensitivity));
    const { x, y } = cssPoint(e);
    zoomAt(Math.exp(step), x, y);
  }, { passive: false });

  canvas.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    pinchScale = 1;
  }, { passive: false });

  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (pinchScale === null || !Number.isFinite(e.scale) || e.scale <= 0) return;
    const factor = (e.scale / pinchScale) ** 0.72;
    pinchScale = e.scale;
    const { x, y } = Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
      ? cssPoint(e)
      : { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    zoomAt(factor, x, y);
  }, { passive: false });

  canvas.addEventListener('gestureend', () => {
    pinchScale = null;
  });

  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = cssPoint(e);
    zoomAt(1.6, x, y);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const { x, y } = cssPoint(e);
    gesture = { id: e.pointerId, x, y, centerMx: view.centerMx, centerMy: view.centerMy, dragging: false };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    const { x, y } = cssPoint(e);
    if (!gesture) {
      if (e.pointerType !== 'touch') showMapTarget(mapTargetAt(x, y, e.pointerType), x, y);
      return;
    }
    if (e.pointerId !== gesture.id) return;
    const dx = x - gesture.x;
    const dy = y - gesture.y;
    if (!gesture.dragging && Math.hypot(dx, dy) < 5) return;
    if (!gesture.dragging) {
      gesture.dragging = true;
      canvas.classList.add('dragging');
      clearMapHover();
    }
    const worldPx = canvas.clientWidth * view.zoom;
    view.centerMx = gesture.centerMx - dx / worldPx;
    view.centerMy = gesture.centerMy - dy / worldPx;
    clampView();
    drawWorldMap(currentRoutes, activeRouteId);
  });

  function finishGesture(e) {
    if (e.pointerId !== gesture?.id) return;
    gesture = null;
    canvas.classList.remove('dragging');
  }

  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerId !== gesture?.id) return;
    const { x, y } = cssPoint(e);
    const isTap = !gesture.dragging && Math.hypot(x - gesture.x, y - gesture.y) < 5;
    finishGesture(e);
    if (!isTap) return;
    const target = mapTargetAt(x, y, e.pointerType);
    if (view === graphView) {
      if (target?.count) {
        const worldPx = canvas.clientWidth * view.zoom;
        view.centerMx += (target.x - canvas.clientWidth / 2) / worldPx;
        view.centerMy += (target.y - canvas.clientHeight / 2) / worldPx;
        zoomAt(Math.max(1.7, 2 / view.zoom), canvas.clientWidth / 2, canvas.clientHeight / 2);
      } else {
        selectGraphNode(target?.wp ?? null);
      }
      return;
    }
    if (target?.leg) {
      const [px, py] = target.anchor;
      const worldPx = canvas.clientWidth * view.zoom;
      const anchor = [
        view.centerMx + (px - canvas.clientWidth / 2) / worldPx,
        view.centerMy + (py - canvas.clientHeight / 2) / worldPx,
      ];
      selectRoute(target.route.routeId, target.leg, anchor);
    } else if (!target && activeLeg && cardOpen) {
      selectRoute(activeRouteId);
    }
    showMapTarget(target?.wp ? target : null, x, y);
  });

  canvas.addEventListener('pointercancel', finishGesture);
  canvas.addEventListener('lostpointercapture', finishGesture);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch' && clearMapHover()) drawWorldMap(currentRoutes, activeRouteId);
  });

  document.getElementById('zoom-in-btn').onclick = () => {
    const m = getCanvasMetrics();
    if (m) zoomAt(1.5, m.cssW / 2, m.cssH / 2);
  };
  document.getElementById('zoom-out-btn').onclick = () => {
    const m = getCanvasMetrics();
    if (m) zoomAt(1 / 1.5, m.cssW / 2, m.cssH / 2);
  };
  function fitSelectedRoute() {
    const active = currentRoutes.find((r) => r.routeId === activeRouteId);
    if (!active) return;
    fitRoutesToView([active]);
    cardOpen = true;
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  }
  document.getElementById('fit-route-btn').onclick = fitSelectedRoute;
  document.getElementById('reset-zoom-btn').onclick = () => {
    view.zoom = 1;
    view.centerMx = 0.5;
    view.centerMy = DEFAULT_CENTER_MY;
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  };

  const routeSelect = document.getElementById('route-select');
  routeSelect.onchange = () => {
    selectRoute(routeSelect.value);
    if (document.getElementById('map-route-card').classList.contains('hidden')) {
      fitSelectedRoute();
    }
  };
  document.getElementById('close-route-card').onclick = () => {
    cardOpen = false;
    stage.classList.remove('route-card-docked');
    resizeMap();
    routeSelect.focus({ preventScroll: true });
  };
  document.getElementById('card-legs').ontoggle = () => drawWorldMap(currentRoutes, activeRouteId);

  function resizeMap() {
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  }

  const fullscreen = document.getElementById('fullscreen-btn');
  function updateFullscreen() {
    const expanded = document.fullscreenElement === panel || panel.classList.contains('map-maximized');
    fullscreen.textContent = expanded ? '退出全屏' : '全屏';
    fullscreen.setAttribute('aria-pressed', String(expanded));
    stage.classList.remove('route-card-docked');
    resizeMap();
  }

  fullscreen.onclick = async () => {
    if (document.fullscreenElement === panel) {
      await document.exitFullscreen();
    } else if (panel.classList.contains('map-maximized')) {
      panel.classList.remove('map-maximized');
      updateFullscreen();
    } else {
      try {
        await panel.requestFullscreen();
      } catch {
        panel.classList.add('map-maximized');
        updateFullscreen();
      }
    }
  };
  document.addEventListener('fullscreenchange', updateFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('map-maximized')) {
      panel.classList.remove('map-maximized');
      updateFullscreen();
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(resizeMap);
    observer.observe(canvas);
  } else {
    window.addEventListener('resize', resizeMap);
  }
}

function selectGraphNode(node, recenter = false) {
  selectedGraphNode = node;
  document.getElementById('graph-card').classList.toggle('hidden', !node);
  if (node) {
    const label = nodeLabel(node);
    document.getElementById('graph-node-name').textContent = label;
    const labels = node.groups.map((group) => NODE_GROUPS[group].label).join(' / ');
    const fullName = node.name_zh || node.name_en;
    document.getElementById('graph-node-details').textContent = [
      fullName && fullName !== label && !label.startsWith(`${fullName}（`) ? fullName : '',
      labels,
      node.country,
      `${node.lon.toFixed(2)}, ${node.lat.toFixed(2)}`,
    ].filter(Boolean).join(' · ');
    document.getElementById('graph-endpoints').classList.toggle('hidden', node.groups.includes('passage'));
    if (recenter) {
      view.zoom = Math.max(view.zoom, 8);
      view.centerMx = node.mx;
      view.centerMy = node.my;
      clampView();
    }
  }
  clearMapHover();
  drawWorldMap(currentRoutes, activeRouteId);
}

function prepareGraphLinks(links) {
  const byMode = new Map();
  for (const { mode, coords } of links) {
    const points = unwrapMxs(coords || []);
    if (points.length < 2) continue;
    const xs = points.map(([mx]) => mx);
    const ys = points.map(([, my]) => my);
    const segments = byMode.get(mode) || [];
    segments.push({ points, minMx: Math.min(...xs), maxMx: Math.max(...xs), minMy: Math.min(...ys), maxMy: Math.max(...ys) });
    byMode.set(mode, segments);
  }
  return byMode;
}

function updateGraphSearch() {
  const query = document.getElementById('graph-search').value.trim().toLowerCase();
  const filter = document.getElementById('graph-type').value;
  const results = document.getElementById('graph-results');
  results.replaceChildren();
  results.classList.toggle('hidden', !query || !graphNodes);
  if (!query || !graphNodes) return;

  const matches = graphNodes
    .filter((node) => (!filter || node.groups.includes(filter)) && node.searchTerms.some((term) => term.includes(query)))
    .sort((a, b) => Number(b.searchTerms.includes(query)) - Number(a.searchTerms.includes(query))
      || Number(b.featured) - Number(a.featured));
  if (!matches.length) results.textContent = '未找到匹配节点';
  for (const node of matches.slice(0, 12)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = nodeLabel(node);
    button.onclick = () => {
      results.classList.add('hidden');
      document.getElementById('graph-search').value = '';
      selectGraphNode(node, true);
      document.getElementById('close-graph-card').focus();
    };
    results.appendChild(button);
  }
}

function setMapView(nextView) {
  if (view === nextView) return;
  view = nextView;
  const isGraph = view === graphView;
  document.getElementById('map-panel').dataset.view = isGraph ? 'graph' : 'routes';
  document.getElementById('graph-view-btn').setAttribute('aria-pressed', String(isGraph));
  document.getElementById('route-view-btn').setAttribute('aria-pressed', String(!isGraph));
  document.querySelector('.map-stage').classList.remove('route-card-docked');
  document.getElementById('graph-results').classList.add('hidden');
  if (!isGraph && fitRoutesOnReturn) {
    fitRoutesToView(currentRoutes);
    fitRoutesOnReturn = false;
  }
  clampView();
  clearMapHover();
  drawWorldMap(currentRoutes, activeRouteId);
}

function initNodeGraph() {
  const status = document.getElementById('graph-status');
  const search = document.getElementById('graph-search');
  const results = document.getElementById('graph-results');
  const seaLayer = document.getElementById('sea-layer');
  const landLayer = document.getElementById('land-layer');

  document.getElementById('route-view-btn').onclick = () => setMapView(routeView);
  document.getElementById('graph-view-btn').onclick = async () => {
    setMapView(graphView);
    if (graphNodes || nodesRequest) return;
    status.textContent = '正在加载节点…';
    nodesRequest = fetchJson('/v1/graph/nodes');
    try {
      const { nodes } = await nodesRequest;
      graphNodes = nodes.map((node) => ({
        ...node,
        groups: nodeGroups(node),
        mx: lonToMx(node.lon),
        my: latToMy(node.lat),
        searchTerms: [node.id, node.code, node.name_zh, node.name_en, NODE_SHORT_NAMES[node.id], ...(node.aliases || [])]
          .filter(Boolean).map((term) => term.toLowerCase()),
      }));
      status.textContent = `${nodes.length.toLocaleString('zh-CN')} 个节点 · 放大查看全部`;
      if (view === graphView) updateGraphSearch();
      drawWorldMap(currentRoutes, activeRouteId);
    } catch {
      status.textContent = '节点加载失败，点击「节点图谱」重试';
    } finally {
      nodesRequest = null;
    }
  };

  async function toggleLayers() {
    if (!graphLinks && !linksRequest && (seaLayer.checked || landLayer.checked)) {
      linksRequest = fetchJson('/v1/graph/links');
      status.textContent = '正在加载线路图层…';
      try {
        const { sea, land } = await linksRequest;
        graphLinks = { sea: prepareGraphLinks(sea), land: prepareGraphLinks(land) };
        status.textContent = graphNodes ? `${graphNodes.length.toLocaleString('zh-CN')} 个节点 · 放大查看全部` : '';
      } catch {
        seaLayer.checked = false;
        landLayer.checked = false;
        status.textContent = '线路图层加载失败，请重新勾选';
      } finally {
        linksRequest = null;
      }
    }
    drawWorldMap(currentRoutes, activeRouteId);
  }

  seaLayer.onchange = landLayer.onchange = toggleLayers;
  search.oninput = search.onfocus = updateGraphSearch;
  search.onkeydown = (event) => {
    if (event.key === 'Escape') results.classList.add('hidden');
    if (event.key === 'Enter' && !results.classList.contains('hidden')) results.querySelector('button')?.click();
  };
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.graph-search')) results.classList.add('hidden');
  });
  document.getElementById('graph-type').onchange = () => {
    const filter = document.getElementById('graph-type').value;
    if (filter && !selectedGraphNode?.groups.includes(filter)) selectGraphNode(null);
    updateGraphSearch();
    drawWorldMap(currentRoutes, activeRouteId);
  };
  document.getElementById('close-graph-card').onclick = () => {
    selectGraphNode(null);
    search.focus();
  };
  for (const endpoint of ['from', 'to']) {
    document.getElementById(`graph-set-${endpoint}`).onclick = () => {
      if (!selectedGraphNode) return;
      const input = document.getElementById(`${endpoint}-input`);
      endpointPickers[endpoint].setNode(selectedGraphNode);
      setMapView(routeView);
      const panel = document.getElementById('map-panel');
      if (document.fullscreenElement === panel || panel.classList.contains('map-maximized')) {
        document.getElementById('fullscreen-btn').click();
        document.getElementById('route-view-btn').focus();
      } else {
        input.focus();
      }
    };
  }
}

function selectedModes() {
  return [...document.querySelectorAll('input[name="mode"]:checked')].map((el) => el.value);
}

function selectedAvoid() {
  return [...document.querySelectorAll('input[name="avoid"]:checked')].map((el) => el.value);
}

function selectRoute(routeId, leg = null, anchor = null) {
  activeRouteId = routeId;
  activeLeg = leg;
  cardAnchor = anchor;
  clearMapHover();

  const route = currentRoutes.find((r) => r.routeId === activeRouteId);
  cardOpen = Boolean(route);
  document.getElementById('fit-route-btn').disabled = !route;
  if (route) {
    document.getElementById('route-select').value = route.routeId;
    renderRouteCard(route, leg);
  }
  drawWorldMap(currentRoutes, activeRouteId);
}

function renderRouteCard(route, leg) {
  const byId = (id) => document.getElementById(id);
  const via = route.viaHub ? ` → ${route.viaHub.code || route.viaHub.name}` : '';
  const likelihood = route.likelihood === 'primary' ? '主要方案' : '备选方案';
  byId('card-mode').textContent = route.modeLabel;
  byId('card-likelihood').textContent = route.detourReason ? `${likelihood} · ${route.detourReason}` : likelihood;
  byId('card-gateways').textContent = `${route.originGateway.name} (${route.originGateway.id})${via} → ${route.destGateway.name} (${route.destGateway.id})`;
  byId('card-leg').textContent = leg ? legSummary(leg) : '';
  byId('card-leg').classList.toggle('hidden', !leg);
  byId('card-distance').textContent = `${route.metrics.distanceKm} km`;
  byId('card-time').textContent = `${route.metrics.transitDays} 天`;
  byId('card-cost').textContent = route.metrics.costIndex;

  const chips = route.chokepoints.map((cp) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = cp.name_zh;
    return chip;
  });
  if (route.deltaDays != null) {
    const delta = document.createElement('span');
    delta.className = 'chip delta';
    const sign = route.deltaDays >= 0 ? '+' : '';
    delta.textContent = `${sign}${route.deltaDays} 天 · ${route.costMultiplier}x 成本`;
    chips.push(delta);
  }
  byId('card-chips').replaceChildren(...chips);
  byId('card-chips').classList.toggle('hidden', !chips.length);

  const legs = route.legs.map((item) => {
    const row = document.createElement('li');
    row.textContent = legSummary(item);
    return row;
  });
  byId('card-leg-list').replaceChildren(...legs);
  byId('card-legs').open = false;
  byId('card-legs').classList.toggle('hidden', !legs.length);
  byId('map-route-card').scrollTop = 0;
}

function renderRoutes(routes, { compareData = null } = {}) {
  currentRoutes = routes;

  const banner = document.getElementById('impact-banner');
  if (compareData?.impactSummary) {
    const s = compareData.impactSummary;
    banner.classList.remove('hidden');
    banner.textContent = `对比结果：基线受影响路径 ${s.affectedBaselineRoutes}/${s.totalBaselineRoutes} 条 · 海运状态：${
      s.seaCutOff ? '已中断' : s.seaDetoured ? '触发绕行' : '未受阻'
    }（可用海运 ${s.survivingSeaCount} 条 · 最快替代 ${s.bestAlternativeDays ?? '—'} 天）`;
  } else {
    banner.classList.add('hidden');
  }

  const options = routes.map((route) => {
    const via = route.viaHub?.code || route.viaHub?.name;
    const distinguishingStops = via || route.chokepoints.map((cp) => cp.name_zh).join('、');
    const name = [route.modeLabel, distinguishingStops, `${route.metrics.transitDays} 天`].filter(Boolean).join(' · ');
    return new Option(name, route.routeId);
  });
  document.getElementById('route-select').replaceChildren(...options);
  document.getElementById('route-picker').classList.toggle('hidden', !options.length);

  document.querySelector('.map-stage').classList.remove('route-card-docked');
  if (view === routeView) fitRoutesToView(routes);
  else fitRoutesOnReturn = true;
  selectRoute(routes[0]?.routeId ?? null);
}

async function runQuery(isCompare = false) {
  setMapView(routeView);
  const from = endpointPickers.from.value;
  const to = endpointPickers.to.value;
  const summary = document.getElementById('route-summary');
  for (const picker of Object.values(endpointPickers)) picker.close();
  if (!from || !to) {
    summary.textContent = `请输入${!from ? '起运地' : '目的地'}`;
    document.getElementById(`${!from ? 'from' : 'to'}-input`).focus();
    return;
  }
  const modes = selectedModes();
  const avoid = selectedAvoid();

  const endpoint = isCompare ? '/v1/routes/compare' : '/v1/routes';
  let data;
  try {
    data = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, modes, avoid, maxRoutes: 8, includeGeometry: true }),
    });
  } catch (error) {
    if (error.message.startsWith('Unknown origin node:')) {
      summary.textContent = `未找到起运地「${from}」，可输入地点名并从候选中选择`;
    } else if (error.message.startsWith('Unknown destination node:')) {
      summary.textContent = `未找到目的地「${to}」，可输入地点名并从候选中选择`;
    } else {
      summary.textContent = `路径计算失败：${error.message}`;
    }
    return;
  }

  currentEndpoints = { origin: data.origin, destination: data.destination };

  const badge = document.getElementById('cache-badge');
  const c = data.meta?.cache;
  if (c) {
    badge.textContent = c.hit ? `缓存命中 (${c.layer})` : '实时计算已写入SQLite';
    badge.className = `cache-badge${c.hit ? ' hit' : ''}`;
  }

  const routes = isCompare ? [...(data.alternatives || []), ...(data.landSubstitutions || [])] : data.routes || [];
  summary.textContent = `${data.origin.name_zh} → ${data.destination.name_zh} · 共 ${routes.length} 条评估路径`;
  renderRoutes(routes, { compareData: isCompare ? data : null });
  refreshHealth();
}

async function refreshHealth() {
  const h = await fetchJson('/health');
  document.getElementById('health-badge').textContent =
    `图版本 ${h.graphVersion} · 节点 ${h.counts?.nodesTotal ?? '—'} · 缓存 ${h.cache.sqliteEntries} 条 (命中 Mem:${h.cache.memoryHits} / SQLite:${h.cache.sqliteHits})`;
}

async function init() {
  initTheme();
  initMapInteractions();
  initNodeGraph();
  clampView();

  fetchJson('/countries.geojson')
    .then((geo) => {
      worldGeo = geo;
      drawWorldMap(currentRoutes, activeRouteId);
    })
    .catch((err) => console.warn('Failed to load basemap:', err));

  const cpRes = await fetchJson('/v1/chokepoints');

  const cpList = document.getElementById('chokepoint-list');
  const sortedCps = [...cpRes.chokepoints].sort(
    (a, b) => Number(KEY_AVOID_IDS.has(b.id)) - Number(KEY_AVOID_IDS.has(a.id)) || b.affectedLaneCount - a.affectedLaneCount
  );
  for (const cp of sortedCps) {
    const row = document.createElement('div');
    row.className = 'cp-item';
    row.innerHTML = `
      <label><input type="checkbox" name="avoid" value="${cp.id}" /> ${cp.name_zh}</label>
      <span class="cp-count">${cp.affectedLaneCount} 线</span>
    `;
    cpList.appendChild(row);
  }

  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.onclick = () => {
      document.getElementById('from-input').value = btn.dataset.from;
      document.getElementById('to-input').value = btn.dataset.to;
      runQuery(false);
    };
  }

  document.getElementById('run-btn').onclick = () => runQuery(false);
  document.getElementById('compare-btn').onclick = () => runQuery(true);

  await runQuery(false);
}

const endpointPickers = Object.fromEntries(['from', 'to'].map((key) => [
  key,
  createEndpointPicker(document.getElementById(`${key}-input`), {
    fetchJson,
    describe: describeEndpoint,
    submit: () => runQuery(),
  }),
]));

init().catch((err) => {
  console.error(err);
  document.getElementById('route-summary').textContent = `初始化失败: ${err.message}`;
});
