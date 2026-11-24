import { haversineKm, normalizeLon } from './geo.mjs';
import { createSeaRouter } from './sea-router.mjs';
import { createAirRouter } from './air-router.mjs';
import { createLandRouter } from './land-router.mjs';
import endpointNamesZh from '../../data/curated/endpoint-names-zh.json' with { type: 'json' };
import portGroups from '../../data/curated/port-groups.json' with { type: 'json' };

const fold = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();
const passageTypes = new Set(['chokepoint', 'airspace', 'sea_area']);
const localizedNames = (id) => Object.hasOwn(endpointNamesZh, id) ? endpointNamesZh[id] : [];

export function createRouter(compiledGraph) {
  const nodes = compiledGraph.nodes ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeByLegacyId = new Map();
  const nodeByCode = new Map();
  const nodesByAlias = new Map();
  const searchTermsById = new Map();
  const portGroupNamesById = new Map();
  const landConnectionsByNode = new Map();

  for (const [cityId, { aliases, ports }] of Object.entries(portGroups)) {
    const city = nodeById.get(cityId);
    if (!city) continue;
    const names = [city.name_zh, city.name_en, ...localizedNames(cityId), ...aliases].map(fold).filter(Boolean);
    for (const portId of ports) {
      const port = nodeById.get(portId);
      if (!port || (port.type !== 'port' && !port.functions?.includes('port'))) continue;
      portGroupNamesById.set(portId, [...(portGroupNamesById.get(portId) ?? []), ...names]);
    }
  }

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
    const names = [
      node.name_zh,
      node.name_en,
      ...localizedNames(node.id),
    ].map(fold).filter(Boolean);
    const codes = [node.id, node.code, ...(node.legacyIds ?? [])].map(fold).filter(Boolean);
    const groupAliases = Object.hasOwn(portGroups, node.id) ? portGroups[node.id].aliases : [];
    const aliases = [...(node.aliases ?? []), ...groupAliases].map(fold).filter(Boolean);
    searchTermsById.set(node.id, { names, codes, aliases });
    for (const k of new Set([
      ...names, ...codes, ...aliases,
    ])) {
      if (!nodesByAlias.has(k)) nodesByAlias.set(k, []);
      nodesByAlias.get(k).push(node);
    }
  }

  const routeSea = createSeaRouter(compiledGraph, landConnectionsByNode, portGroups);
  const routeAir = createAirRouter(compiledGraph);
  const routeLand = createLandRouter(compiledGraph);

  function resolveNode(query) {
    if (!query) return null;
    if (typeof query === 'object' && Number.isFinite(query.lon) && Number.isFinite(query.lat)) {
      if (query.id && nodeById.has(query.id)) return nodeById.get(query.id);
      const label = query.name_zh || query.name_en || query.name || `${query.lon.toFixed(2)}, ${query.lat.toFixed(2)}`;
      return {
        ...query,
        id: query.id || `COORD_${query.lon.toFixed(2)}_${query.lat.toFixed(2)}`,
        type: query.type || 'custom',
        codeStandard: query.codeStandard || 'custom',
        name_zh: query.name_zh || label,
        name_en: query.name_en || label,
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

  function searchNodes({ q = '', type = '', limit = 20, endpoint = false } = {}) {
    const query = fold(q);
    const matches = [];
    for (const n of nodes) {
      if (n.type === 'country') continue;
      if (endpoint && passageTypes.has(n.type)) continue;
      if (type && n.type !== type) continue;
      if (!query) {
        if (n.curated || n.isMajor) matches.push({ node: n, score: n.curated ? 100 : 50 });
        continue;
      }
      const { names, codes, aliases } = searchTermsById.get(n.id);
      let score = 0;
      if (codes.includes(query) || names.includes(query)) score = 200;
      else if (aliases.includes(query)) score = 180;
      else if ([...codes, ...names, ...aliases].some((term) => term.startsWith(query))) score = 120;
      else if ([...names, ...aliases].some((term) => term.includes(query))) score = 60;
      if (endpoint && score < 150) {
        const groupNames = portGroupNamesById.get(n.id) ?? [];
        if (groupNames.some((group) => {
          if (!query.startsWith(group)) return false;
          const portQuery = query.slice(group.length).trim();
          return !portQuery || [...names, ...aliases].some((term) => term.startsWith(portQuery));
        })) score = 150;
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
      name_zh: (endpoint && localizedNames(node.id)[0]) || node.name_zh,
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

  function waypointRole(node, index, lastIndex) {
    if (index === 0) return 'origin';
    if (index === lastIndex) return 'destination';
    if (node.type === 'chokepoint' || node.type === 'airspace' || node.type === 'sea_area') {
      return 'chokepoint';
    }
    if (node.type === 'rail_border' || node.type === 'border') return 'border';
    if (node.type === 'port' || node.type === 'airport' || node.type === 'hub_airport') return 'gateway';
    return 'hub';
  }

  function buildWaypoints(nodeSequence, originNode, destNode) {
    const resolved = [];
    const seen = new Set();
    for (const id of nodeSequence ?? []) {
      if (seen.has(id)) continue;
      const node =
        id === originNode.id ? originNode : id === destNode.id ? destNode : nodeById.get(id);
      if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) continue;
      seen.add(id);
      resolved.push(node);
    }
    const lastIdx = resolved.length - 1;
    return resolved.map((node, idx) => ({
      id: node.id,
      type: node.type,
      name_zh: node.name_zh || node.name_en || node.id,
      name_en: node.name_en || node.name_zh || node.id,
      lon: node.lon,
      lat: node.lat,
      role: waypointRole(node, idx, lastIdx),
    }));
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
      waypoints: buildWaypoints(route.nodeSequence, originNode, destNode),
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
