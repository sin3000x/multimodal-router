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

// Interactive map viewport state
const view = { zoom: 1, centerLon: 0, centerLat: 0 };
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

function normLon(lon) {
  let n = ((lon + 180) % 360 + 360) % 360 - 180;
  if (n >= 180) n = -180;
  return n;
}

function clampView() {
  view.zoom = Math.max(1, Math.min(12, view.zoom));
  if (view.zoom <= 1.01) {
    view.zoom = 1;
    view.centerLon = 0;
    view.centerLat = 0;
  } else {
    view.centerLon = normLon(view.centerLon);
    const halfLat = 90 / view.zoom;
    view.centerLat = Math.max(-90 + halfLat, Math.min(90 - halfLat, view.centerLat));
  }
  const badge = document.getElementById('zoom-level');
  if (badge) badge.textContent = `${view.zoom.toFixed(1)}x`;
}

function projectRaw(lon, lat, width, height) {
  const x = width / 2 + (lon - view.centerLon) * (width / 360) * view.zoom;
  const y = height / 2 - (lat - view.centerLat) * (height / 180) * view.zoom;
  return [x, y];
}

function nearestCopyLon(lon) {
  const candidates = [lon - 360, lon, lon + 360];
  let best = lon;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - view.centerLon);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function unwrapCoords(coords) {
  if (!coords.length) return [];
  const out = [[coords[0][0], coords[0][1]]];
  for (let i = 1; i < coords.length; i++) {
    let lon = coords[i][0];
    const prevLon = out[i - 1][0];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    out.push([lon, coords[i][1]]);
  }
  return out;
}

function fitRouteToView(route) {
  if (!route) return;
  const rawPts = [];
  for (const leg of route.legs || []) {
    for (const pt of leg.geometry || []) rawPts.push(pt);
  }
  for (const wp of route.waypoints || []) rawPts.push([wp.lon, wp.lat]);
  if (!rawPts.length) return;

  // Choose the longitudinal span that avoids wrapping across the globe
  const sortedLons = [...new Set(rawPts.map((p) => normLon(p[0])))].sort((a, b) => a - b);
  let maxGap = -1;
  let gapStartIdx = 0;
  for (let i = 0; i < sortedLons.length; i++) {
    const next = i + 1 < sortedLons.length ? sortedLons[i + 1] : sortedLons[0] + 360;
    const gap = next - sortedLons[i];
    if (gap > maxGap) {
      maxGap = gap;
      gapStartIdx = i;
    }
  }
  const minLon = sortedLons[(gapStartIdx + 1) % sortedLons.length];
  let maxLon = sortedLons[gapStartIdx];
  if (maxLon < minLon) maxLon += 360;
  const lonSpan = sortedLons.length === 1 ? 10 : Math.max(10, maxLon - minLon);

  const lats = rawPts.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const latSpan = Math.max(8, maxLat - minLat);

  view.centerLon = normLon((minLon + maxLon) / 2);
  view.centerLat = (minLat + maxLat) / 2;
  const zx = 310 / lonSpan;
  const zy = 145 / latSpan;
  view.zoom = Math.max(1.2, Math.min(7.5, Math.min(zx, zy)));
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
    ctx.arc(x, y, isHovered ? 7 : 5.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (wp.role === 'chokepoint' || wp.role === 'border' || wp.role === 'hub') {
    const r = isHovered ? 6 : 4.5;
    ctx.fillStyle = wp.role === 'chokepoint' ? '#f59e0b' : '#10b981';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
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
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(x, y, isHovered ? 5.5 : 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawWaypointLabels(ctx, items, tokens) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const placed = [];

  const priority = { origin: 0, destination: 0, chokepoint: 1, border: 2, gateway: 3, hub: 4 };
  const sorted = [...items].sort(
    (a, b) => (priority[a.wp.role] ?? 5) - (priority[b.wp.role] ?? 5)
  );

  ctx.save();
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';

  for (const item of sorted) {
    const { wp, x, y } = item;
    if (x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;

    const showCode = wp.role === 'origin' || wp.role === 'destination' || (wp.role === 'gateway' && view.zoom >= 1.8);
    const label = showCode && wp.id !== wp.name_zh ? `${wp.name_zh} (${wp.id})` : wp.name_zh;
    const textW = ctx.measureText(label).width;
    const padX = 6;
    const boxW = textW + padX * 2;
    const boxH = 20;

    const offsets = [
      [10, -boxH / 2],
      [-boxW - 10, -boxH / 2],
      [-boxW / 2, -boxH - 10],
      [-boxW / 2, 10],
    ];

    let chosen = null;
    for (const [dx, dy] of offsets) {
      const box = { x: x + dx, y: y + dy, w: boxW, h: boxH };
      if (box.x < 4 || box.x + box.w > w - 4 || box.y < 4 || box.y + box.h > h - 4) continue;
      if (!placed.some((p) => boxesOverlap(box, p, 4))) {
        chosen = box;
        break;
      }
    }

    if (!chosen && (wp.role === 'origin' || wp.role === 'destination')) {
      chosen = {
        x: Math.max(4, Math.min(w - boxW - 4, x + 10)),
        y: Math.max(4, Math.min(h - boxH - 4, y - boxH / 2)),
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
  const canvas = document.getElementById('world-map');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const tokens = getCssTokens();

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = tokens.ocean;
  ctx.fillRect(0, 0, w, h);

  // Graticule across wrapped world copies
  ctx.strokeStyle = tokens.grid;
  ctx.lineWidth = 1;
  for (const offset of [-360, 0, 360]) {
    for (let lon = -150; lon <= 150; lon += 30) {
      const [x] = projectRaw(lon + offset, 0, w, h);
      if (x < 0 || x > w) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = projectRaw(0, lat, w, h);
    if (y < 0 || y > h) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Land polygons (drawn at -360, 0, +360 so panning/crossing antimeridian never tears coastlines)
  if (worldGeo?.features) {
    ctx.fillStyle = tokens.land;
    ctx.strokeStyle = tokens.coast;
    ctx.lineWidth = 0.9;
    for (const offset of [-360, 0, 360]) {
      const [leftX] = projectRaw(offset - 180, 0, w, h);
      const [rightX] = projectRaw(offset + 180, 0, w, h);
      if (rightX < 0 || leftX > w) continue;

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
            const [x, y] = projectRaw(pt[0] + offset, pt[1], w, h);
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
    ctx.globalAlpha = isDimmed ? 0.22 : isSelected ? 0.98 : 0.8;
    ctx.lineWidth = isSelected ? 3.2 : 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (route.mode === 'air') ctx.setLineDash([7, 5]);
    else if (route.mode === 'rail') ctx.setLineDash([3, 4]);

    for (const leg of route.legs || []) {
      const unwrapped = unwrapCoords(leg.geometry || []);
      if (unwrapped.length < 2) continue;
      const midLon = unwrapped[Math.floor(unwrapped.length / 2)][0];
      const baseShift = nearestCopyLon(midLon) - midLon;

      for (const extraShift of [baseShift - 360, baseShift, baseShift + 360]) {
        ctx.beginPath();
        for (let i = 0; i < unwrapped.length; i++) {
          const [x, y] = projectRaw(unwrapped[i][0] + extraShift, unwrapped[i][1], w, h);
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
    const lonCopy = nearestCopyLon(wp.lon);
    const [x, y] = projectRaw(lonCopy, wp.lat, w, h);
    renderedMarkers.push({ wp, x, y });
    drawWaypointMarker(ctx, wp, x, y, activeColor, wp.id === hoveredWaypointId);
  }
  drawWaypointLabels(ctx, renderedMarkers, tokens);
}

function initMapInteractions() {
  const canvas = document.getElementById('world-map');
  const tooltip = document.getElementById('map-tooltip');
  if (!canvas) return;

  let dragging = false;
  let dragStart = null;

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      cx: ((e.clientX - rect.left) / rect.width) * canvas.width,
      cy: ((e.clientY - rect.top) / rect.height) * canvas.height,
      cssX: e.clientX - rect.left,
      cssY: e.clientY - rect.top,
    };
  }

  function zoomAt(factor, cx, cy) {
    const oldZoom = view.zoom;
    const lonUnder = view.centerLon + ((cx - canvas.width / 2) / (canvas.width * oldZoom)) * 360;
    const latUnder = view.centerLat - ((cy - canvas.height / 2) / (canvas.height * oldZoom)) * 180;

    view.zoom = Math.max(1, Math.min(12, oldZoom * factor));
    view.centerLon = lonUnder - ((cx - canvas.width / 2) / (canvas.width * view.zoom)) * 360;
    view.centerLat = latUnder + ((cy - canvas.height / 2) / (canvas.height * view.zoom)) * 180;
    clampView();
    drawWorldMap(currentRoutes, activeRouteId);
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { cx, cy } = canvasPoint(e);
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      zoomAt(factor, cx, cy);
    },
    { passive: false }
  );

  canvas.addEventListener('dblclick', (e) => {
    const { cx, cy } = canvasPoint(e);
    zoomAt(1.6, cx, cy);
  });

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    canvas.classList.add('dragging');
    dragStart = {
      x: e.clientX,
      y: e.clientY,
      centerLon: view.centerLon,
      centerLat: view.centerLat,
    };
  });

  window.addEventListener('mousemove', (e) => {
    if (dragging && dragStart) {
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      view.centerLon = dragStart.centerLon - (dx / (rect.width * view.zoom)) * 360;
      view.centerLat = dragStart.centerLat + (dy / (rect.height * view.zoom)) * 180;
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

    const { cx, cy, cssX, cssY } = canvasPoint(e);
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
      tooltip.style.left = `${Math.min(canvas.clientWidth - 180, Math.max(8, cssX + 12))}px`;
      tooltip.style.top = `${Math.max(8, cssY - 28)}px`;
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

  document.getElementById('zoom-in-btn').onclick = () =>
    zoomAt(1.5, canvas.width / 2, canvas.height / 2);
  document.getElementById('zoom-out-btn').onclick = () =>
    zoomAt(1 / 1.5, canvas.width / 2, canvas.height / 2);
  document.getElementById('fit-route-btn').onclick = () => {
    const active = currentRoutes.find((r) => r.routeId === activeRouteId) ?? currentRoutes[0];
    fitRouteToView(active);
  };
  document.getElementById('reset-zoom-btn').onclick = () => {
    view.zoom = 1;
    view.centerLon = 0;
    view.centerLat = 0;
    clampView();
    drawWorldMap(currentRoutes, activeRouteId);
  };
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
