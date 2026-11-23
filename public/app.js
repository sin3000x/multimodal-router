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
const THEME_KEY = 'mmr-theme';

let worldGeo = null;
let currentRoutes = [];
let currentEndpoints = { origin: null, destination: null };
let activeRouteId = null;
let activeLeg = null;

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
const view = { zoom: 1, centerMx: 0.5, centerMy: DEFAULT_CENTER_MY };
let renderedMarkers = [];
let renderedLegs = [];
let hoveredWaypointId = null;
let hoveredLeg = null;

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

    const showCode =
      wp.role === 'origin' ||
      wp.role === 'destination' ||
      (wp.role === 'gateway' && view.zoom >= 1.8);
    const label = showCode && wp.id !== wp.name_zh ? `${wp.name_zh} (${wp.id})` : wp.name_zh;
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
}

function pointToSegmentDistanceSquared(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
}

function mapTargetAt(x, y, pointerType) {
  const radius = pointerType === 'touch' ? 18 : 10;
  let marker = null;
  let bestDistance = radius ** 2;
  for (const item of renderedMarkers) {
    const distance = (item.x - x) ** 2 + (item.y - y) ** 2;
    if (distance < bestDistance) {
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
      const distance = pointToSegmentDistanceSquared(x, y, item.points[j - 1], item.points[j]);
      if (distance < bestDistance) {
        bestDistance = distance;
        target = item;
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
  let gesture = null;

  function cssPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left - canvas.clientLeft, y: e.clientY - rect.top - canvas.clientTop };
  }

  function showMapTarget(target, x, y, preview = true) {
    const waypoint = target?.wp;
    const nextWaypointId = waypoint?.id ?? null;
    const nextLeg = preview && target?.leg ? target : null;
    const changed = hoveredWaypointId !== nextWaypointId || hoveredLeg?.leg !== nextLeg?.leg;
    hoveredWaypointId = nextWaypointId;
    hoveredLeg = nextLeg;
    if (changed) drawWorldMap(currentRoutes, activeRouteId);

    canvas.classList.toggle('map-target', Boolean(target));
    tooltip.classList.toggle('hidden', !target);
    if (!target) return;

    tooltip.textContent = waypoint
      ? `${waypoint.name_zh} (${waypoint.id}) · ${ROLE_LABELS[waypoint.role] || waypoint.type}`
      : legSummary(target.leg);
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
    const { x, y } = cssPoint(e);
    zoomAt(e.deltaY < 0 ? 1.25 : 0.8, x, y);
  }, { passive: false });

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
    if (target?.leg) selectRoute(target.route.routeId, target.leg);
    else if (!target && activeLeg) selectRoute(activeRouteId);
    showMapTarget(target?.wp || e.pointerType !== 'touch' ? target : null, x, y, false);
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
  document.getElementById('fit-route-btn').onclick = () => {
    const active = currentRoutes.find((r) => r.routeId === activeRouteId);
    if (!active) return;
    fitRoutesToView([active]);
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  };
  document.getElementById('reset-zoom-btn').onclick = () => {
    view.zoom = 1;
    view.centerMx = 0.5;
    view.centerMy = DEFAULT_CENTER_MY;
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  };

  function resizeMap() {
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  }
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(resizeMap);
    observer.observe(canvas);
  } else {
    window.addEventListener('resize', resizeMap);
  }
}

function selectedModes() {
  return [...document.querySelectorAll('input[name="mode"]:checked')].map((el) => el.value);
}

function selectedAvoid() {
  return [...document.querySelectorAll('input[name="avoid"]:checked')].map((el) => el.value);
}

function selectRoute(routeId, leg = null) {
  activeRouteId = routeId;
  activeLeg = leg;
  clearMapHover();
  for (const card of document.querySelectorAll('.route-card')) {
    const selected = card.dataset.routeId === activeRouteId;
    card.classList.toggle('active', selected);
    card.setAttribute('aria-pressed', String(selected));
  }

  const route = currentRoutes.find((r) => r.routeId === activeRouteId);
  const selection = document.getElementById('map-selection');
  selection.classList.toggle('hidden', !route);
  document.getElementById('fit-route-btn').disabled = !route;
  document.getElementById('map-selection-text').textContent = leg
    ? legSummary(leg)
    : route
      ? `${route.modeLabel} · ${route.originGateway.name} → ${route.destGateway.name} · ${route.metrics.distanceKm} km · ${route.metrics.transitDays} 天`
      : '';
  drawWorldMap(currentRoutes, activeRouteId);
}

function renderRoutes(routes, { compareData = null } = {}) {
  currentRoutes = routes;

  const grid = document.getElementById('routes-grid');
  grid.innerHTML = '';

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

  for (const r of routes) {
    const card = document.createElement('div');
    card.className = 'route-card';
    card.dataset.routeId = r.routeId;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.onclick = () => selectRoute(r.routeId);
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    };

    const via = r.viaHub ? ` → ${r.viaHub.code || r.viaHub.name}` : '';
    const cpHtml = r.chokepoints.length
      ? r.chokepoints.map((c) => `<span class="chip">${c.name_zh}</span>`).join('')
      : '<span class="chip">无关键咽喉</span>';
    const deltaHtml =
      r.deltaDays != null
        ? `<span class="chip delta">${r.deltaDays >= 0 ? '+' : ''}${r.deltaDays}天 · ${r.costMultiplier}x成本</span>`
        : '';

    const legsHtml = r.legs
      .map((l) => `<div>${l.mode.toUpperCase()} · ${l.fromName} → ${l.toName} (${l.distanceKm} km)</div>`)
      .join('');

    card.innerHTML = `
      <div class="card-head">
        <span class="mode-tag mode-${r.mode}">${r.modeLabel}</span>
        <span class="likelihood">${r.likelihood === 'primary' ? '主要方案' : '备选方案'}${r.detourReason ? ' · ' + r.detourReason : ''}</span>
      </div>
      <div class="gateways">${r.originGateway.name} (${r.originGateway.id})${via} → ${r.destGateway.name} (${r.destGateway.id})</div>
      <div class="metrics">
        <div class="metric"><span>总里程</span><strong>${r.metrics.distanceKm} km</strong></div>
        <div class="metric"><span>预计时效</span><strong>${r.metrics.transitDays} 天</strong></div>
        <div class="metric"><span>成本指数</span><strong>${r.metrics.costIndex}</strong></div>
      </div>
      <div class="cp-chips">${cpHtml}${deltaHtml}</div>
      <div class="legs">${legsHtml}</div>
    `;
    grid.appendChild(card);
  }

  fitRoutesToView(routes);
  selectRoute(routes[0]?.routeId ?? null);
}

async function runQuery(isCompare = false) {
  const from = document.getElementById('from-input').value.trim();
  const to = document.getElementById('to-input').value.trim();
  const modes = selectedModes();
  const avoid = selectedAvoid();

  const endpoint = isCompare ? '/v1/routes/compare' : '/v1/routes';
  const data = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, modes, avoid, maxRoutes: 8, includeGeometry: true }),
  });

  currentEndpoints = { origin: data.origin, destination: data.destination };

  const badge = document.getElementById('cache-badge');
  const c = data.meta?.cache;
  if (c) {
    badge.textContent = c.hit ? `缓存命中 (${c.layer})` : '实时计算已写入SQLite';
    badge.className = `cache-badge${c.hit ? ' hit' : ''}`;
  }

  const routes = isCompare ? [...(data.alternatives || []), ...(data.landSubstitutions || [])] : data.routes || [];
  document.getElementById('route-summary').textContent = `${data.origin.name_zh} → ${data.destination.name_zh} · 共 ${routes.length} 条评估路径`;
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
  clampView();

  fetchJson('/countries.geojson')
    .then((geo) => {
      worldGeo = geo;
      drawWorldMap(currentRoutes, activeRouteId);
    })
    .catch((err) => console.warn('Failed to load basemap:', err));

  const [nodesRes, cpRes] = await Promise.all([
    fetchJson('/v1/nodes?limit=100'),
    fetchJson('/v1/chokepoints'),
  ]);

  const datalist = document.getElementById('node-options');
  for (const n of nodesRes.nodes) {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.label = `${n.name_zh} / ${n.name_en}${n.code ? ' (' + n.code + ')' : ''}`;
    datalist.appendChild(opt);
  }

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

init().catch((err) => {
  console.error(err);
  document.getElementById('route-summary').textContent = `初始化失败: ${err.message}`;
});
