import { greatCircleIntersectsBoxes, greatCirclePoints, haversineKm } from './geo.mjs';
import { borderPenalty, scoreRoute } from './cost-model.mjs';
import { crossesOpenSea } from './land-mask.mjs';

export function createAirRouter(graph) {
  const airports = graph.nodes.filter(
    (n) => (n.type === 'airport' || n.type === 'hub_airport') && Number.isFinite(n.lon) && Number.isFinite(n.lat)
  );
  const cargoHubs = airports.filter((a) => a.isHub);
  const airspaces = graph.chokepoints?.airspaces ?? [];
  const airspaceById = new Map(airspaces.map((a) => [a.id, a]));

  function selectGatewayAirports(node, { maxKm = 220, limit = 2 } = {}) {
    if (node.type === 'airport' || node.type === 'hub_airport') {
      return [{ airport: node, drayageKm: 0 }];
    }
    const candidates = [];
    for (const ap of airports) {
      const d = haversineKm(node.lon, node.lat, ap.lon, ap.lat);
      if (d <= maxKm) {
        const rank = d - (ap.curated ? 50 : 0) - (ap.isHub ? 35 : 0) - (ap.isMajor ? 15 : 0);
        candidates.push({ airport: ap, drayageKm: +d.toFixed(1), rank });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    const overland = candidates.filter(
      ({ airport }) => !crossesOpenSea([node.lon, node.lat], [airport.lon, airport.lat])
    );
    const chosen = overland.length ? overland : candidates;
    return chosen.slice(0, limit).map(({ airport, drayageKm }) => ({ airport, drayageKm }));
  }

  function crossedAirspaces(a, b) {
    const hit = [];
    for (const as of airspaces) {
      if (greatCircleIntersectsBoxes([a.lon, a.lat], [b.lon, b.lat], as.boxes)) {
        hit.push(as.id);
      }
    }
    return hit;
  }

  function buildAirCandidate(originNode, destNode, oa, da, flightSegments, { includeGeometry, isPrimary }) {
    const legs = [];
    const legOptions = [];
    if (oa.airport.id !== originNode.id && oa.drayageKm > 1) {
      const bp = borderPenalty(originNode.country, oa.airport.country);
      legs.push({
        kind: 'drayage',
        mode: 'road',
        from: originNode.id,
        fromName: originNode.name_zh || originNode.name_en,
        to: oa.airport.id,
        toName: oa.airport.name_zh || oa.airport.name_en,
        corridor: '机场短驳',
        distanceKm: oa.drayageKm,
        ...(includeGeometry && {
          geometry: [
            [originNode.lon, originNode.lat],
            [oa.airport.lon, oa.airport.lat],
          ],
        }),
      });
      legOptions.push({ borderDays: bp.days, borderCost: bp.cost, reliabilityDrop: bp.reliabilityDrop });
    }

    const crossedIds = new Set();
    for (const seg of flightSegments) {
      for (const asId of seg.airspaces) crossedIds.add(asId);
      legs.push({
        kind: 'trunk',
        mode: 'air',
        from: seg.from.id,
        fromName: seg.from.name_zh || seg.from.name_en,
        to: seg.to.id,
        toName: seg.to.name_zh || seg.to.name_en,
        distanceKm: seg.distanceKm,
        passages: seg.airspaces,
        ...(includeGeometry && {
          geometry: greatCirclePoints([seg.from.lon, seg.from.lat], [seg.to.lon, seg.to.lat], 18),
        }),
      });
      legOptions.push({});
    }

    if (da.airport.id !== destNode.id && da.drayageKm > 1) {
      const bp = borderPenalty(da.airport.country, destNode.country);
      legs.push({
        kind: 'drayage',
        mode: 'road',
        from: da.airport.id,
        fromName: da.airport.name_zh || da.airport.name_en,
        to: destNode.id,
        toName: destNode.name_zh || destNode.name_en,
        corridor: '机场提货短驳',
        distanceKm: da.drayageKm,
        ...(includeGeometry && {
          geometry: [
            [da.airport.lon, da.airport.lat],
            [destNode.lon, destNode.lat],
          ],
        }),
      });
      legOptions.push({ borderDays: bp.days, borderCost: bp.cost, reliabilityDrop: bp.reliabilityDrop });
    }

    const chokepoints = [...crossedIds].map((id) => {
      const as = airspaceById.get(id);
      return {
        id,
        name_zh: as?.name_zh ?? id,
        name_en: as?.name_en ?? id,
        major: true,
      };
    });

    const nodeSequence = [originNode.id];
    if (oa.airport.id !== originNode.id) nodeSequence.push(oa.airport.id);
    for (const seg of flightSegments) {
      for (const asId of seg.airspaces) {
        if (!nodeSequence.includes(asId)) nodeSequence.push(asId);
      }
      if (!nodeSequence.includes(seg.to.id)) nodeSequence.push(seg.to.id);
    }
    if (da.airport.id !== destNode.id && nodeSequence[nodeSequence.length - 1] !== destNode.id) {
      nodeSequence.push(destNode.id);
    }

    const metrics = scoreRoute('air', legs, { chokepointCount: chokepoints.length, legOptions });
    const viaHubNode = flightSegments.length > 1 ? flightSegments[0].to : null;
    const signature = `air:${oa.airport.id}:${viaHubNode?.id ?? 'DIRECT'}:${da.airport.id}`;

    return {
      mode: 'air',
      modeLabel: '空运',
      likelihood: isPrimary ? 'primary' : 'alternative',
      originGateway: { id: oa.airport.id, name: oa.airport.name_zh || oa.airport.name_en, code: oa.airport.code ?? null },
      destGateway: { id: da.airport.id, name: da.airport.name_zh || da.airport.name_en, code: da.airport.code ?? null },
      ...(viaHubNode && {
        viaHub: {
          id: viaHubNode.id,
          name: viaHubNode.name_zh || viaHubNode.name_en,
          code: viaHubNode.code ?? null,
        },
      }),
      chokepoints,
      nodeSequence,
      legs,
      metrics,
      signature,
    };
  }

  return function routeAir(originNode, destNode, { avoidSet = new Set(), includeGeometry = false } = {}) {
    const originAps = selectGatewayAirports(originNode, { maxKm: 200, limit: 2 });
    const destAps = selectGatewayAirports(destNode, { maxKm: 220, limit: 2 });
    if (!originAps.length || !destAps.length) return [];

    const results = new Map();
    const oa = originAps[0];
    const da = destAps[0];

    if (oa.airport.id === da.airport.id) return [];

    const directKm = +haversineKm(oa.airport.lon, oa.airport.lat, da.airport.lon, da.airport.lat).toFixed(1);
    const directAirspaces = crossedAirspaces(oa.airport, da.airport);
    const directBlocked = directAirspaces.some((id) => avoidSet.has(id));

    // 1. Direct flight (freighter / belly cargo feasible up to ~13,500 km)
    if (directKm <= 13500 && !directBlocked && !avoidSet.has(oa.airport.id) && !avoidSet.has(da.airport.id)) {
      const candidate = buildAirCandidate(
        originNode,
        destNode,
        oa,
        da,
        [{ from: oa.airport, to: da.airport, distanceKm: directKm, airspaces: directAirspaces }],
        { includeGeometry, isPrimary: true }
      );
      results.set(candidate.signature, candidate);
    }

    // 2. Alternative origin gateway (e.g. Shenzhen -> HKG -> Destination) if distinct
    if (originAps.length > 1) {
      const oaAlt = originAps[1];
      const altKm = +haversineKm(oaAlt.airport.lon, oaAlt.airport.lat, da.airport.lon, da.airport.lat).toFixed(1);
      const altAs = crossedAirspaces(oaAlt.airport, da.airport);
      if (altKm <= 13500 && !altAs.some((id) => avoidSet.has(id))) {
        const candidate = buildAirCandidate(
          originNode,
          destNode,
          oaAlt,
          da,
          [{ from: oaAlt.airport, to: da.airport, distanceKm: altKm, airspaces: altAs }],
          { includeGeometry, isPrimary: results.size === 0 }
        );
        results.set(candidate.signature, candidate);
      }
    }

    // 3. 1-stop cargo hub connections (natural detour around blocked airspaces or ultra-long haul)
    const hubOptions = [];
    for (const hub of cargoHubs) {
      if (hub.id === oa.airport.id || hub.id === da.airport.id) continue;
      if (avoidSet.has(hub.id)) continue;
      if (hub.country && (hub.country === oa.airport.country || hub.country === da.airport.country)) continue;

      const d1 = haversineKm(oa.airport.lon, oa.airport.lat, hub.lon, hub.lat);
      const d2 = haversineKm(hub.lon, hub.lat, da.airport.lon, da.airport.lat);
      if (d1 < 800 || d2 < 800 || d1 > 13500 || d2 > 13500) continue;

      const detourRatio = (d1 + d2) / Math.max(1, directKm);
      if (detourRatio > 1.45) continue;

      const as1 = crossedAirspaces(oa.airport, hub);
      const as2 = crossedAirspaces(hub, da.airport);
      if (as1.some((id) => avoidSet.has(id)) || as2.some((id) => avoidSet.has(id))) continue;

      hubOptions.push({
        hub,
        d1: +d1.toFixed(1),
        d2: +d2.toFixed(1),
        as1,
        as2,
        totalKm: d1 + d2,
      });
    }

    hubOptions.sort((a, b) => a.totalKm - b.totalKm);
    const chosenHubs = [];
    for (const opt of hubOptions) {
      if (chosenHubs.length >= 3) break;
      const tooClose = chosenHubs.some(
        (c) => haversineKm(c.hub.lon, c.hub.lat, opt.hub.lon, opt.hub.lat) < 400
      );
      if (tooClose) continue;
      chosenHubs.push(opt);
      const candidate = buildAirCandidate(
        originNode,
        destNode,
        oa,
        da,
        [
          { from: oa.airport, to: opt.hub, distanceKm: opt.d1, airspaces: opt.as1 },
          { from: opt.hub, to: da.airport, distanceKm: opt.d2, airspaces: opt.as2 },
        ],
        { includeGeometry, isPrimary: results.size === 0 }
      );
      if (!results.has(candidate.signature)) {
        results.set(candidate.signature, candidate);
      }
    }

    const list = [...results.values()].sort((a, b) => a.metrics.transitDays - b.metrics.transitDays);
    if (list.length > 0) {
      list[0].likelihood = 'primary';
      for (let i = 1; i < list.length; i++) {
        list[i].likelihood = list[i].legs.filter((l) => l.mode === 'air').length === 1 ? 'primary' : 'alternative';
      }
    }
    return list;
  };
}
