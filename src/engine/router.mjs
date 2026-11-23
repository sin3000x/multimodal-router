import { haversineKm, normalizeLon } from './geo.mjs';
import { createSeaRouter } from './sea-router.mjs';
import { createAirRouter } from './air-router.mjs';
import { createLandRouter } from './land-router.mjs';

const fold = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();

export function createRouter(compiledGraph) {
  const nodes = compiledGraph.nodes ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeByLegacyId = new Map();
  const nodeByCode = new Map();
  const nodesByAlias = new Map();
  const landConnectionsByNode = new Map();

  for (const edge of compiledGraph.landEdges ?? []) {
    if (!landConnectionsByNode.has(edge.from)) landConnectionsByNode.set(edge.from, []);
    landConnectionsByNode.get(edge.from).push(edge);
    if (edge.bidirectional) {
      if (!landConnectionsByNode.has(edge.to)) landConnectionsByNode.set(edge.to, []);
      landConnectionsByNode.get(edge.to).push({
        ...edge,
        from: edge.to,
        to: edge.from,
      });
    }
  }

  for (const node of nodes) {
    for (const lid of node.legacyIds ?? []) {
      nodeByLegacyId.set(lid, node);
    }
    if (node.code) {
      const cKey = node.code.trim().toUpperCase();
      // Prefer curated nodes over raw dataset entries when codes overlap
      if (!nodeByCode.has(cKey) || node.curated) {
        nodeByCode.set(cKey, node);
      }
    }
    for (const raw of [
      node.id,
      node.name_zh,
      node.name_en,
      node.code,
      ...(node.legacyIds ?? []),
      ...(node.aliases ?? []),
    ]) {
      const k = fold(raw);
      if (!k) continue;
      if (!nodesByAlias.has(k)) nodesByAlias.set(k, []);
      nodesByAlias.get(k).push(node);
    }
  }

  const routeSea = createSeaRouter(compiledGraph, landConnectionsByNode);
  const routeAir = createAirRouter(compiledGraph);
  const routeLand = createLandRouter(compiledGraph);

  function resolveNode(query) {
    if (!query) return null;
    if (typeof query === 'object' && Number.isFinite(query.lon) && Number.isFinite(query.lat)) {
      return {
        id: query.id || `COORD_${query.lon.toFixed(2)}_${query.lat.toFixed(2)}`,
        type: 'custom',
        codeStandard: 'custom',
        name_zh: query.name || `${query.lon.toFixed(2)}, ${query.lat.toFixed(2)}`,
        name_en: query.name || `${query.lon.toFixed(2)}, ${query.lat.toFixed(2)}`,
        lon: normalizeLon(query.lon),
        lat: query.lat,
      };
    }

    const str = String(query).trim();
    if (nodeById.has(str)) return nodeById.get(str);
    if (nodeByLegacyId.has(str)) return nodeByLegacyId.get(str);

    const coordMatch = str.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      const lon = normalizeLon(Number(coordMatch[1]));
      const lat = Number(coordMatch[2]);
      if (Math.abs(lat) <= 90) {
        return {
          id: `COORD_${lon.toFixed(2)}_${lat.toFixed(2)}`,
          type: 'custom',
          name_zh: `坐标 (${lon.toFixed(2)}, ${lat.toFixed(2)})`,
          name_en: `Coord (${lon.toFixed(2)}, ${lat.toFixed(2)})`,
          lon,
          lat,
        };
      }
    }

    const upper = str.toUpperCase();
    if (nodeByCode.has(upper)) return nodeByCode.get(upper);

    const exact = nodesByAlias.get(fold(str));
    if (exact?.length) {
      return [...exact].sort((a, b) => {
        const score = (n) => (n.curated ? 100 : 0) + (n.type === 'city' ? 30 : n.type === 'port' ? 20 : 10) + (n.isMajor ? 5 : 0);
        return score(b) - score(a);
      })[0];
    }

    return null;
  }

  function searchNodes({ q = '', type = '', limit = 20 } = {}) {
    const query = fold(q);
    const matches = [];
    for (const n of nodes) {
      if (n.type === 'country') continue;
      if (type && n.type !== type) continue;
      if (!query) {
        if (n.curated || n.isMajor) matches.push({ node: n, score: n.curated ? 100 : 50 });
        continue;
      }
      const id = fold(n.id);
      const code = fold(n.code);
      const zh = fold(n.name_zh);
      const en = fold(n.name_en);
      let score = 0;
      if (id === query || code === query || zh === query || en === query) score = 200;
      else if (code.startsWith(query) || en.startsWith(query) || zh.startsWith(query)) score = 120;
      else if (zh.includes(query) || en.includes(query) || (n.aliases ?? []).some((a) => fold(a).includes(query))) {
        score = 60;
      }
      if (score > 0) {
        if (n.curated) score += 40;
        if (n.type === 'city') score += 20;
        if (n.isMajor) score += 10;
        matches.push({ node: n, score });
      }
    }
    matches.sort((a, b) => b.score - a.score || (a.node.name_en || '').localeCompare(b.node.name_en || ''));
    return matches.slice(0, limit).map(({ node }) => ({
      id: node.id,
      type: node.type,
      functions: node.functions ?? [node.type],
      code: node.code ?? null,
      codeStandard: node.codeStandard ?? 'custom',
      name_zh: node.name_zh,
      name_en: node.name_en,
      country: node.country,
      lon: node.lon,
      lat: node.lat,
      curated: Boolean(node.curated),
    }));
  }

  function interleaveDiverseRoutes(byMode, maxRoutes) {
    // Round-robin pick across available modes so business gets sea + sea detour + air + rail options
    const buckets = Object.values(byMode).filter((arr) => arr.length > 0);
    const out = [];
    let idx = 0;
    while (out.length < maxRoutes) {
      let added = false;
      for (const bucket of buckets) {
        if (idx < bucket.length) {
          out.push(bucket[idx]);
          added = true;
          if (out.length >= maxRoutes) break;
        }
      }
      if (!added) break;
      idx++;
    }
    return out;
  }

  function findRoutes({
    from,
    to,
    modes = ['sea', 'air', 'rail', 'road'],
    avoid = [],
    maxRoutes = 8,
    includeGeometry = false,
  }) {
    const originNode = resolveNode(from);
    if (!originNode) throw new Error(`Unknown origin node: ${from}`);
    const destNode = resolveNode(to);
    if (!destNode) throw new Error(`Unknown destination node: ${to}`);

    const requestedModes = new Set(Array.isArray(modes) ? modes : String(modes).split(',').map((s) => s.trim()).filter(Boolean));
    const avoidSet = new Set(Array.isArray(avoid) ? avoid : String(avoid).split(',').map((s) => s.trim()).filter(Boolean));

    const byMode = {
      sea: [],
      air: [],
      rail: [],
      road: [],
      local: [],
    };

    const opts = { avoidSet, includeGeometry };

    if (originNode.id === destNode.id) {
      byMode.local = routeLand(originNode, destNode, opts);
    } else {
      if (requestedModes.has('sea')) byMode.sea = routeSea(originNode, destNode, opts);
      if (requestedModes.has('air')) byMode.air = routeAir(originNode, destNode, opts);
      if (requestedModes.has('rail') || requestedModes.has('road')) {
        const landRoutes = routeLand(originNode, destNode, opts);
        for (const r of landRoutes) {
          if (requestedModes.has(r.mode)) byMode[r.mode].push(r);
        }
      }
    }

    const selected = interleaveDiverseRoutes(byMode, maxRoutes).map((route, i) => ({
      routeId: `${originNode.id}>${destNode.id}|${route.mode}|${i + 1}`,
      ...route,
    }));

    const straightLineKm = +haversineKm(originNode.lon, originNode.lat, destNode.lon, destNode.lat).toFixed(1);

    return {
      graphVersion: compiledGraph.graphVersion,
      origin: {
        id: originNode.id,
        type: originNode.type,
        code: originNode.code ?? null,
        codeStandard: originNode.codeStandard ?? 'custom',
        name_zh: originNode.name_zh,
        name_en: originNode.name_en,
        lon: originNode.lon,
        lat: originNode.lat,
      },
      destination: {
        id: destNode.id,
        type: destNode.type,
        code: destNode.code ?? null,
        codeStandard: destNode.codeStandard ?? 'custom',
        name_zh: destNode.name_zh,
        name_en: destNode.name_en,
        lon: destNode.lon,
        lat: destNode.lat,
      },
      straightLineKm,
      avoid: [...avoidSet],
      routes: selected,
      countsByMode: {
        sea: byMode.sea.length,
        air: byMode.air.length,
        rail: byMode.rail.length,
        road: byMode.road.length,
        local: byMode.local.length,
      },
    };
  }

  function compareDisruption({
    from,
    to,
    modes = ['sea', 'air', 'rail', 'road'],
    avoid = [],
    maxRoutes = 8,
    includeGeometry = false,
  }) {
    const avoidList = [...new Set(avoid)];
    const baseline = findRoutes({ from, to, modes, avoid: [], maxRoutes: 12, includeGeometry });
    const disrupted = findRoutes({ from, to, modes, avoid: avoidList, maxRoutes: 12, includeGeometry });

    const avoidSet = new Set(avoidList);
    const expandedAvoid = new Set(avoidList);
    for (const id of avoidList) {
      for (const c of compiledGraph.chokepoints?.coupledPassages?.[id] ?? []) expandedAvoid.add(c);
    }

    const bestBaseByMode = new Map();
    for (const r of baseline.routes) {
      const curr = bestBaseByMode.get(r.mode);
      if (!curr || r.metrics.transitDays < curr.metrics.transitDays) {
        bestBaseByMode.set(r.mode, r);
      }
    }

    const affected = baseline.routes.filter((r) =>
      r.chokepoints.some((cp) => expandedAvoid.has(cp.id))
    );

    const alternatives = [];
    const landSubstitutions = [];
    for (const r of disrupted.routes) {
      const base = bestBaseByMode.get(r.mode) ?? baseline.routes[0];
      const deltaDays = base ? +(r.metrics.transitDays - base.metrics.transitDays).toFixed(1) : null;
      const costMultiplier = base && base.metrics.costIndex > 0
        ? +(r.metrics.costIndex / base.metrics.costIndex).toFixed(2)
        : null;
      const enriched = { ...r, deltaDays, costMultiplier };
      if (r.mode === 'rail' || r.mode === 'road') {
        landSubstitutions.push(enriched);
      } else {
        alternatives.push(enriched);
      }
    }

    const baselineSea = baseline.routes.filter((r) => r.mode === 'sea');
    const survivingSea = disrupted.routes.filter((r) => r.mode === 'sea');
    const seaCutOff = baselineSea.length > 0 && survivingSea.length === 0;
    const seaDetoured = baselineSea.length > 0 && affected.some((r) => r.mode === 'sea') && survivingSea.length > 0;

    return {
      graphVersion: compiledGraph.graphVersion,
      origin: baseline.origin,
      destination: baseline.destination,
      avoid: [...avoidSet],
      baseline: baseline.routes.slice(0, maxRoutes),
      affected,
      alternatives: alternatives.slice(0, maxRoutes),
      landSubstitutions,
      impactSummary: {
        affectedBaselineRoutes: affected.length,
        totalBaselineRoutes: baseline.routes.length,
        seaCutOff,
        seaDetoured,
        survivingSeaCount: survivingSea.length,
        bestAlternativeDays: alternatives[0]?.metrics.transitDays ?? landSubstitutions[0]?.metrics.transitDays ?? null,
        bestLandDays: landSubstitutions[0]?.metrics.transitDays ?? null,
      },
    };
  }

  return {
    resolveNode,
    searchNodes,
    findRoutes,
    compareDisruption,
    chokepoints: [
      ...(compiledGraph.chokepoints?.passages ?? []),
      ...(compiledGraph.chokepoints?.airspaces ?? []),
    ],
  };
}
