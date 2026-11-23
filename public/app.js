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

const THEME_KEY = 'mmr-theme';

let worldGeo = null;
let currentRoutes = [];
let currentEndpoints = { origin: null, destination: null };
let activeRouteId = null;

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
let hoveredWaypointId = null;

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
  const cssW = Math.max(300, Math.round(canvas.clientWidth || 900));
  const cssH = Math.max(260, Math.round(canvas.clientHeight || 440));
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

function clampView() {
  view.zoom = Math.max(1, Math.min(12, view.zoom));
  view.centerMx = wrapUnit(view.centerMx);
  const m = getCanvasMetrics();
  const aspectRatio = m ? m.cssH / m.cssW : 0.48;
  const halfMySpan = Math.min(0.49, (aspectRatio / view.zoom) * 0.5);
  const minMy = Math.max(latToMy(82), halfMySpan * 0.7);
  const maxMy = Math.min(latToMy(-76), 1 - halfMySpan * 0.7);
  if (view.zoom <= 1.01) {
    view.zoom = 1;
    view.centerMx = 0.5;
    view.centerMy = Math.max(minMy, Math.min(maxMy, DEFAULT_CENTER_MY));
  } else {
    view.centerMy = Math.max(minMy, Math.min(maxMy, view.centerMy));
  }
  const badge = document.getElementById('zoom-level');
  if (badge) badge.textContent = `${view.zoom.toFixed(1)}x`;
}

function projectRaw(mx, my, cssW, cssH) {
  const worldPx = cssW * view.zoom;
  const x = cssW / 2 + (mx - view.centerMx) * worldPx;
  const y = cssH / 2 + (my - view.centerMy) * worldPx;
  return [x, y];
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

function fitRouteToView(route) {
  if (!route) return;
  const m = getCanvasMetrics();
  if (!m) return;

  const rawPts = [];
  for (const leg of route.legs || []) {
    for (const pt of leg.geometry || []) rawPts.push(pt);
  }
  for (const wp of route.waypoints || []) rawPts.push([wp.lon, wp.lat]);
  if (!rawPts.length) return;

  const sortedMxs = [...new Set(rawPts.map((p) => +lonToMx(p[0]).toFixed(5)))].sort((a, b) => a - b);
  let maxGap = -1;
  let gapStartIdx = 0;
  for (let i = 0; i < sortedMxs.length; i++) {
    const next = i + 1 < sortedMxs.length ? sortedMxs[i + 1] : sortedMxs[0] + 1;
    const gap = next - sortedMxs[i];
    if (gap > maxGap) {
      maxGap = gap;
      gapStartIdx = i;
    }
  }
  const minMx = sortedMxs[(gapStartIdx + 1) % sortedMxs.length];
  let maxMx = sortedMxs[gapStartIdx];
  if (maxMx < minMx) maxMx += 1;
  const mxSpan = sortedMxs.length === 1 ? 0.04 : Math.max(0.04, maxMx - minMx);

  const mys = rawPts.map((p) => latToMy(p[1]));
  const minMy = Math.min(...mys);
  const maxMy = Math.max(...mys);
  const mySpan = Math.max(0.03, maxMy - minMy);

  view.centerMx = wrapUnit((minMx + maxMx) / 2);
  view.centerMy = (minMy + maxMy) / 2;

  const aspect = m.cssH / m.cssW;
  const zx = 0.8 / mxSpan;
  const zy = (0.76 * aspect) / mySpan;
  view.zoom = Math.max(1.1, Math.min(9.0, Math.min(zx, zy)));
  clampView();
  drawWorldMap(currentRoutes, activeRouteId);
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
  for (const mxOffset of [-1, 0, 1]) {
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

  // Land polygons in Web Mercator (drawn at mxOffset -1, 0, +1 for seamless panning & antimeridian)
  if (worldGeo?.features) {
    ctx.fillStyle = tokens.land;
    ctx.strokeStyle = tokens.coast;
    ctx.lineWidth = 0.8;
    for (const mxOffset of [-1, 0, 1]) {
      const [leftX] = projectRaw(mxOffset, 0.5, cssW, cssH);
      const [rightX] = projectRaw(mxOffset + 1, 0.5, cssW, cssH);
      if (rightX < 0 || leftX > cssW) continue;

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

  // Draw non-selected routes first, then highlighted route on top
  const ordered = [...routes].sort((a, b) =>
    a.routeId === highlightedId ? 1 : b.routeId === highlightedId ? -1 : 0
  );

  for (const route of ordered) {
    const isSelected = highlightedId === route.routeId;
    const isDimmed = Boolean(highlightedId) && !isSelected;
    const color = tokens.modes[route.mode] || tokens.modes.sea;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = isDimmed ? 0.24 : isSelected ? 0.98 : 0.8;
    ctx.lineWidth = isSelected ? 2.8 : 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (route.mode === 'air') ctx.setLineDash([6, 4]);
    else if (route.mode === 'rail') ctx.setLineDash([3, 3.5]);

    for (const leg of route.legs || []) {
      const unwrapped = unwrapMxs(leg.geometry || []);
      if (unwrapped.length < 2) continue;
      const midMx = unwrapped[Math.floor(unwrapped.length / 2)][0];
      const baseShift = nearestCopyMx(midMx) - midMx;

      for (const extraShift of [baseShift - 1, baseShift, baseShift + 1]) {
        ctx.beginPath();
        for (let i = 0; i < unwrapped.length; i++) {
          const [x, y] = projectRaw(unwrapped[i][0] + extraShift, unwrapped[i][1], cssW, cssH);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
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

function initMapInteractions() {
  const canvas = document.getElementById('world-map');
  const tooltip = document.getElementById('map-tooltip');
  if (!canvas) return;

  let dragging = false;
  let dragStart = null;

  function cssPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
      cssW: rect.width,
      cssH: rect.height,
    };
  }

  function zoomAt(factor, cx, cy) {
    const m = getCanvasMetrics();
    if (!m) return;
    const oldWorldPx = m.cssW * view.zoom;
    const mxUnder = view.centerMx + (cx - m.cssW / 2) / oldWorldPx;
    const myUnder = view.centerMy + (cy - m.cssH / 2) / oldWorldPx;

    view.zoom = Math.max(1, Math.min(12, view.zoom * factor));
    const newWorldPx = m.cssW * view.zoom;
    view.centerMx = mxUnder - (cx - m.cssW / 2) / newWorldPx;
    view.centerMy = myUnder - (cy - m.cssH / 2) / newWorldPx;
    clampView();
    drawWorldMap(currentRoutes, activeRouteId);
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { cx, cy } = cssPoint(e);
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      zoomAt(factor, cx, cy);
    },
    { passive: false }
  );

  canvas.addEventListener('dblclick', (e) => {
    const { cx, cy } = cssPoint(e);
    zoomAt(1.6, cx, cy);
  });

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    canvas.classList.add('dragging');
    dragStart = {
      x: e.clientX,
      y: e.clientY,
      centerMx: view.centerMx,
      centerMy: view.centerMy,
    };
  });

  window.addEventListener('mousemove', (e) => {
    if (dragging && dragStart) {
      const m = getCanvasMetrics();
      if (!m) return;
      const worldPx = m.cssW * view.zoom;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      view.centerMx = dragStart.centerMx - dx / worldPx;
      view.centerMy = dragStart.centerMy - dy / worldPx;
      clampView();
      drawWorldMap(currentRoutes, activeRouteId);
      return;
    }

    if (e.target !== canvas) {
      if (hoveredWaypointId) {
        hoveredWaypointId = null;
        tooltip?.classList.add('hidden');
        drawWorldMap(currentRoutes, activeRouteId);
      }
      return;
    }

    const { cx, cy, cssW } = cssPoint(e);
    let nearest = null;
    let bestDist = 14;
    for (const item of renderedMarkers) {
      const d = Math.hypot(item.x - cx, item.y - cy);
      if (d < bestDist) {
        bestDist = d;
        nearest = item;
      }
    }

    const nextId = nearest?.wp.id ?? null;
    if (nextId !== hoveredWaypointId) {
      hoveredWaypointId = nextId;
      drawWorldMap(currentRoutes, activeRouteId);
    }

    if (nearest && tooltip) {
      const roleText = ROLE_LABELS[nearest.wp.role] || nearest.wp.type;
      tooltip.textContent = `${nearest.wp.name_zh} (${nearest.wp.id}) · ${roleText}`;
      tooltip.style.left = `${Math.min(cssW - 180, Math.max(8, cx + 12))}px`;
      tooltip.style.top = `${Math.max(8, cy - 28)}px`;
      tooltip.classList.remove('hidden');
      canvas.style.cursor = 'pointer';
    } else if (tooltip) {
      tooltip.classList.add('hidden');
      canvas.style.cursor = '';
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dragStart = null;
    canvas.classList.remove('dragging');
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
    const active = currentRoutes.find((r) => r.routeId === activeRouteId) ?? currentRoutes[0];
    fitRouteToView(active);
  };
  document.getElementById('reset-zoom-btn').onclick = () => {
    view.zoom = 1;
    view.centerMx = 0.5;
    view.centerMy = DEFAULT_CENTER_MY;
    clampView();
    drawWorldMap(currentRoutes, activeRouteId);
  };

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      clampView();
      drawWorldMap(currentRoutes, activeRouteId);
    });
    observer.observe(canvas);
  }
  window.addEventListener('resize', () => {
    clampView();
    drawWorldMap(currentRoutes, activeRouteId);
  });
}

function selectedModes() {
  return [...document.querySelectorAll('input[name="mode"]:checked')].map((el) => el.value);
}

function selectedAvoid() {
  return [...document.querySelectorAll('input[name="avoid"]:checked')].map((el) => el.value);
}

function renderRoutes(routes, { compareData = null } = {}) {
  currentRoutes = routes;
  activeRouteId = routes[0]?.routeId ?? null;

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
    card.className = `route-card${r.routeId === activeRouteId ? ' active' : ''}`;
    card.onclick = () => {
      activeRouteId = r.routeId;
      for (const el of document.querySelectorAll('.route-card')) el.classList.remove('active');
      card.classList.add('active');
      drawWorldMap(currentRoutes, activeRouteId);
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

  drawWorldMap(currentRoutes, activeRouteId);
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
