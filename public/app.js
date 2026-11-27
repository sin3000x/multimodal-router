import { createEndpointPicker } from './endpoint-picker.js';
import { initApiCatalog } from './api-catalog.js';
import {
  buildCompareModel,
  COMPARE_ROLE_META,
  formatKm,
  formatDeltaDays,
  formatDeltaKm,
  formatCostMultiplier,
} from './compare-model.js';
import { GRAPH_MAX_ZOOM, GRAPH_ZOOM_INPUT, ROUTE_MAX_ZOOM, getLegStrokeStyle } from './map-config.js';

const KEY_AVOID_IDS = new Set([
  'CP_SUEZ',
  'CP_BAB',
  'CP_HORMUZ',
  'CP_MALACCA',
  'CP_PANAMA',
  'CP_CAPE',
  'AS_RUSSIA',
  'AS_MIDEAST',
  'AS_GULF',
]);

const ROLE_LABELS = {
  origin: '起运地',
  destination: '目的地',
  gateway: '口岸/机场',
  chokepoint: '咽喉/空域',
  border: '陆路口岸',
  hub: '中转枢纽',
};

const MODE_LABELS = { sea: '海运', air: '空运', rail: '铁路', road: '公路', local: '本地接驳', fir: 'FIR空域' };
const NODE_GROUPS = {
  port: { label: '港口', color: 'sea' },
  airport: { label: '机场', color: 'air' },
  city: { label: '城市', color: 'city' },
  land: { label: '陆铁枢纽', color: 'rail' },
  roadBorder: { label: '公路口岸', color: 'road' },
  railBorder: { label: '铁路口岸', color: 'rail' },
  passage: { label: '咽喉与空域', color: 'road' },
};
const GATEWAY_LABELS = { water: '水运口岸', air: '航空口岸', land: '陆路口岸' };
const NODE_SHORT_NAMES = { HKG: '香港机场', PVG: '上海浦东机场' };
const THEME_KEY = 'mmr-theme';
const GRAPH_DETAIL_ZOOM = 8;
const ROUTE_ZOOM_INPUT = {
  wheelSensitivity: 0.0016,
  pinchWheelSensitivity: 0.0045,
  maxWheelStep: 0.16,
  pinchExponent: 0.72,
  buttonFactor: 1.5,
  doubleClickFactor: 1.6,
};

let worldGeo = null;
let currentRoutes = [];
let currentEndpoints = { origin: null, destination: null };
let activeRouteId = null;
let activeLeg = null;
let cardAnchor = null;
let cardOpen = false;
let routeCardPosition = null;
const avoidNodes = new Map();
let avoidPicker;
let querySequence = 0;
let compareModel = null;
let compareTab = 'summary';
let compareLayer = 'both';
let compareCollapsed = false;

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
let graphNodeById = new Map();
let graphLinks = { sea: null, land: null, road: null, air: null, fir: null };
let graphLinkCounts = null;
let graphAirByNode = new Map();
let graphLandByNode = new Map();
let nodesRequest = null;
let graphNodeCatalogRequest;
let graphLinkRequests = {};
let selectedGraphNode = null;
let graphMarkerCache = null;
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
  if (node.type === 'border') return ['roadBorder'];
  if (node.type === 'rail_border') return ['railBorder'];
  if (node.type === 'ferry_port') return ['port'];
  const groups = ['city', 'port'].filter((type) => node.type === type || node.functions?.includes(type));
  if (!['city', 'port'].includes(node.type)) groups.push('land');
  return groups;
}

function matchesGraphFilter(node, filter) {
  if (!filter) return true;
  if (filter === 'gateway') return Boolean(node.gatewayType);
  if (filter.startsWith('gateway-')) return filter === `gateway-${node.gatewayType}`;
  return node.groups.includes(filter);
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
    baseline: get('--compare-baseline', '#dc2626'),
    danger: get('--danger', '#dc2626'),
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
  const maxZoom = view === graphView ? GRAPH_MAX_ZOOM : ROUTE_MAX_ZOOM;
  return Math.max(Math.min(0.8, 0.76 * aspect), Math.min(maxZoom, zoom));
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

function drawWaypointMarker(ctx, wp, x, y, modeColor, isHovered, isBlocked = false) {
  ctx.save();
  if (isHovered) {
    ctx.fillStyle = isBlocked ? 'rgba(220, 38, 38, 0.22)' : 'rgba(2, 132, 199, 0.22)';
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  }

  if (isBlocked) {
    const r = isHovered ? 7.5 : 6;
    ctx.fillStyle = '#dc2626';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const c = 2.6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - c, y - c);
    ctx.lineTo(x + c, y + c);
    ctx.moveTo(x + c, y - c);
    ctx.lineTo(x - c, y + c);
    ctx.stroke();
    ctx.restore();
    return;
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

function placeGraphLabel(item, boxW, boxH, width, height, placed, markerBoxes) {
  const { x, y } = item;
  const gap = 12;
  const right = x + gap;
  const left = x - gap - boxW;
  const center = x - boxW / 2;
  const middle = y - boxH / 2;
  const positions = [[right, middle], [left, middle], [center, y - gap - boxH], [center, y + gap]];

  // At close range, stack callouts when several nodes share the same coordinates.
  if (view.zoom >= GRAPH_DETAIL_ZOOM * 4) {
    for (let row = 1; row <= 4; row++) {
      const offset = row * (boxH + 5);
      positions.push([right, middle - offset], [right, middle + offset],
        [left, middle - offset], [left, middle + offset]);
    }
  }

  for (const [px, py] of positions) {
    const box = {
      x: Math.max(4, Math.min(width - boxW - 4, px)),
      y: Math.max(4, Math.min(height - boxH - 4, py)),
      w: boxW,
      h: boxH,
    };
    if (!markerBoxes.some((marker) => boxesOverlap(box, marker, 1)) &&
        !placed.some((label) => boxesOverlap(box, label, 4))) return box;
  }
  return null;
}

function drawWaypointLeader(ctx, { x, y }, box, radius, color) {
  const edgeX = Math.max(box.x, Math.min(box.x + box.w, x));
  const edgeY = Math.max(box.y, Math.min(box.y + box.h, y));
  const distance = Math.hypot(edgeX - x, edgeY - y);
  if (distance <= radius) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + (edgeX - x) * radius / distance, y + (edgeY - y) * radius / distance);
  ctx.lineTo(edgeX, edgeY);
  ctx.stroke();
}

function drawWaypointLabels(ctx, items, tokens, cssW, cssH, graph = false) {
  const placed = [];
  const labels = [];
  // Allow room for highlighted dots without moving their labels when hovered.
  const markerBoxes = graph ? items.map(({ x, y }) => ({ x: x - 7, y: y - 7, w: 14, h: 14 })) : [];
  const priority = { origin: 0, destination: 0, chokepoint: 1, border: 2, gateway: 3, hub: 4 };
  const sorted = graph ? items : [...items].sort(
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

    let chosen = graph ? placeGraphLabel(item, boxW, boxH, cssW, cssH, placed, markerBoxes) : null;
    if (!graph) {
      for (const [dx, dy] of offsets) {
        const box = { x: x + dx, y: y + dy, w: boxW, h: boxH };
        if (box.x < 4 || box.x + box.w > cssW - 4 || box.y < 4 || box.y + box.h > cssH - 4) continue;
        if (!placed.some((p) => boxesOverlap(box, p, 4))) {
          chosen = box;
          break;
        }
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
    labels.push({ wp, label, box: chosen, padX });
    if (graph) {
      item.labelBox = chosen;
      drawWaypointLeader(ctx, item, chosen, item.radius, tokens.coast);
    }
  }

  for (const { wp, label, box, padX } of labels) {
    ctx.fillStyle = tokens.labelBg;
    ctx.strokeStyle = wp.id === hoveredWaypointId ? tokens.modes.sea : tokens.labelBorder;
    ctx.lineWidth = wp.id === hoveredWaypointId ? 1.5 : 1;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = tokens.labelText;
    ctx.fillText(label, box.x + padX, box.y + box.h / 2 + 0.5);
  }
  ctx.restore();
}

function drawRouteWaypointLabels(ctx, tokens, width, height) {
  const controls = document.querySelector('.map-controls');
  const card = document.getElementById('map-route-card');
  const boxes = [controls, card].filter((element) => element.offsetWidth).map((element) => ({
    x: element.offsetLeft, y: element.offsetTop, w: element.offsetWidth, h: element.offsetHeight,
  }));
  for (const { x, y } of renderedMarkers) {
    boxes.push({ x: x - 12, y: y - 12, w: 24, h: 24 });
  }

  const endpointsFirst = ({ wp }) => Number(wp.role === 'origin' || wp.role === 'destination');
  const markers = [...renderedMarkers].sort((a, b) => endpointsFirst(b) - endpointsFirst(a));
  ctx.save();
  ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.fillStyle = tokens.labelText;

  for (const marker of markers) {
    const { wp, x, y } = marker;
    if (x < 0 || x > width || y < 0 || y > height) continue;

    const label = nodeLabel(wp);
    const w = Math.ceil(ctx.measureText(label).width) + 6;
    const h = 16;
    const center = Math.max(4, Math.min(width - w - 4, x - w / 2));
    const middle = y - h / 2;
    const positions = [16, 28, 44, 64].flatMap((gap) => {
      const right = x + gap;
      const left = x - gap - w;
      const top = y - gap - h;
      const bottom = y + gap;
      return [
        [right, middle], [left, middle], [center, top], [center, bottom],
        [right, top], [left, top], [right, bottom], [left, bottom],
      ];
    });
    const box = positions.map(([x, y]) => ({ x, y, w, h })).find((candidate) =>
      candidate.x >= 4 && candidate.y >= 4 && candidate.x + w <= width - 4 &&
      candidate.y + h <= height - 4 && !boxes.some((box) => boxesOverlap(candidate, box, 2)) &&
      !routesIntersectBox(candidate.x, candidate.y, w, h, 6)
    );

    if (!box) continue;

    boxes.push(box);
    marker.labelBox = box;
    drawWaypointLeader(ctx, marker, box, marker.radius, tokens.coast);
    ctx.strokeStyle = tokens.labelBg;
    ctx.lineWidth = 2.5;
    ctx.strokeText(label, box.x + 3, box.y + h / 2);
    ctx.fillText(label, box.x + 3, box.y + h / 2);
  }
  ctx.restore();
}

function drawPolygonRings(ctx, rings, width, height, fill = false) {
  for (const { points, minMx, maxMx, minMy, maxMy } of rings) {
    const [, top] = projectRaw(0, minMy, width, height);
    const [, bottom] = projectRaw(0, maxMy, width, height);
    if (top > height || bottom < 0) continue;
    for (const offset of visibleWorldOffsets(minMx, maxMx)) {
      ctx.beginPath();
      points.forEach(([mx, my], index) => {
        const [x, y] = projectRaw(mx + offset, my, width, height);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      if (fill) ctx.fill();
      ctx.stroke();
    }
  }
}

function drawAirspaces(ctx, tokens, width, height) {
  if (graphLinks.fir && document.getElementById('fir-layer')?.checked) {
    ctx.save();
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.38)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    for (const fir of graphLinks.fir) {
      drawPolygonRings(ctx, fir.rings, width, height, false);
    }
    if (view.zoom >= 2.2) {
      ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = tokens.muted || '#64748b';
      for (const fir of graphLinks.fir) {
        if (fir.mx == null || fir.my == null) continue;
        for (const offset of visibleWorldOffsets(fir.mx, fir.mx)) {
          const [x, y] = projectRaw(fir.mx + offset, fir.my, width, height);
          if (x >= 0 && x <= width && y >= 0 && y <= height) ctx.fillText(fir.id, x, y);
        }
      }
    }
    ctx.restore();
  }

  if (!graphNodes || !document.getElementById('airspace-layer')?.checked) return;
  const airspaces = graphNodes.filter((n) => n.polygons?.length || n.boxes?.length);
  if (!airspaces.length) return;
  ctx.save();
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const node of airspaces) {
    const selected = node === selectedGraphNode;
    const isGulf = node.id === 'AS_GULF';
    const fillColor = isGulf
      ? (selected ? 'rgba(217, 119, 6, 0.24)' : 'rgba(217, 119, 6, 0.13)')
      : (selected ? 'rgba(220, 38, 38, 0.24)' : 'rgba(220, 38, 38, 0.14)');
    const strokeColor = isGulf ? tokens.modes.road : tokens.danger;
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = selected ? 1.8 : 1.1;
    ctx.setLineDash([5, 4]);
    if (node.polygons?.length) {
      if (!node._compiledRings) {
        node._compiledRings = node.polygons.map((ring) => {
          const points = unwrapMxs(ring);
          const xs = points.map(([mx]) => mx);
          const ys = points.map(([, my]) => my);
          return {
            points,
            minMx: Math.min(...xs), maxMx: Math.max(...xs),
            minMy: Math.min(...ys), maxMy: Math.max(...ys),
          };
        });
      }
      drawPolygonRings(ctx, node._compiledRings, width, height, true);
      for (const offset of visibleWorldOffsets(node.mx, node.mx)) {
        const [x, y] = projectRaw(node.mx + offset, node.my, width, height);
        if (x >= 0 && x <= width && y >= 0 && y <= height) {
          ctx.fillStyle = strokeColor;
          ctx.fillText(node.name_zh || node.id, x, y);
        }
      }
    } else {
      for (const box of node.boxes) {
        const minMx = lonToMx(box.minLon);
        const maxMx = lonToMx(box.maxLon);
        const spanMx = maxMx >= minMx ? maxMx - minMx : 1 - minMx + maxMx;
        const top = latToMy(box.maxLat);
        const bottom = latToMy(box.minLat);
        for (const offset of visibleWorldOffsets(minMx, minMx + spanMx)) {
          const [x1, y1] = projectRaw(minMx + offset, top, width, height);
          const [x2, y2] = projectRaw(minMx + spanMx + offset, bottom, width, height);
          if (x2 < 0 || x1 > width || y2 < 0 || y1 > height) continue;
          ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          if (x2 - x1 > 70 && y2 - y1 > 22) {
            ctx.fillStyle = strokeColor;
            ctx.fillText(node.name_zh || node.id, (x1 + x2) / 2, (y1 + y2) / 2);
            ctx.fillStyle = fillColor;
          }
        }
      }
    }
  }
  ctx.restore();
}

function drawProjectedSegments(ctx, segments, width, height) {
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

function drawGraphLinks(ctx, tokens, width, height) {
  drawAirspaces(ctx, tokens, width, height);

  const layerStyles = [
    { layer: 'sea', alpha: 0.42, lineWidth: 1 },
    { layer: 'road', alpha: 0.34, lineWidth: 0.85 },
    { layer: 'land', alpha: 0.82, lineWidth: 1.8 },
  ];
  for (const { layer, alpha, lineWidth } of layerStyles) {
    const paths = graphLinks[layer];
    if (!paths || !document.getElementById(`${layer}-layer`)?.checked) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lineWidth;
    for (const [mode, segments] of paths) {
      ctx.strokeStyle = tokens.modes[mode] || tokens.modes.rail;
      drawProjectedSegments(ctx, segments, width, height);
    }
    ctx.restore();
  }

  if (graphLinks.air && document.getElementById('air-layer')?.checked) {
    const minFreq = view.zoom < 2 ? 4 : view.zoom < 4 ? 2 : 1;
    const filtered = minFreq === 1 ? graphLinks.air : graphLinks.air.filter((s) => s.freq >= minFreq);
    ctx.save();
    ctx.globalAlpha = view.zoom < 2 ? 0.22 : 0.28;
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = tokens.modes.air;
    drawProjectedSegments(ctx, filtered, width, height);
    ctx.restore();
  }

  if (selectedGraphNode) {
    const airRoutes = graphLinks.air ? graphAirByNode.get(selectedGraphNode.id) : null;
    if (airRoutes?.length) {
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = tokens.modes.air;
      drawProjectedSegments(ctx, airRoutes, width, height);
      ctx.restore();
    }
    const landRoutes = graphLinks.land ? graphLandByNode.get(selectedGraphNode.id) : null;
    if (landRoutes?.length) {
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2.6;
      for (const seg of landRoutes) {
        ctx.strokeStyle = tokens.modes[seg.mode] || tokens.modes.rail;
        drawProjectedSegments(ctx, [seg], width, height);
      }
      ctx.restore();
    }
  }
}

function getGraphMarkers(width, filter) {
  const { zoom } = view;
  const worldPx = width * zoom;
  const majorOnly = Boolean(document.getElementById('graph-major-only')?.checked);
  if (graphMarkerCache?.worldPx === worldPx && graphMarkerCache.zoom === zoom &&
      graphMarkerCache.filter === filter && graphMarkerCache.majorOnly === majorOnly &&
      graphMarkerCache.selected === selectedGraphNode) {
    return graphMarkerCache.markers;
  }

  // Keep cells and their centers fixed in world coordinates when the viewport moves.
  const cellScale = worldPx / 32;
  const cells = new Map();
  const markers = [];
  for (const node of graphNodes) {
    const selected = node === selectedGraphNode;
    if (!selected && (!matchesGraphFilter(node, filter) || (majorOnly && !node.featured))) continue;
    if (selected || zoom >= GRAPH_DETAIL_ZOOM) {
      markers.push({ wp: node, mx: node.mx, my: node.my });
      continue;
    }
    const key = `${Math.floor(node.mx * cellScale)},${Math.floor(node.my * cellScale)}`;
    const cell = cells.get(key) || { wp: node, count: 0, mx: 0, my: 0 };
    cell.count++;
    cell.mx += node.mx;
    cell.my += node.my;
    cells.set(key, cell);
  }

  for (const { wp, count, mx, my } of cells.values()) {
    markers.push(count === 1 ? { wp, mx, my } : { count, mx: mx / count, my: my / count });
  }
  markers.sort((a, b) => Number(a.wp === selectedGraphNode) - Number(b.wp === selectedGraphNode));
  graphMarkerCache = { worldPx, zoom, filter, majorOnly, selected: selectedGraphNode, markers };
  return markers;
}

function drawNodeGraph(ctx, tokens, width, height) {
  renderedMarkers = [];
  renderedLegs = [];
  if (!graphNodes) return;
  drawGraphLinks(ctx, tokens, width, height);
  const filter = document.getElementById('graph-type').value;
  const offsets = [...visibleWorldOffsets()];
  const markers = [];
  for (const { wp, count, mx, my } of getGraphMarkers(width, filter)) {
    for (const offset of offsets) {
      const [x, y] = projectRaw(mx + offset, my, width, height);
      if (x >= 0 && x <= width && y >= 0 && y <= height) markers.push({ wp, count, x, y });
    }
  }
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
  for (const marker of markers) {
    const { wp, x, y, count } = marker;
    const emphasis = wp && (wp === selectedGraphNode || wp.id === hoveredWaypointId);
    const isMajorHub = wp && (wp.portTier === 1 || wp.isHub || wp.type === 'city' || wp.major || (wp.routeCount ?? 0) >= 50);
    const radius = count ? Math.min(16, 9 + Math.log2(count)) : emphasis ? 7 : isMajorHub ? 5 : 3.5;
    const group = wp && (filter && wp.groups.includes(filter) ? filter : wp.groups[0]);
    ctx.fillStyle = group ? tokens.modes[NODE_GROUPS[group].color] : tokens.labelBg;
    ctx.strokeStyle = count ? tokens.labelBorder : tokens.land;
    ctx.lineWidth = emphasis ? 2 : 1;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (wp?.gatewayType) {
      ctx.strokeStyle = tokens.labelText;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (count) {
      ctx.fillStyle = tokens.labelText;
      ctx.fillText(count, x, y + 0.5);
    }
    renderedMarkers.push({ ...marker, radius: wp?.gatewayType ? radius + 3 : radius });
  }
  ctx.restore();
  const detailed = view.zoom >= GRAPH_DETAIL_ZOOM;
  const labeled = renderedMarkers.filter(({ wp }) =>
    wp && (detailed || wp === selectedGraphNode || wp.id === hoveredWaypointId));
  drawWaypointLabels(ctx, labeled, tokens, width, height, detailed);
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
  const activeRoute = routes.find((r) => r.routeId === highlightedId) ?? routes[0];
  const pairedId = activeRoute?.pairedRouteId ?? null;
  const priority = (route) => {
    if (hoveredLeg?.route === route) return 3;
    if (route.routeId === highlightedId) return 2;
    if (pairedId && route.routeId === pairedId) return 1;
    return 0;
  };
  const ordered = [...routes].sort((a, b) => priority(a) - priority(b));
  renderedLegs = [];

  for (const route of ordered) {
    const isSelected = highlightedId === route.routeId;
    const isHovered = hoveredLeg?.route === route;
    const isPaired = Boolean(pairedId && route.routeId === pairedId);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const leg of route.legs || []) {
      const { color, dash } = getLegStrokeStyle(route, leg, tokens);
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
        ctx.globalAlpha = isSelected || isHovered
          ? 0.98
          : isPaired
            ? 0.84
            : highlightedId
              ? (compareModel ? 0.3 : 0.46)
              : 0.78;
        ctx.lineWidth = isFocusedLeg ? 5 : isSelected || isHovered ? 3.4 : isPaired ? 2.6 : 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Waypoint markers for selected route (fallback to origin/destination)
  let waypoints = [...(activeRoute?.waypoints ?? [])];
  if (compareModel && pairedId) {
    const pairedRoute = routes.find((r) => r.routeId === pairedId);
    const seenIds = new Set(waypoints.map((w) => w.id));
    for (const wp of pairedRoute?.waypoints ?? []) {
      if (compareModel.avoidSet.has(wp.id) && !seenIds.has(wp.id)) {
        waypoints.push(wp);
        seenIds.add(wp.id);
      }
    }
  }
  if (!waypoints.length && currentEndpoints.origin && currentEndpoints.destination) {
    waypoints = [
      { ...currentEndpoints.origin, role: 'origin' },
      { ...currentEndpoints.destination, role: 'destination' },
    ];
  }

  const activeColor = activeRoute?.compareRole === 'baseline-affected'
    ? tokens.baseline
    : (tokens.modes[activeRoute?.mode] || tokens.modes.sea);
  renderedMarkers = [];
  for (const wp of waypoints) {
    const mxCopy = nearestCopyMx(lonToMx(wp.lon));
    const [x, y] = projectRaw(mxCopy, latToMy(wp.lat), cssW, cssH);
    const isBlocked = Boolean(compareModel?.avoidSet.has(wp.id));
    const radius = isBlocked || wp.role === 'origin' || wp.role === 'destination' ? 8 : 6;
    renderedMarkers.push({ wp, x, y, radius });
    drawWaypointMarker(ctx, wp, x, y, activeColor, wp.id === hoveredWaypointId, isBlocked);
  }
  positionRouteCard(cssW, cssH, activeColor);
  drawRouteWaypointLabels(ctx, tokens, cssW, cssH);
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

function countRouteBoxIntersections(x, y, width, height, padding, limit = Infinity) {
  const left = x - padding;
  const right = x + width + padding;
  const top = y - padding;
  const bottom = y + height + padding;
  let count = 0;
  for (const { points } of renderedLegs) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.max(a[0], b[0]) < left || Math.min(a[0], b[0]) > right ||
          Math.max(a[1], b[1]) < top || Math.min(a[1], b[1]) > bottom) continue;
      if (clipMapSegment(a, b, right - left, bottom - top, left, top)) {
        count += 1;
        if (count >= limit) return count;
      }
    }
  }
  return count;
}

function routesIntersectBox(x, y, width, height, padding) {
  return countRouteBoxIntersections(x, y, width, height, padding, 1) > 0;
}

function positionRouteCard(width, height, color) {
  const card = document.getElementById('map-route-card');
  const anchor = cardOpen && !routeCardPosition ? routeCardAnchor(width, height) : null;
  const visible = Boolean(cardOpen && (routeCardPosition || anchor));
  card.classList.toggle('hidden', !visible);
  if (!visible) return;

  const controls = document.querySelector('.map-controls');
  const minX = 8;
  const minY = controls.offsetTop + controls.offsetHeight + 6;
  card.style.maxHeight = `${Math.min(340, Math.max(0, height - minY - 8))}px`;
  card.style.setProperty('--route-color', color);

  const { offsetWidth: cardWidth, offsetHeight: cardHeight } = card;
  const maxX = Math.max(minX, width - cardWidth - 8);
  const maxY = Math.max(minY, height - cardHeight - 8);
  const clampX = (value) => Math.max(minX, Math.min(maxX, value));
  const clampY = (value) => Math.max(minY, Math.min(maxY, value));
  if (routeCardPosition) {
    routeCardPosition.x = clampX(routeCardPosition.x);
    routeCardPosition.y = clampY(routeCardPosition.y);
    card.style.left = `${routeCardPosition.x}px`;
    card.style.top = `${routeCardPosition.y}px`;
    return;
  }

  const [x, y] = anchor;
  const gap = 12;
  const centeredX = clampX(x - cardWidth / 2);
  const centeredY = clampY(y - cardHeight / 2);
  const candidates = [
    [x + gap, centeredY], [x - cardWidth - gap, centeredY],
    [centeredX, y + gap], [centeredX, y - cardHeight - gap],
    [minX, centeredY], [maxX, centeredY], [centeredX, minY], [centeredX, maxY],
    [minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY],
  ];
  let position = candidates.find(([left, top]) => left >= minX && left <= maxX &&
    top >= minY && top <= maxY && !routesIntersectBox(left, top, cardWidth, cardHeight, 8));

  if (!position) {
    const corners = [[maxX, maxY], [minX, maxY], [maxX, minY], [minX, minY]];
    let bestCount = Infinity;
    for (const corner of corners) {
      const count = countRouteBoxIntersections(corner[0], corner[1], cardWidth, cardHeight, 8);
      if (count < bestCount) {
        bestCount = count;
        position = corner;
      }
    }
  }

  const [cardX, cardY] = position;
  card.style.left = `${cardX}px`;
  card.style.top = `${cardY}px`;
}

function mapTargetAt(x, y, pointerType) {
  const radius = pointerType === 'touch' ? 18 : 10;
  let marker = null;
  let bestDistance = radius ** 2;
  for (let i = renderedMarkers.length - 1; i >= 0; i--) {
    const item = renderedMarkers[i];
    const box = item.labelBox;
    if (box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return item;
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

function closeWaypointMenu() {
  document.getElementById('waypoint-menu').classList.add('hidden');
}

function routeWaypointButton(id) {
  return document.querySelector(`[data-avoid-waypoint="${CSS.escape(id)}"]`);
}

function initMapInteractions() {
  const canvas = document.getElementById('world-map');
  const tooltip = document.getElementById('map-tooltip');
  const panel = document.getElementById('map-panel');
  const stage = panel.querySelector('.map-stage');
  const waypointMenu = document.getElementById('waypoint-menu');
  const waypointMenuName = document.getElementById('waypoint-menu-name');
  const waypointMenuAvoid = document.getElementById('waypoint-menu-avoid');
  let gesture = null;
  let pinchScale = null;
  const zoomInput = () => view === graphView ? GRAPH_ZOOM_INPUT : ROUTE_ZOOM_INPUT;

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
      const blockedSuffix = compareModel?.avoidSet.has(waypoint.id) ? ' · 已受阻' : '';
      const avoidHint = view === routeView && routeWaypointButton(waypoint.id)?.disabled === false ? ' · 右键避让' : '';
      tooltip.textContent = `${nodeLabel(waypoint)} · ${role}${blockedSuffix}${avoidHint}`;
    } else {
      const prefix = target.route?.compareRole
        ? `[${COMPARE_ROLE_META[target.route.compareRole].label}] `
        : '';
      tooltip.textContent = target.count ? `${target.count} 个节点 · 点击放大` : `${prefix}${legSummary(target.leg)}`;
    }
    const { offsetWidth, offsetHeight } = tooltip;
    tooltip.style.left = `${Math.max(8, Math.min(canvas.clientWidth - offsetWidth - 8, x + 12))}px`;
    const top = y - offsetHeight - 10;
    tooltip.style.top = `${Math.max(8, Math.min(canvas.clientHeight - offsetHeight - 8, top < 8 ? y + 14 : top))}px`;
  }

  function zoomAt(factor, x, y) {
    closeWaypointMenu();
    const m = getCanvasMetrics();
    if (!m) return;
    const oldWorldPx = m.cssW * view.zoom;
    const mxUnder = view.centerMx + (x - m.cssW / 2) / oldWorldPx;
    const myUnder = view.centerMy + (y - m.cssH / 2) / oldWorldPx;

    view.zoom = Math.max(Math.min(1, view.zoom), clampZoom(view.zoom * factor, m.cssH / m.cssW));
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
    const { wheelSensitivity, pinchWheelSensitivity, maxWheelStep } = zoomInput();
    const sensitivity = e.ctrlKey ? pinchWheelSensitivity : wheelSensitivity;
    const step = Math.max(-maxWheelStep, Math.min(maxWheelStep, -delta * sensitivity));
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
    const factor = (e.scale / pinchScale) ** zoomInput().pinchExponent;
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
    zoomAt(zoomInput().doubleClickFactor, x, y);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const { x, y } = cssPoint(e);
    gesture = { id: e.pointerId, x, y, centerMx: view.centerMx, centerMy: view.centerMy, dragging: false };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('contextmenu', (event) => {
    if (view !== routeView || !activeRouteId || !avoidPicker) return;
    const { x, y } = cssPoint(event);
    const waypoint = mapTargetAt(x, y, event.pointerType)?.wp;
    const waypointButton = waypoint && routeWaypointButton(waypoint.id);
    if (!waypointButton) return;

    event.preventDefault();
    clearMapHover();
    waypointMenuName.textContent = nodeLabel(waypoint);
    waypointMenuAvoid.disabled = waypointButton.disabled;
    waypointMenuAvoid.textContent = avoidNodes.has(waypoint.id) ? '已加入避让' : '避让此节点';
    waypointMenuAvoid.onclick = () => {
      closeWaypointMenu();
      if (avoidPicker.add(waypoint)) runQuery();
    };
    waypointMenu.classList.remove('hidden');
    const rect = stage.getBoundingClientRect();
    const left = event.clientX - rect.left - stage.clientLeft;
    const top = event.clientY - rect.top - stage.clientTop;
    waypointMenu.style.left = `${Math.max(6, Math.min(left, stage.clientWidth - waypointMenu.offsetWidth - 6))}px`;
    waypointMenu.style.top = `${Math.max(6, Math.min(top, stage.clientHeight - waypointMenu.offsetHeight - 6))}px`;
    (waypointMenuAvoid.disabled ? waypointMenu : waypointMenuAvoid).focus({ preventScroll: true });
  });
  document.addEventListener('pointerdown', (event) => {
    if (!waypointMenu.contains(event.target)) closeWaypointMenu();
  });
  waypointMenu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeWaypointMenu();
    document.getElementById('route-select').focus({ preventScroll: true });
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
    if (target?.wp) {
      const button = routeWaypointButton(target.wp.id);
      if (button) {
        cardOpen = true;
        const details = document.getElementById('card-waypoints');
        details.open = true;
        details.querySelector('.active')?.classList.remove('active');
        button.closest('li').classList.add('active');
        drawWorldMap(currentRoutes, activeRouteId);
        button.scrollIntoView({ block: 'nearest' });
        (button.disabled ? details.querySelector('summary') : button).focus({ preventScroll: true });
      }
    } else if (target?.leg) {
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
    if (m) zoomAt(zoomInput().buttonFactor, m.cssW / 2, m.cssH / 2);
  };
  document.getElementById('zoom-out-btn').onclick = () => {
    const m = getCanvasMetrics();
    if (m) zoomAt(1 / zoomInput().buttonFactor, m.cssW / 2, m.cssH / 2);
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
    closeWaypointMenu();
    view.zoom = 1;
    view.centerMx = 0.5;
    view.centerMy = DEFAULT_CENTER_MY;
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  };

  const routeCard = document.getElementById('map-route-card');
  const cardHandle = routeCard.querySelector('.card-head');
  let cardDrag = null;

  cardHandle.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('button')) return;
    const { x, y } = cssPoint(event);
    cardDrag = {
      id: event.pointerId,
      offsetX: x - routeCard.offsetLeft,
      offsetY: y - routeCard.offsetTop,
    };
    cardHandle.setPointerCapture(event.pointerId);
    cardHandle.classList.add('dragging');
  });

  cardHandle.addEventListener('pointermove', (event) => {
    if (event.pointerId !== cardDrag?.id) return;
    const { x, y } = cssPoint(event);
    routeCardPosition = { x: x - cardDrag.offsetX, y: y - cardDrag.offsetY };
    drawWorldMap(currentRoutes, activeRouteId);
  });

  function finishCardDrag(event) {
    if (event.pointerId !== cardDrag?.id) return;
    cardDrag = null;
    cardHandle.classList.remove('dragging');
  }

  cardHandle.addEventListener('pointerup', finishCardDrag);
  cardHandle.addEventListener('pointercancel', finishCardDrag);
  cardHandle.addEventListener('lostpointercapture', finishCardDrag);

  const routeSelect = document.getElementById('route-select');
  routeSelect.onchange = () => {
    selectRoute(routeSelect.value);
    if (routeCard.classList.contains('hidden')) {
      fitSelectedRoute();
    }
  };
  document.getElementById('close-route-card').onclick = () => {
    cardOpen = false;
    routeCardPosition = null;
    resizeMap();
    routeSelect.focus({ preventScroll: true });
  };
  document.getElementById('card-legs').ontoggle = () => drawWorldMap(currentRoutes, activeRouteId);
  document.getElementById('card-waypoints').ontoggle = () => drawWorldMap(currentRoutes, activeRouteId);

  function resizeMap() {
    closeWaypointMenu();
    clampView();
    clearMapHover();
    drawWorldMap(currentRoutes, activeRouteId);
  }

  const fullscreen = document.getElementById('fullscreen-btn');
  function updateFullscreen() {
    const expanded = document.fullscreenElement === panel || panel.classList.contains('map-maximized');
    fullscreen.textContent = expanded ? '退出全屏' : '全屏';
    fullscreen.setAttribute('aria-pressed', String(expanded));
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

function renderGraphNodeCard(node) {
  const badgesEl = document.getElementById('graph-node-badges');
  const detailsEl = document.getElementById('graph-node-details');
  const metricsEl = document.getElementById('graph-node-metrics');
  const connEl = document.getElementById('graph-node-connections');
  const aliasesEl = document.getElementById('graph-node-aliases');

  const label = nodeLabel(node);
  document.getElementById('graph-node-name').textContent = label;

  badgesEl.replaceChildren();
  const addBadge = (text, accent = false) => {
    const span = document.createElement('span');
    span.className = `graph-badge${accent ? ' graph-badge-accent' : ''}`;
    span.textContent = text;
    badgesEl.appendChild(span);
  };
  for (const group of node.groups) addBadge(NODE_GROUPS[group].label);
  if (node.gatewayType && node.gatewayType !== 'land') addBadge(GATEWAY_LABELS[node.gatewayType], true);
  if (node.portTier) addBadge(`Tier ${node.portTier} 港口`, node.portTier === 1);
  if (node.airportSize === 'large_airport') addBadge('大型机场', true);
  else if (node.airportSize === 'medium_airport') addBadge('中型机场');
  if (node.isHub || node.type === 'hub_airport') addBadge('核心枢纽', true);
  if (node.major) addBadge('关键咽喉', true);

  const fullName = node.name_zh || node.name_en;
  detailsEl.textContent = [
    fullName && fullName !== label && !label.startsWith(`${fullName}（`) ? fullName : '',
    node.name_en && node.name_en !== fullName ? node.name_en : '',
    node.codeStandard ? `${node.codeStandard}: ${node.code || node.id}` : '',
    node.country,
    node.region,
    `${node.lon.toFixed(2)}, ${node.lat.toFixed(2)}`,
  ].filter(Boolean).join(' · ');

  const metrics = [];
  if (node.routeCount != null) metrics.push(['直飞航线', `${node.routeCount} 条`]);
  if (node.landDegree > 0) metrics.push(['陆铁走廊', `${node.landDegree} 条`]);
  if (node.affectedLaneCount != null) metrics.push(['受影响线路', `${node.affectedLaneCount} 条`]);
  if (node.hasMarnet) metrics.push(['海运路网', node.snapDistanceKm != null ? `已接入 (${node.snapDistanceKm}km)` : '已接入']);
  if (node.hasRoadnet) metrics.push(['公路路网', node.roadSnapKm != null ? `已接入 (${node.roadSnapKm}km)` : '已接入']);
  if (node.firs?.length) metrics.push(['ICAO FIR', `${node.firs.length} 个`]);
  else if (node.boxes?.length) metrics.push(['空域边界', `${node.boxes.length} 个区域`]);

  metricsEl.replaceChildren();
  metricsEl.classList.toggle('hidden', !metrics.length);
  for (const [k, v] of metrics.slice(0, 6)) {
    const box = document.createElement('div');
    box.className = 'metric';
    const sp = document.createElement('span');
    sp.textContent = k;
    const st = document.createElement('strong');
    st.textContent = v;
    box.append(sp, st);
    metricsEl.appendChild(box);
  }

  connEl.replaceChildren();
  const connItems = [];
  let connTitle = '';
  const airRoutes = graphLinks.air ? graphAirByNode.get(node.id) : null;
  const landRoutes = graphLinks.land ? graphLandByNode.get(node.id) : null;
  if (airRoutes?.length) {
    connTitle = `直飞目的地（共 ${airRoutes.length} 条，按频次）`;
    const sorted = [...airRoutes].sort((a, b) => b.freq - a.freq).slice(0, 6);
    for (const seg of sorted) {
      const peer = graphNodeById.get(seg.peerId);
      connItems.push(`${peer ? nodeLabel(peer) : seg.peerId} · 频次 ${seg.freq}`);
    }
  } else if (landRoutes?.length) {
    connTitle = `连接的陆铁走廊（${landRoutes.length} 条）`;
    for (const seg of landRoutes.slice(0, 6)) {
      const peer = graphNodeById.get(seg.peerId);
      const km = seg.distanceKm ? ` (${Math.round(seg.distanceKm)} km)` : '';
      connItems.push(`${seg.corridor || MODE_LABELS[seg.mode] || seg.mode} → ${peer ? nodeLabel(peer) : seg.peerId}${km}`);
    }
  } else if (node.firs?.length) {
    connTitle = `包含 ICAO FIR（${node.firs.length} 个）`;
    connItems.push(node.firs.join(', '));
  }
  connEl.classList.toggle('hidden', !connItems.length);
  if (connItems.length) {
    const title = document.createElement('div');
    title.className = 'graph-connections-title';
    title.textContent = connTitle;
    const ul = document.createElement('ul');
    for (const text of connItems) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    }
    connEl.append(title, ul);
  }

  const aliases = (node.aliases || []).filter((a) => a && a !== node.name_zh && a !== node.name_en && a !== node.id);
  aliasesEl.classList.toggle('hidden', !aliases.length);
  aliasesEl.textContent = aliases.length ? `别名：${aliases.slice(0, 5).join(' / ')}` : '';

  const isPassage = node.groups.includes('passage');
  const avoidButton = document.getElementById('graph-set-avoid');
  const hasAvoidOption = avoidPicker && !isQueryEndpoint(node.id);
  document.getElementById('graph-set-from').classList.toggle('hidden', isPassage);
  document.getElementById('graph-set-to').classList.toggle('hidden', isPassage);
  avoidButton.classList.toggle('hidden', !hasAvoidOption);
  avoidButton.disabled = avoidNodes.has(node.id);
  avoidButton.textContent = avoidButton.disabled ? '已加入避让' : '避让此节点并计算';
  document.getElementById('graph-endpoints').classList.toggle('hidden', isPassage && !hasAvoidOption);
}

function selectGraphNode(node, recenter = false) {
  selectedGraphNode = node;
  document.getElementById('graph-card').classList.toggle('hidden', !node);
  if (node) {
    renderGraphNodeCard(node);
    if (node.routeCount > 0 && !graphLinks.air) ensureGraphLayer('air');
    if (node.landDegree > 0 && !graphLinks.land) ensureGraphLayer('land');
    if (recenter) {
      view.zoom = Math.max(view.zoom, GRAPH_DETAIL_ZOOM);
      view.centerMx = node.mx;
      view.centerMy = node.my;
      clampView();
    }
  }
  clearMapHover();
  drawWorldMap(currentRoutes, activeRouteId);
}

function prepareGraphLinks(links, layer) {
  const byMode = new Map();
  if (layer === 'land') graphLandByNode = new Map();
  for (const { mode, from, to, corridor, distanceKm, coords } of links) {
    const points = unwrapMxs(coords || []);
    if (points.length < 2) continue;
    const xs = points.map(([mx]) => mx);
    const ys = points.map(([, my]) => my);
    const seg = {
      mode, from, to, corridor, distanceKm, points,
      minMx: Math.min(...xs), maxMx: Math.max(...xs),
      minMy: Math.min(...ys), maxMy: Math.max(...ys),
    };
    const segments = byMode.get(mode) || [];
    segments.push(seg);
    byMode.set(mode, segments);
    if (layer === 'land' && from && to) {
      const fList = graphLandByNode.get(from) || [];
      fList.push({ ...seg, peerId: to });
      graphLandByNode.set(from, fList);
      const tList = graphLandByNode.get(to) || [];
      tList.push({ ...seg, peerId: from });
      graphLandByNode.set(to, tList);
    }
  }
  return byMode;
}

function prepareAirLinks(edges) {
  graphAirByNode = new Map();
  const segments = [];
  for (const [fromId, toId, freq = 1] of edges) {
    const from = graphNodeById.get(fromId);
    const to = graphNodeById.get(toId);
    if (!from || !to) continue;
    const points = unwrapMxs([[from.lon, from.lat], [to.lon, to.lat]]);
    if (points.length < 2) continue;
    const xs = points.map(([mx]) => mx);
    const ys = points.map(([, my]) => my);
    const seg = {
      points, freq,
      minMx: Math.min(...xs), maxMx: Math.max(...xs),
      minMy: Math.min(...ys), maxMy: Math.max(...ys),
    };
    segments.push(seg);
    const fList = graphAirByNode.get(fromId) || [];
    fList.push({ ...seg, peerId: toId });
    graphAirByNode.set(fromId, fList);
    const tList = graphAirByNode.get(toId) || [];
    tList.push({ ...seg, peerId: fromId });
    graphAirByNode.set(toId, tList);
  }
  return segments;
}

function prepareFirLinks(firs) {
  const out = [];
  for (const fir of firs) {
    const rings = (fir.polygons || []).map((ring) => {
      const points = unwrapMxs(ring);
      if (points.length < 3) return null;
      const xs = points.map(([mx]) => mx);
      const ys = points.map(([, my]) => my);
      return {
        points,
        minMx: Math.min(...xs), maxMx: Math.max(...xs),
        minMy: Math.min(...ys), maxMy: Math.max(...ys),
      };
    }).filter(Boolean);
    if (!rings.length) continue;
    out.push({
      id: fir.id,
      mx: Number.isFinite(fir.lon) ? lonToMx(fir.lon) : null,
      my: Number.isFinite(fir.lat) ? latToMy(fir.lat) : null,
      rings,
    });
  }
  return out;
}

function updateGraphStatus() {
  const status = document.getElementById('graph-status');
  if (!graphNodes) return;
  const filter = document.getElementById('graph-type').value;
  const majorOnly = Boolean(document.getElementById('graph-major-only')?.checked);
  const visibleCount = graphNodes.filter((n) => matchesGraphFilter(n, filter) && (!majorOnly || n.featured)).length;
  const totalCount = graphNodes.length;
  const nodePart = visibleCount === totalCount
    ? `全部 ${totalCount.toLocaleString('zh-CN')} 个节点`
    : `显示 ${visibleCount.toLocaleString('zh-CN')} / ${totalCount.toLocaleString('zh-CN')} 个节点`;
  const activeLayers = ['sea', 'air', 'land', 'road', 'fir']
    .filter((l) => document.getElementById(`${l}-layer`)?.checked && graphLinks[l])
    .map((l) => {
      const n = graphLinkCounts?.[l];
      return n ? `${MODE_LABELS[l]}${n.toLocaleString('zh-CN')}` : MODE_LABELS[l];
    });
  status.textContent = activeLayers.length
    ? `${nodePart} · 图层：${activeLayers.join(' / ')} · 放大显示名称`
    : `${nodePart} · 放大或点击聚类查看详情`;
}

async function ensureGraphLayer(layer) {
  if (graphLinks[layer] || graphLinkRequests[layer]) return graphLinkRequests[layer];
  const status = document.getElementById('graph-status');
  status.textContent = `正在加载${MODE_LABELS[layer] || layer}图层…`;
  const req = fetchJson(`/v1/graph/links?layers=${encodeURIComponent(layer)}`)
    .then((data) => {
      if (data.counts) graphLinkCounts = data.counts;
      if (layer === 'air') graphLinks.air = prepareAirLinks(data.air || []);
      else if (layer === 'fir') graphLinks.fir = prepareFirLinks(data.fir || []);
      else graphLinks[layer] = prepareGraphLinks(data[layer] || [], layer);
      updateGraphStatus();
      if (selectedGraphNode) renderGraphNodeCard(selectedGraphNode);
      drawWorldMap(currentRoutes, activeRouteId);
    })
    .catch(() => {
      const checkbox = document.getElementById(`${layer}-layer`);
      if (checkbox) checkbox.checked = false;
      status.textContent = `${MODE_LABELS[layer] || layer}图层加载失败，请重试`;
    })
    .finally(() => {
      delete graphLinkRequests[layer];
    });
  graphLinkRequests[layer] = req;
  return req;
}

function updateGraphLegendCounts() {
  if (!graphNodes) return;
  for (const btn of document.querySelectorAll('.graph-legend-btn')) {
    const group = btn.dataset.graphGroup;
    const span = btn.querySelector('.legend-count');
    if (span) span.textContent = graphNodes.filter((node) => matchesGraphFilter(node, group)).length.toLocaleString('zh-CN');
  }
}

function syncGraphLegendButtons() {
  const filter = document.getElementById('graph-type').value;
  for (const btn of document.querySelectorAll('.graph-legend-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.graphGroup === filter));
  }
}

function updateGraphSearch() {
  const query = document.getElementById('graph-search').value.trim().toLowerCase();
  const filter = document.getElementById('graph-type').value;
  const results = document.getElementById('graph-results');
  results.replaceChildren();
  results.classList.toggle('hidden', !query || !graphNodes);
  if (!query || !graphNodes) return;

  const matches = graphNodes
    .filter((node) => matchesGraphFilter(node, filter) && node.searchTerms.some((term) => term.includes(query)))
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
  closeWaypointMenu();
  view = nextView;
  const isGraph = view === graphView;
  document.getElementById('map-panel').dataset.view = isGraph ? 'graph' : 'routes';
  document.getElementById('graph-view-btn').setAttribute('aria-pressed', String(isGraph));
  document.getElementById('route-view-btn').setAttribute('aria-pressed', String(!isGraph));
  document.getElementById('graph-results').classList.add('hidden');
  if (!isGraph && fitRoutesOnReturn) {
    fitRoutesToView(currentRoutes);
    fitRoutesOnReturn = false;
  }
  clampView();
  clearMapHover();
  drawWorldMap(currentRoutes, activeRouteId);
}

function loadGraphNodeCatalog() {
  graphNodeCatalogRequest ??= fetchJson('/v1/graph/nodes').catch((error) => {
    graphNodeCatalogRequest = null;
    throw error;
  });
  return graphNodeCatalogRequest;
}

function initNodeGraph() {
  const status = document.getElementById('graph-status');
  const search = document.getElementById('graph-search');
  const results = document.getElementById('graph-results');
  const majorOnly = document.getElementById('graph-major-only');
  const airspaceLayer = document.getElementById('airspace-layer');

  document.getElementById('route-view-btn').onclick = () => setMapView(routeView);
  document.getElementById('graph-view-btn').onclick = async () => {
    setMapView(graphView);
    if (graphNodes || nodesRequest) return;
    status.textContent = '正在加载节点…';
    nodesRequest = loadGraphNodeCatalog();
    try {
      const { nodes } = await nodesRequest;
      graphNodes = nodes.map((node) => ({
        ...node,
        groups: nodeGroups(node),
        mx: lonToMx(node.lon),
        my: latToMy(node.lat),
        searchTerms: [
          node.id, node.code, node.name_zh, node.name_en, NODE_SHORT_NAMES[node.id],
          GATEWAY_LABELS[node.gatewayType], ...(node.aliases || []),
        ]
          .filter(Boolean).map((term) => term.toLowerCase()),
      }));
      graphNodeById = new Map(graphNodes.map((n) => [n.id, n]));
      updateGraphLegendCounts();
      updateGraphStatus();
      if (view === graphView) updateGraphSearch();
      drawWorldMap(currentRoutes, activeRouteId);
    } catch {
      status.textContent = '节点加载失败，点击「节点图谱」重试';
    } finally {
      nodesRequest = null;
    }
  };

  for (const layer of ['sea', 'air', 'land', 'road', 'fir']) {
    const checkbox = document.getElementById(`${layer}-layer`);
    checkbox.onchange = async () => {
      if (checkbox.checked && !graphLinks[layer]) {
        await ensureGraphLayer(layer);
      } else {
        updateGraphStatus();
        drawWorldMap(currentRoutes, activeRouteId);
      }
    };
  }
  airspaceLayer.onchange = () => drawWorldMap(currentRoutes, activeRouteId);
  majorOnly.onchange = () => {
    updateGraphStatus();
    drawWorldMap(currentRoutes, activeRouteId);
  };

  for (const btn of document.querySelectorAll('.graph-legend-btn')) {
    btn.onclick = () => {
      const select = document.getElementById('graph-type');
      select.value = select.value === btn.dataset.graphGroup ? '' : btn.dataset.graphGroup;
      select.onchange();
    };
  }

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
    if (selectedGraphNode && !matchesGraphFilter(selectedGraphNode, filter)) selectGraphNode(null);
    syncGraphLegendButtons();
    updateGraphStatus();
    updateGraphSearch();
    drawWorldMap(currentRoutes, activeRouteId);
  };
  document.getElementById('close-graph-card').onclick = () => {
    selectGraphNode(null);
    search.focus();
  };
  document.getElementById('graph-set-avoid').onclick = () => {
    if (!selectedGraphNode || !avoidPicker?.add(selectedGraphNode)) return;
    setMapView(routeView);
    const panel = document.getElementById('map-panel');
    if (document.fullscreenElement === panel || panel.classList.contains('map-maximized')) {
      document.getElementById('fullscreen-btn').click();
    }
    runQuery();
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
  return [...avoidNodes.keys()].filter((id) => !isQueryEndpoint(id));
}

function isQueryEndpoint(id) {
  return endpointPickers.from.value === id || endpointPickers.to.value === id;
}

function focusCompareRoute(routeId) {
  if (!routeId) return;
  if (currentRoutes.some((r) => r.routeId === routeId)) {
    selectRoute(routeId);
  } else if (compareModel) {
    applyCompareLayer('both', routeId);
  }
}

function selectRoute(routeId, leg = null, anchor = null) {
  closeWaypointMenu();
  if (routeId !== activeRouteId) routeCardPosition = null;
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
  syncCompareSelection();
}

function renderRouteCard(route, leg) {
  const byId = (id) => document.getElementById(id);
  const roleBadge = byId('card-role');
  if (compareModel && route.compareRole && COMPARE_ROLE_META[route.compareRole]) {
    const meta = COMPARE_ROLE_META[route.compareRole];
    roleBadge.textContent = meta.label;
    roleBadge.className = `role-badge tone-${meta.tone}`;
  } else {
    roleBadge.textContent = '';
    roleBadge.className = 'role-badge hidden';
  }

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

  const compareBar = byId('card-compare-bar');
  compareBar.replaceChildren();
  if (compareModel && route.compareRole === 'detour' && route.baselineRef) {
    const info = document.createElement('span');
    info.textContent = `较${route.modeLabel}基线 (${route.baselineRef.metrics.transitDays} 天)：${formatDeltaDays(route.deltaDays)} · ${formatDeltaKm(route.deltaKm)} · ${formatCostMultiplier(route.costMultiplier)} 成本`;
    compareBar.appendChild(info);
    if (route.pairedRouteId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmp-switch-btn';
      btn.textContent = '切换基线';
      btn.onclick = () => focusCompareRoute(route.pairedRouteId);
      compareBar.appendChild(btn);
    }
    compareBar.classList.remove('hidden');
  } else if (compareModel && route.compareRole === 'baseline-affected') {
    const info = document.createElement('span');
    info.textContent = route.pairedRouteId ? '经过避让点' : '经过避让点 · 当前无对应绕行方案';
    compareBar.appendChild(info);
    if (route.pairedRouteId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmp-switch-btn';
      btn.textContent = '切换绕行';
      btn.onclick = () => focusCompareRoute(route.pairedRouteId);
      compareBar.appendChild(btn);
    }
    compareBar.classList.remove('hidden');
  } else if (compareModel && route.compareRole === 'land-sub') {
    const info = document.createElement('span');
    info.textContent = '海运受阻时的陆路替代方案';
    compareBar.appendChild(info);
    compareBar.classList.remove('hidden');
  } else {
    compareBar.classList.add('hidden');
  }

  const chips = route.chokepoints.map((cp) => {
    const chip = document.createElement('span');
    const isBlocked = Boolean(compareModel?.avoidSet.has(cp.id) && route.compareGroup === 'baseline');
    chip.className = isBlocked ? 'chip blocked' : 'chip';
    chip.textContent = isBlocked ? `${cp.name_zh}（受阻）` : cp.name_zh;
    return chip;
  });
  if ((!compareModel && route.deltaDays != null) || (compareModel && route.showDelta && route.deltaDays != null)) {
    const delta = document.createElement('span');
    delta.className = 'chip delta';
    delta.textContent = `${formatDeltaDays(route.deltaDays)} · ${formatCostMultiplier(route.costMultiplier)} 成本`;
    chips.push(delta);
  }
  byId('card-chips').replaceChildren(...chips);
  byId('card-chips').classList.toggle('hidden', !chips.length);

  const waypoints = (route.waypoints ?? []).filter((wp) => wp.role !== 'origin' && wp.role !== 'destination');
  const waypointRows = waypoints.map((wp) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = nodeLabel(wp);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-btn map-btn-wide';
    button.dataset.avoidWaypoint = wp.id;
    button.onclick = () => {
      if (avoidPicker.add(wp)) runQuery();
    };
    row.append(name, button);
    return row;
  });
  byId('card-waypoint-list').replaceChildren(...waypointRows);
  byId('card-waypoint-summary').textContent = `途经节点（${waypoints.length}）`;
  byId('card-waypoints').open = false;
  byId('card-waypoints').classList.toggle('hidden', !waypoints.length);
  syncWaypointAvoidButtons();

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

function syncWaypointAvoidButtons() {
  for (const button of document.querySelectorAll('[data-avoid-waypoint]')) {
    const id = button.dataset.avoidWaypoint;
    const selected = avoidNodes.has(id);
    button.textContent = selected ? '已选避让' : '避让';
    button.title = selected ? '已加入避让' : '避让此节点并计算';
    button.setAttribute('aria-label', `${button.title} ${id}`);
    button.disabled = selected || isQueryEndpoint(id);
  }
}

function populateRouteSelect(routes) {
  const select = document.getElementById('route-select');
  if (!compareModel) {
    const options = routes.map((route) => {
      const via = route.viaHub?.code || route.viaHub?.name;
      const distinguishingStops = via || route.chokepoints.map((cp) => cp.name_zh).join('、');
      const name = [route.modeLabel, distinguishingStops, `${route.metrics.transitDays} 天`].filter(Boolean).join(' · ');
      return new Option(name, route.routeId);
    });
    select.replaceChildren(...options);
    document.getElementById('route-picker').classList.toggle('hidden', !options.length);
    return;
  }

  const groups = [
    { label: '绕行 / 替代方案', roles: new Set(['detour', 'land-sub']) },
    { label: '受阻原基线', roles: new Set(['baseline-affected']) },
    { label: '未受阻方案', roles: new Set(['unchanged', 'baseline']) },
  ];
  const nodes = [];
  for (const group of groups) {
    const matched = routes.filter((r) => group.roles.has(r.compareRole));
    if (!matched.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const route of matched) {
      const roleShort = COMPARE_ROLE_META[route.compareRole]?.shortLabel;
      const via = route.viaHub?.code || route.viaHub?.name;
      const stops = via || route.chokepoints.map((cp) => cp.name_zh).join('、');
      const deltaHint = route.showDelta && route.deltaDays != null ? ` (${formatDeltaDays(route.deltaDays)})` : '';
      const label = [
        roleShort ? `[${roleShort}]` : '',
        route.modeLabel,
        stops,
        `${route.metrics.transitDays} 天${deltaHint}`,
      ].filter(Boolean).join(' · ');
      optgroup.appendChild(new Option(label, route.routeId));
    }
    nodes.push(optgroup);
  }
  select.replaceChildren(...nodes);
  document.getElementById('route-picker').classList.toggle('hidden', !routes.length);
}

function buildRouteBriefCell(route) {
  const wrap = document.createElement('div');
  const main = document.createElement('div');
  main.className = 'route-cell-main';
  main.textContent = `${route.metrics.transitDays} 天 · ${formatKm(route.metrics.distanceKm)}`;

  const sub = document.createElement('div');
  sub.className = 'route-cell-sub';
  const via = route.viaHub ? ` → ${route.viaHub.code || route.viaHub.name}` : '';
  const cps = route.chokepoints.map((cp) => cp.name_zh).join('、');
  const gw = `${route.originGateway.name}${via} → ${route.destGateway.name}`;
  sub.textContent = cps ? `${gw} · 经 ${cps}` : gw;
  sub.title = sub.textContent;

  wrap.append(main, sub);
  return wrap;
}

function deltaToneClass(val, flatVal = 0) {
  if (val == null || Math.abs(val - flatVal) < 1e-9) return 'delta-flat';
  return val > flatVal ? 'delta-worse' : 'delta-better';
}

function syncCompareSelection() {
  if (!compareModel) return;
  const activeRoute = currentRoutes.find((r) => r.routeId === activeRouteId);
  for (const tr of document.querySelectorAll('#compare-routes-body tr')) {
    tr.classList.toggle('is-selected', tr.dataset.routeId === activeRouteId);
  }
  for (const tr of document.querySelectorAll('#compare-summary-body tr')) {
    tr.classList.toggle('is-selected', Boolean(activeRoute && tr.dataset.mode === activeRoute.mode));
  }
  for (const btn of document.querySelectorAll('#compare-summary-body .cmp-act-btn')) {
    btn.classList.toggle('active', btn.dataset.routeId === activeRouteId);
  }
}

function renderComparePanel() {
  const mapPanel = document.getElementById('map-panel');
  const panel = document.getElementById('compare-panel');
  const active = Boolean(compareModel);

  mapPanel.dataset.compare = String(active);
  panel.classList.toggle('hidden', !active);
  if (!active) return;

  panel.classList.toggle('collapsed', compareCollapsed);
  const collapseBtn = document.getElementById('compare-collapse-btn');
  collapseBtn.textContent = compareCollapsed ? '展开' : '收起';
  collapseBtn.setAttribute('aria-expanded', String(!compareCollapsed));

  const avoidChips = compareModel.avoidNames.map((name) => {
    const chip = document.createElement('span');
    chip.className = 'compare-avoid-chip';
    chip.textContent = `避开 ${name}`;
    return chip;
  });
  document.getElementById('compare-avoid-chips').replaceChildren(...avoidChips);

  const { affectedCount, totalBaselineCount, fastestDisrupted } = compareModel.headline;
  document.getElementById('compare-headline').textContent =
    `受影响基线 ${affectedCount}/${totalBaselineCount} 条 · 最快可用 ${
      fastestDisrupted ? `${fastestDisrupted.metrics.transitDays} 天 (${fastestDisrupted.modeLabel})` : '无'
    }`;

  const notice = document.getElementById('compare-notice');
  if (!compareModel.hasAvoid) {
    notice.textContent = '请在左侧选择要避让的节点或通道，再计算绕行对比。';
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }

  for (const btn of document.querySelectorAll('[data-compare-tab]')) {
    const isSel = btn.dataset.compareTab === compareTab;
    btn.classList.toggle('active', isSel);
    btn.setAttribute('aria-pressed', String(isSel));
    if (btn.dataset.compareTab === 'routes') {
      btn.textContent = `路径明细 (${currentRoutes.length})`;
    }
  }
  for (const btn of document.querySelectorAll('[data-compare-layer]')) {
    const isSel = btn.dataset.compareLayer === compareLayer;
    btn.classList.toggle('active', isSel);
    btn.setAttribute('aria-pressed', String(isSel));
  }

  document.getElementById('compare-summary-wrap').classList.toggle('hidden', compareTab !== 'summary');
  document.getElementById('compare-routes-wrap').classList.toggle('hidden', compareTab !== 'routes');

  // Render mode summary table
  const summaryRows = compareModel.modeSummaries.map((row) => {
    const tr = document.createElement('tr');
    tr.dataset.mode = row.mode;
    tr.onclick = () => focusCompareRoute(row.pairDisruptedId ?? row.pairBaselineId);

    const tdMode = document.createElement('td');
    const modeWrap = document.createElement('span');
    modeWrap.className = 'mode-cell';
    const dot = document.createElement('i');
    dot.className = 'mode-dot';
    dot.style.background = `var(--${row.mode === 'local' ? 'road' : row.mode})`;
    modeWrap.append(dot, document.createTextNode(row.modeLabel));
    tdMode.appendChild(modeWrap);

    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge tone-${row.statusTone}`;
    badge.textContent = row.statusLabel;
    tdStatus.appendChild(badge);

    const tdBase = document.createElement('td');
    if (row.bestBaseline) {
      tdBase.appendChild(buildRouteBriefCell(row.bestBaseline));
    } else {
      tdBase.textContent = '—';
    }

    const tdDisp = document.createElement('td');
    if (row.bestDisrupted) {
      tdDisp.appendChild(buildRouteBriefCell(row.bestDisrupted));
    } else {
      const empty = document.createElement('span');
      empty.className = 'route-cell-empty';
      empty.textContent = '无可用方案';
      tdDisp.appendChild(empty);
    }

    const tdDeltaDays = document.createElement('td');
    tdDeltaDays.className = `num ${deltaToneClass(row.deltaDays, 0)}`;
    tdDeltaDays.textContent = row.bestDisrupted ? formatDeltaDays(row.deltaDays) : '中断';
    if (!row.bestDisrupted) tdDeltaDays.className = 'num route-cell-empty';

    const tdDeltaKm = document.createElement('td');
    tdDeltaKm.className = `num ${deltaToneClass(row.deltaKm, 0)}`;
    tdDeltaKm.textContent = row.bestDisrupted ? formatDeltaKm(row.deltaKm) : '—';

    const tdCost = document.createElement('td');
    tdCost.className = `num ${deltaToneClass(row.costMultiplier, 1)}`;
    if (row.bestDisrupted && row.bestBaseline) {
      const main = document.createElement('div');
      main.textContent = formatCostMultiplier(row.costMultiplier);
      const sub = document.createElement('div');
      sub.className = 'route-cell-sub';
      sub.textContent = `${row.bestBaseline.metrics.costIndex}→${row.bestDisrupted.metrics.costIndex}`;
      tdCost.append(main, sub);
    } else {
      tdCost.textContent = '—';
    }

    const tdAct = document.createElement('td');
    tdAct.className = 'actions-col';
    const actGroup = document.createElement('div');
    actGroup.className = 'cmp-act-group';

    const addBtn = (label, targetId, extraClass = '') => {
      if (!targetId) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cmp-act-btn${extraClass ? ` ${extraClass}` : ''}`;
      btn.dataset.routeId = targetId;
      btn.textContent = label;
      btn.onclick = (e) => {
        e.stopPropagation();
        focusCompareRoute(targetId);
      };
      actGroup.appendChild(btn);
    };

    if (row.status === 'cutoff') {
      addBtn('受阻基线', row.pairBaselineId, 'baseline-act');
    } else if (row.status === 'detour') {
      addBtn('基线', row.pairBaselineId, 'baseline-act');
      addBtn('绕行', row.pairDisruptedId);
    } else if (row.status === 'partial') {
      addBtn('受阻基线', row.pairBaselineId, 'baseline-act');
      addBtn('最优方案', row.pairDisruptedId);
    } else {
      addBtn('查看', row.pairDisruptedId ?? row.pairBaselineId);
    }
    tdAct.appendChild(actGroup);

    tr.append(tdMode, tdStatus, tdBase, tdDisp, tdDeltaDays, tdDeltaKm, tdCost, tdAct);
    return tr;
  });
  document.getElementById('compare-summary-body').replaceChildren(...summaryRows);

  // Render route detail table
  const routeRows = currentRoutes.map((route) => {
    const tr = document.createElement('tr');
    tr.dataset.routeId = route.routeId;
    tr.onclick = () => selectRoute(route.routeId);

    const tdRole = document.createElement('td');
    const roleMeta = COMPARE_ROLE_META[route.compareRole] ?? { label: '方案', tone: 'neutral' };
    const rolePill = document.createElement('span');
    rolePill.className = `role-badge tone-${roleMeta.tone}`;
    rolePill.textContent = roleMeta.label;
    tdRole.appendChild(rolePill);

    const tdMode = document.createElement('td');
    const modeWrap = document.createElement('span');
    modeWrap.className = 'mode-cell';
    const dot = document.createElement('i');
    dot.className = 'mode-dot';
    dot.style.background = `var(--${route.mode === 'local' ? 'road' : route.mode})`;
    modeWrap.append(dot, document.createTextNode(route.modeLabel));
    tdMode.appendChild(modeWrap);

    const tdStops = document.createElement('td');
    const via = route.viaHub ? ` → ${route.viaHub.code || route.viaHub.name}` : '';
    const cps = route.chokepoints.map((cp) => cp.name_zh).join('、');
    const gwMain = document.createElement('div');
    gwMain.className = 'route-cell-main';
    gwMain.textContent = `${route.originGateway.name}${via} → ${route.destGateway.name}`;
    const gwSub = document.createElement('div');
    gwSub.className = 'route-cell-sub';
    gwSub.textContent = cps ? `经 ${cps}` : '直达 / 无经停咽喉';
    tdStops.append(gwMain, gwSub);

    const tdKm = document.createElement('td');
    tdKm.className = 'num';
    tdKm.textContent = formatKm(route.metrics.distanceKm);

    const tdDays = document.createElement('td');
    tdDays.className = 'num';
    tdDays.textContent = `${route.metrics.transitDays} 天`;

    const tdCost = document.createElement('td');
    tdCost.className = 'num';
    tdCost.textContent = route.metrics.costIndex;

    const tdDelta = document.createElement('td');
    tdDelta.className = 'num';
    if (route.showDelta && route.deltaDays != null) {
      tdDelta.classList.add(deltaToneClass(route.deltaDays, 0));
      tdDelta.textContent = `${formatDeltaDays(route.deltaDays)} / ${formatCostMultiplier(route.costMultiplier)}`;
    } else if (route.compareRole === 'baseline-affected') {
      tdDelta.className = 'num route-cell-empty';
      tdDelta.textContent = '经过避让点';
    } else {
      tdDelta.className = 'num delta-flat';
      tdDelta.textContent = '无变化';
    }

    tr.append(tdRole, tdMode, tdStops, tdKm, tdDays, tdCost, tdDelta);
    return tr;
  });
  document.getElementById('compare-routes-body').replaceChildren(...routeRows);
  syncCompareSelection();
}

function applyCompareLayer(layer, preferredRouteId = null) {
  if (!compareModel) return;
  compareLayer = layer;
  const routes = compareModel.getRoutes(layer);
  const nextId =
    preferredRouteId && routes.some((r) => r.routeId === preferredRouteId)
      ? preferredRouteId
      : compareModel.defaultRouteId(layer);
  renderRoutes(routes, { initialRouteId: nextId });
}

function renderRoutes(routes, { initialRouteId = null } = {}) {
  currentRoutes = routes;
  populateRouteSelect(routes);
  renderComparePanel();

  if (view === routeView) fitRoutesToView(routes);
  else fitRoutesOnReturn = true;
  selectRoute(initialRouteId ?? routes[0]?.routeId ?? null);
}

function updateActionButton() {
  const avoidCount = avoidNodes.size;
  document.getElementById('run-btn').textContent =
    selectedAvoid().length > 0 ? '分析绕行影响（基线 vs 绕行）' : '计算多式联运路径';
  document.getElementById('avoid-meta').classList.toggle('hidden', avoidCount === 0);
  if (avoidCount > 0) {
    document.getElementById('avoid-count').textContent = `已选 ${avoidCount} 项`;
  }
}

function initAvoidPicker(chokepoints) {
  const list = document.getElementById('avoid-options');
  const search = document.getElementById('avoid-search');
  const filters = [...document.querySelectorAll('[data-avoid-type]')];
  const selected = document.getElementById('avoid-selected');
  const toggleResults = document.getElementById('toggle-avoid-results');
  const clear = document.getElementById('clear-avoid-btn');
  const status = document.getElementById('avoid-results-status');
  const reload = document.getElementById('reload-avoid-nodes');
  const prev = document.getElementById('avoid-prev');
  const next = document.getElementById('avoid-next');
  const pageSize = 25;
  const catalog = new Map();
  const sorted = [...chokepoints].sort(
    (a, b) => Number(KEY_AVOID_IDS.has(b.id)) - Number(KEY_AVOID_IDS.has(a.id)) || b.affectedLaneCount - a.affectedLaneCount
  );
  for (const node of sorted) register(node, node.type === 'airspace' ? 'air' : 'sea');
  let activeType = '';
  let loadStatus = '正在加载节点…';
  let matches = [];
  let pageOptions = [];
  let page = 0;

  function register(node, type) {
    if (catalog.has(node.id)) return;
    const searchText = [
      node.id, node.code, node.name_zh, node.name_en, NODE_SHORT_NAMES[node.id], ...(node.aliases ?? []),
    ].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
    catalog.set(node.id, { node, type, searchText });
  }

  function setOption(node, checked) {
    if (checked) avoidNodes.set(node.id, catalog.get(node.id)?.node ?? node);
    else avoidNodes.delete(node.id);
  }

  function add(node) {
    if (avoidNodes.has(node.id) || isQueryEndpoint(node.id)) return false;
    setOption(node, true);
    syncSelection();
    return true;
  }

  function syncPage() {
    for (const { node, checkbox } of pageOptions) {
      checkbox.checked = avoidNodes.has(node.id);
      checkbox.disabled = isQueryEndpoint(node.id);
      checkbox.title = checkbox.disabled ? '当前查询的起点或终点' : '';
    }
    const eligible = pageOptions.filter(({ checkbox }) => !checkbox.disabled);
    toggleResults.disabled = !eligible.length;
    const allSelected = eligible.length && eligible.every(({ checkbox }) => checkbox.checked);
    toggleResults.textContent = allSelected ? '取消本页全选' : '全选本页';
  }

  function syncSelection() {
    syncPage();
    selected.replaceChildren(...[...avoidNodes.values()].map((node) => {
      const chip = document.createElement('button');
      const name = node.name_zh || nodeLabel(node);
      chip.type = 'button';
      chip.className = 'avoid-chip';
      chip.textContent = `${name} ×`;
      chip.setAttribute('aria-label', `移除${name}`);
      chip.onclick = () => {
        setOption(node, false);
        syncSelection();
        (selected.querySelector('button') ?? search).focus();
      };
      return chip;
    }));
    updateActionButton();
    syncWaypointAvoidButtons();
  }

  function renderPage() {
    const start = page * pageSize;
    const end = Math.min(start + pageSize, matches.length);
    pageOptions = matches.slice(start, end).map(({ node, type }) => {
      const row = document.createElement('div');
      row.className = 'cp-item';
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'avoid';
      checkbox.value = node.id;
      label.append(checkbox, nodeLabel(node));
      row.append(label);

      const detail = document.createElement('span');
      detail.className = 'cp-count';
      detail.textContent = type === 'node'
        ? nodeGroups(node).map((group) => NODE_GROUPS[group].label).join(' / ')
        : `${node.affectedLaneCount ?? 0} 线`;
      row.append(detail);
      return { row, node, checkbox };
    });
    list.replaceChildren(...pageOptions.map(({ row }) => row));
    list.scrollTop = 0;
    const count = matches.length
      ? `${start + 1}–${end} / ${matches.length.toLocaleString('zh-CN')} 项`
      : '无匹配项';
    status.textContent = activeType === 'sea' || activeType === 'air' || !loadStatus
      ? count : `${loadStatus} · ${count}`;
    prev.disabled = page === 0;
    next.disabled = end >= matches.length;
    syncPage();
  }

  function applyFilters() {
    const terms = search.value.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
    matches = [...catalog.values()].filter(({ type, searchText }) =>
      (!activeType || activeType === type) && terms.every((term) => searchText.includes(term))
    );
    page = 0;
    renderPage();
  }

  async function loadNodes() {
    loadStatus = '正在加载节点…';
    reload.classList.add('hidden');
    renderPage();
    try {
      const { nodes } = await loadGraphNodeCatalog();
      for (const node of nodes) {
        register(node, node.type === 'airspace' ? 'air' : node.marnetPassage ? 'sea' : 'node');
      }
      loadStatus = '';
      applyFilters();
    } catch {
      loadStatus = '节点加载失败';
      reload.classList.remove('hidden');
      renderPage();
    }
  }

  for (const button of filters) {
    button.onclick = () => {
      activeType = button.dataset.avoidType;
      for (const filter of filters) {
        filter.setAttribute('aria-pressed', String(filter === button));
      }
      applyFilters();
    };
  }
  search.addEventListener('input', applyFilters);
  prev.onclick = () => { page--; renderPage(); };
  next.onclick = () => { page++; renderPage(); };
  reload.onclick = loadNodes;
  for (const id of ['from-input', 'to-input']) {
    document.getElementById(id).addEventListener('input', syncPage);
  }
  list.addEventListener('change', ({ target }) => {
    const option = catalog.get(target.value);
    if (!option) return;
    if (isQueryEndpoint(option.node.id)) {
      syncPage();
      return;
    }
    setOption(option.node, target.checked);
    syncSelection();
  });
  toggleResults.onclick = () => {
    const eligible = pageOptions.filter(({ node }) => !isQueryEndpoint(node.id));
    const checked = eligible.some(({ checkbox }) => !checkbox.checked);
    for (const { node } of eligible) setOption(node, checked);
    syncSelection();
  };
  clear.onclick = () => {
    avoidNodes.clear();
    syncSelection();
    search.focus();
    runQuery();
  };
  applyFilters();
  syncSelection();
  loadNodes();
  return {
    add,
    excludeEndpoints(origin, destination) {
      const removedOrigin = avoidNodes.delete(origin.id);
      const removedDestination = avoidNodes.delete(destination.id);
      if (removedOrigin || removedDestination) syncSelection();
      else syncPage();
    },
  };
}

function getRoutePayload() {
  return {
    from: endpointPickers.from.value,
    to: endpointPickers.to.value,
    modes: selectedModes(),
    avoid: selectedAvoid(),
    maxRoutes: 8,
    includeGeometry: true,
  };
}

async function runQuery() {
  const queryId = ++querySequence;
  setMapView(routeView);
  const payload = getRoutePayload();
  const { from, to, avoid } = payload;
  const summary = document.getElementById('route-summary');
  for (const picker of Object.values(endpointPickers)) picker.close();
  closeWaypointMenu();
  if (!from || !to) {
    summary.textContent = `请输入${!from ? '起运地' : '目的地'}`;
    document.getElementById(`${!from ? 'from' : 'to'}-input`).focus();
    return;
  }
  const isCompare = avoid.length > 0;
  const avoidNames = new Map(avoid.map((id) => {
    const node = avoidNodes.get(id);
    return [id, node.name_zh || nodeLabel(node)];
  }));

  const endpoint = isCompare ? '/v1/routes/compare' : '/v1/routes';
  let data;
  try {
    data = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (queryId !== querySequence) return;
    if (error.message.startsWith('Unknown origin node:')) {
      summary.textContent = `未找到起运地「${from}」，可输入地点名并从候选中选择`;
    } else if (error.message.startsWith('Unknown destination node:')) {
      summary.textContent = `未找到目的地「${to}」，可输入地点名并从候选中选择`;
    } else {
      summary.textContent = `路径计算失败：${error.message}`;
    }
    return;
  }

  if (queryId !== querySequence) return;
  currentEndpoints = { origin: data.origin, destination: data.destination };
  avoidPicker.excludeEndpoints(data.origin, data.destination);

  const badge = document.getElementById('cache-badge');
  const c = data.meta?.cache;
  if (c) {
    badge.textContent = c.hit ? `缓存命中 (${c.layer})` : '实时计算已写入SQLite';
    badge.className = `cache-badge${c.hit ? ' hit' : ''}`;
  }

  if (isCompare && data.avoid.length) {
    compareModel = buildCompareModel(data, avoidNames);
    compareLayer = 'both';
    compareTab = 'summary';
    compareCollapsed = false;
    const routes = compareModel.getRoutes(compareLayer);
    summary.textContent = `${data.origin.name_zh} → ${data.destination.name_zh} · 基线 vs 绕行对比（避让：${compareModel.avoidNames.join('、')}）`;
    renderRoutes(routes, { initialRouteId: compareModel.defaultRouteId(compareLayer) });
  } else {
    compareModel = null;
    const routes = data.routes ?? data.baseline ?? [];
    summary.textContent = `${data.origin.name_zh} → ${data.destination.name_zh} · 共 ${routes.length} 条评估路径`;
    renderRoutes(routes);
  }
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
  avoidPicker = initAvoidPicker(cpRes.chokepoints);

  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.onclick = () => {
      for (const endpoint of ['from', 'to']) {
        const label = btn.querySelector(`[data-${endpoint}]`);
        endpointPickers[endpoint].setNode({ id: label.dataset[endpoint], name_zh: label.textContent });
      }
      runQuery();
    };
  }

  for (const btn of document.querySelectorAll('[data-compare-tab]')) {
    btn.onclick = () => {
      compareTab = btn.dataset.compareTab;
      renderComparePanel();
    };
  }
  for (const btn of document.querySelectorAll('[data-compare-layer]')) {
    btn.onclick = () => applyCompareLayer(btn.dataset.compareLayer);
  }
  document.getElementById('compare-collapse-btn').onclick = () => {
    compareCollapsed = !compareCollapsed;
    renderComparePanel();
  };

  document.getElementById('run-btn').onclick = () => runQuery();

  await runQuery();
}

const endpointPickers = Object.fromEntries(['from', 'to'].map((key) => [
  key,
  createEndpointPicker(document.getElementById(`${key}-input`), {
    fetchJson,
    describe: describeEndpoint,
    submit: () => runQuery(),
  }),
]));

initApiCatalog({ fetchJson, getRoutePayload, nodeGroups, groupLabels: NODE_GROUPS });

init().catch((err) => {
  console.error(err);
  document.getElementById('route-summary').textContent = `初始化失败: ${err.message}`;
});
