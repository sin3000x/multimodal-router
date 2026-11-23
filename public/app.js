const MODE_COLORS = {
  sea: '#38bdf8',
  air: '#a78bfa',
  rail: '#34d399',
  road: '#fbbf24',
  local: '#fbbf24',
};

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

let worldGeo = null;
let currentRoutes = [];
let activeRouteId = null;

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function project([lon, lat], width, height) {
  const x = ((lon + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return [x, y];
}

function drawWorldMap(routes, highlightedId) {
  const canvas = document.getElementById('world-map');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#09101f';
  ctx.fillRect(0, 0, w, h);

  // Graticule
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.lineWidth = 1;
  for (let lon = -150; lon <= 150; lon += 30) {
    const [x] = project([lon, 0], w, h);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project([0, lat], w, h);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Land polygons
  if (worldGeo?.features) {
    ctx.fillStyle = '#162238';
    ctx.strokeStyle = '#263552';
    ctx.lineWidth = 0.7;
    for (const f of worldGeo.features) {
      const rings =
        f.geometry?.type === 'Polygon'
          ? [f.geometry.coordinates[0]]
          : f.geometry?.type === 'MultiPolygon'
          ? f.geometry.coordinates.map((p) => p[0])
          : [];
      for (const ring of rings) {
        ctx.beginPath();
        ring.forEach((pt, idx) => {
          const [x, y] = project(pt, w, h);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Draw routes (dim non-selected when one is highlighted)
  for (const route of routes) {
    const isActive = !highlightedId || route.routeId === highlightedId;
    const color = MODE_COLORS[route.mode] || '#e2e8f0';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = isActive ? (highlightedId === route.routeId ? 1 : 0.75) : 0.18;
    ctx.lineWidth = highlightedId === route.routeId ? 2.8 : 1.5;
    if (route.mode === 'air') ctx.setLineDash([6, 4]);
    else if (route.mode === 'rail') ctx.setLineDash([3, 3]);

    for (const leg of route.legs || []) {
      const coords = leg.geometry || [];
      if (coords.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < coords.length; i++) {
        const pt = coords[i];
        const [x, y] = project(pt, w, h);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          const prev = coords[i - 1];
          // Break stroke across antimeridian
          if (Math.abs(pt[0] - prev[0]) > 180) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
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
    body: JSON.stringify({ from, to, modes, avoid, maxRoutes: 10, includeGeometry: true }),
  });

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
  const [geo, nodesRes, cpRes] = await Promise.all([
    fetchJson('/countries.geojson').catch(() => null),
    fetchJson('/v1/nodes?limit=100'),
    fetchJson('/v1/chokepoints'),
  ]);
  worldGeo = geo;

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
