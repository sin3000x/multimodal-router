import {
  compilePolygonRings,
  greatCirclePoints,
  haversineKm,
  pointInBox,
  pointInCompiledRings,
} from './geo.mjs';
import { borderPenalty, scoreRoute } from './cost-model.mjs';
import { crossesOpenSea } from './land-mask.mjs';

// Active Ukraine conflict airspace avoided by all civil flights by default
const DEFAULT_CLOSED_BOXES = [
  { minLon: 23.0, maxLon: 40.0, minLat: 45.2, maxLat: 52.0 },
];

const AIRWAY_CORRIDORS = [
  // Black Sea South (Turkey) bypass for Ukraine
  [[31.0, 41.3]],
  // Black Sea North / Belarus-Baltic bypass
  [[39.0, 54.0]],
  // Middle / Caspian Corridor (bypasses AS_RUSSIA + Ukraine + AS_MIDEAST north)
  [[77.0, 43.2], [50.2, 40.4], [31.0, 41.3]],
  // Southern Arabian - Red Sea Corridor (bypasses AS_RUSSIA + Ukraine + AS_MIDEAST conflict boxes)
  [[64.0, 21.5], [45.0, 24.5], [33.5, 26.8]],
  // Polar / North Pacific Anchorage Corridor
  [[165.0, 50.0], [-150.0, 61.2], [-45.0, 67.0]],
];

export function createAirRouter(graph) {
  const airports = graph.nodes.filter(
    (n) => (n.type === 'airport' || n.type === 'hub_airport') && Number.isFinite(n.lon) && Number.isFinite(n.lat)
  );
  const airportById = new Map(airports.map((a) => [a.id, a]));
  const cargoHubs = airports.filter((a) => a.isHub);
  const airspaces = (graph.chokepoints?.airspaces ?? []).map((as) => ({
    ...as,
    compiledPolygons: compilePolygonRings(as.polygons ?? []),
  }));
  const airspaceById = new Map(airspaces.map((a) => [a.id, a]));
  const defaultClosedPolygons = compilePolygonRings(
    (graph.chokepoints?.defaultClosedAirspaces ?? []).flatMap((a) => a.polygons ?? [])
  );

  const airAdj = new Map();
  for (const [u, v, carriers = 1, freighter = 0] of graph.airnet?.edges ?? []) {
    if (!airAdj.has(u)) airAdj.set(u, new Map());
    if (!airAdj.has(v)) airAdj.set(v, new Map());
    const meta = { carriers, isFreighter: Boolean(freighter) };
    airAdj.get(u).set(v, meta);
    airAdj.get(v).set(u, meta);
  }
  const hasAirnet = airAdj.size > 0;

  function getAirEdge(aId, bId) {
    return airAdj.get(aId)?.get(bId) ?? null;
  }

  function selectGatewayAirports(node, { maxKm = 220, limit = 2 } = {}) {
    if (node.type === 'airport' || node.type === 'hub_airport') {
      return [{ airport: node, drayageKm: 0 }];
    }
    const candidates = [];
    for (const ap of airports) {
      const d = haversineKm(node.lon, node.lat, ap.lon, ap.lat);
      if (d <= maxKm) {
        const routeBonus = Math.min(30, (ap.routeCount ?? 0) * 0.15);
        const rank = d - (ap.curated ? 45 : 0) - (ap.isHub ? 45 : 0) - routeBonus - (ap.isMajor ? 15 : 0);
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

  function pointInAirspace(pt, as) {
    if (as.compiledPolygons?.length) return pointInCompiledRings(pt, as.compiledPolygons);
    return (as.boxes ?? []).some((box) => pointInBox(pt, box));
  }

  function pointInDefaultClosed(pt) {
    if (defaultClosedPolygons.length) return pointInCompiledRings(pt, defaultClosedPolygons);
    return DEFAULT_CLOSED_BOXES.some((box) => pointInBox(pt, box));
  }

  function crossedAirspacesForPoints(pts) {
    const hit = [];
    for (const as of airspaces) {
      if (pts.some((pt) => pointInAirspace(pt, as))) {
        hit.push(as.id);
      }
    }
    return hit;
  }

  function pointsCrossRestricted(pts, restrictedAirspaces, includeDefaultClosed) {
    if (!restrictedAirspaces.length && !includeDefaultClosed) return false;
    return pts.some(
      (pt) =>
        restrictedAirspaces.some((as) => pointInAirspace(pt, as)) ||
        (includeDefaultClosed && pointInDefaultClosed(pt))
    );
  }

  function polylinePoints(waypoints, stepsPerSeg = 10) {
    const coords = [];
    let distanceKm = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      distanceKm += haversineKm(a[0], a[1], b[0], b[1]);
      const seg = greatCirclePoints(a, b, stepsPerSeg);
      for (let j = 0; j < seg.length; j++) {
        if (coords.length > 0 && j === 0) continue;
        coords.push(seg[j]);
      }
    }
    return { coords, distanceKm };
  }

  function planAirSegment(fromAp, toAp, avoidSet) {
    const userBlocked = airspaces.filter((a) => avoidSet.has(a.id));
    if (
      userBlocked.some((as) => pointInAirspace([fromAp.lon, fromAp.lat], as)) ||
      userBlocked.some((as) => pointInAirspace([toAp.lon, toAp.lat], as))
    ) {
      return null;
    }

    const endpointsInUkraine =
      pointInDefaultClosed([fromAp.lon, fromAp.lat]) ||
      pointInDefaultClosed([toAp.lon, toAp.lat]);
    const checkDefaultClosed = !endpointsInUkraine;

    const directKm = haversineKm(fromAp.lon, fromAp.lat, toAp.lon, toAp.lat);
    const gcPts = greatCirclePoints([fromAp.lon, fromAp.lat], [toAp.lon, toAp.lat], 22);
    const gcCrossed = crossedAirspacesForPoints(gcPts);

    if (!pointsCrossRestricted(gcPts, userBlocked, checkDefaultClosed)) {
      return {
        distanceKm: +directKm.toFixed(1),
        airspaces: gcCrossed,
        coords: gcPts,
        detouredAirspace: false,
        detourReason: null,
      };
    }

    const hitUserAvoid = gcCrossed.some((id) => avoidSet.has(id));
    const minLon = Math.min(fromAp.lon, toAp.lon) - 12;
    const maxLon = Math.max(fromAp.lon, toAp.lon) + 12;
    const flyingWest = toAp.lon < fromAp.lon;

    let best = null;
    for (const rawCorridor of AIRWAY_CORRIDORS) {
      const ordered = flyingWest ? rawCorridor : [...rawCorridor].reverse();
      const wps = ordered.filter(([lon]) => lon >= minLon && lon <= maxLon);
      if (!wps.length) continue;

      const { coords, distanceKm } = polylinePoints(
        [[fromAp.lon, fromAp.lat], ...wps, [toAp.lon, toAp.lat]],
        10
      );
      if (distanceKm > Math.min(13800, directKm * 1.42)) continue;
      if (pointsCrossRestricted(coords, userBlocked, checkDefaultClosed)) continue;

      if (!best || distanceKm < best.distanceKm) {
        best = {
          distanceKm: +distanceKm.toFixed(1),
          airspaces: crossedAirspacesForPoints(coords),
          coords,
          detouredAirspace: hitUserAvoid,
          detourReason: hitUserAvoid ? '空中走廊绕飞' : null,
        };
      }
    }
    return best;
  }

  function buildAirCandidate(
    originNode,
    destNode,
    oa,
    da,
    flightSegments,
    { includeGeometry, isPrimary, detourReason = null }
  ) {
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
          geometry: seg.coords ?? greatCirclePoints([seg.from.lon, seg.from.lat], [seg.to.lon, seg.to.lat], 18),
        }),
      });
      legOptions.push({
        isTechStop: Boolean(seg.isTechStop),
        thinRoute: Boolean(seg.thinRoute),
        airwayDetourDays: seg.detouredAirspace ? 0.25 : 0,
        airwayDetourCost: seg.detouredAirspace ? 1.6 : 0,
      });
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
    const viaHubs = flightSegments.slice(0, -1).map((s) => s.to);
    const viaKey = viaHubs.length ? viaHubs.map((h) => h.id).join('+') : 'DIRECT';
    const signature = `air:${oa.airport.id}:${viaKey}:${da.airport.id}`;

    return {
      mode: 'air',
      modeLabel: '空运',
      likelihood: isPrimary ? 'primary' : 'alternative',
      ...(detourReason && { detourReason }),
      originGateway: { id: oa.airport.id, name: oa.airport.name_zh || oa.airport.name_en, code: oa.airport.code ?? null },
      destGateway: { id: da.airport.id, name: da.airport.name_zh || da.airport.name_en, code: da.airport.code ?? null },
      ...(viaHubs.length === 1 && {
        viaHub: {
          id: viaHubs[0].id,
          name: viaHubs[0].name_zh || viaHubs[0].name_en,
          code: viaHubs[0].code ?? null,
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

    // 1. Real non-stop flights across gateway combinations
    for (const oaCand of originAps) {
      for (const daCand of destAps) {
        if (oaCand.airport.id === daCand.airport.id) continue;
        if (avoidSet.has(oaCand.airport.id) || avoidSet.has(daCand.airport.id)) continue;

        const directKm = haversineKm(oaCand.airport.lon, oaCand.airport.lat, daCand.airport.lon, daCand.airport.lat);
        if (directKm > 13500) continue;

        const edge = hasAirnet ? getAirEdge(oaCand.airport.id, daCand.airport.id) : { carriers: 2, isFreighter: false };
        if (!edge) continue;

        const seg = planAirSegment(oaCand.airport, daCand.airport, avoidSet);
        if (!seg) continue;

        const candidate = buildAirCandidate(
          originNode,
          destNode,
          oaCand,
          daCand,
          [{
            from: oaCand.airport,
            to: daCand.airport,
            distanceKm: seg.distanceKm,
            airspaces: seg.airspaces,
            coords: seg.coords,
            detouredAirspace: seg.detouredAirspace,
            thinRoute: edge.carriers === 1 && !edge.isFreighter,
          }],
          { includeGeometry, isPrimary: results.size === 0, detourReason: seg.detourReason }
        );
        if (!results.has(candidate.signature)) results.set(candidate.signature, candidate);
      }
    }

    // 2. Trans-Pacific ANC tech-stop for ultra-long-haul freighter routes (> 8,500 km)
    const ancNode = airportById.get('ANC');
    const primaryDirectKm = haversineKm(oa.airport.lon, oa.airport.lat, da.airport.lon, da.airport.lat);
    if (ancNode && !avoidSet.has('ANC') && primaryDirectKm > 8500) {
      for (const oaCand of originAps) {
        const e1 = hasAirnet ? getAirEdge(oaCand.airport.id, 'ANC') : { carriers: 3, isFreighter: true };
        const e2 = hasAirnet ? getAirEdge('ANC', da.airport.id) : { carriers: 3, isFreighter: true };
        if (!e1 || !e2) continue;
        const d1 = haversineKm(oaCand.airport.lon, oaCand.airport.lat, ancNode.lon, ancNode.lat);
        const d2 = haversineKm(ancNode.lon, ancNode.lat, da.airport.lon, da.airport.lat);
        if ((d1 + d2) / Math.max(1, primaryDirectKm) > 1.28) continue;

        const seg1 = planAirSegment(oaCand.airport, ancNode, avoidSet);
        const seg2 = planAirSegment(ancNode, da.airport, avoidSet);
        if (!seg1 || !seg2) continue;

        const candidate = buildAirCandidate(
          originNode,
          destNode,
          oaCand,
          da,
          [
            {
              from: oaCand.airport,
              to: ancNode,
              distanceKm: seg1.distanceKm,
              airspaces: seg1.airspaces,
              coords: seg1.coords,
              detouredAirspace: seg1.detouredAirspace,
            },
            {
              from: ancNode,
              to: da.airport,
              distanceKm: seg2.distanceKm,
              airspaces: seg2.airspaces,
              coords: seg2.coords,
              detouredAirspace: seg2.detouredAirspace,
              isTechStop: true,
            },
          ],
          { includeGeometry, isPrimary: results.size === 0, detourReason: '安克雷奇技术经停' }
        );
        if (!results.has(candidate.signature)) results.set(candidate.signature, candidate);
      }
    }

    // 3. Real 1-stop hub connections
    const hubOptions = [];
    for (const oaCand of originAps) {
      const neighbors = hasAirnet ? airAdj.get(oaCand.airport.id) : null;
      const pool = neighbors
        ? [...neighbors.keys()].map((id) => airportById.get(id)).filter(Boolean)
        : cargoHubs;

      for (const hub of pool) {
        if (hub.id === oaCand.airport.id || hub.id === da.airport.id) continue;
        if (avoidSet.has(hub.id)) continue;
        if (!hub.isHub && (hub.routeCount ?? 0) < 25) continue;
        if (
          oaCand.airport.country !== da.airport.country &&
          hub.country &&
          (hub.country === oaCand.airport.country || hub.country === da.airport.country)
        ) {
          continue;
        }

        const e1 = hasAirnet ? neighbors.get(hub.id) : { carriers: 2, isFreighter: false };
        const e2 = hasAirnet ? getAirEdge(hub.id, da.airport.id) : { carriers: 2, isFreighter: false };
        if (!e1 || !e2) continue;

        const d1 = haversineKm(oaCand.airport.lon, oaCand.airport.lat, hub.lon, hub.lat);
        const d2 = haversineKm(hub.lon, hub.lat, da.airport.lon, da.airport.lat);
        if (d1 < 350 || d2 < 350 || d1 > 13500 || d2 > 13500) continue;

        const maxDetour = primaryDirectKm > 12000 ? 1.75 : 1.55;
        if ((d1 + d2) / Math.max(200, primaryDirectKm) > maxDetour) continue;

        const carrierBonus = Math.min(800, (e1.carriers + e2.carriers) * 35);
        const hubBonus = (hub.isHub ? 600 : 0) + (e1.isFreighter || e2.isFreighter ? 250 : 0);
        hubOptions.push({
          oaCand,
          hub,
          e1,
          e2,
          totalKm: d1 + d2,
          score: d1 + d2 - hubBonus - carrierBonus,
        });
      }
    }

    hubOptions.sort((a, b) => a.score - b.score);
    const chosenHubs = [];
    for (const opt of hubOptions) {
      if (chosenHubs.length >= 3) break;
      const tooClose = chosenHubs.some(
        (c) => haversineKm(c.hub.lon, c.hub.lat, opt.hub.lon, opt.hub.lat) < 400
      );
      if (tooClose) continue;

      const seg1 = planAirSegment(opt.oaCand.airport, opt.hub, avoidSet);
      const seg2 = seg1 ? planAirSegment(opt.hub, da.airport, avoidSet) : null;
      if (!seg1 || !seg2) continue;

      chosenHubs.push(opt);
      const candidate = buildAirCandidate(
        originNode,
        destNode,
        opt.oaCand,
        da,
        [
          {
            from: opt.oaCand.airport,
            to: opt.hub,
            distanceKm: seg1.distanceKm,
            airspaces: seg1.airspaces,
            coords: seg1.coords,
            detouredAirspace: seg1.detouredAirspace,
            thinRoute: opt.e1.carriers === 1 && !opt.e1.isFreighter,
          },
          {
            from: opt.hub,
            to: da.airport,
            distanceKm: seg2.distanceKm,
            airspaces: seg2.airspaces,
            coords: seg2.coords,
            detouredAirspace: seg2.detouredAirspace,
            thinRoute: opt.e2.carriers === 1 && !opt.e2.isFreighter,
          },
        ],
        { includeGeometry, isPrimary: results.size === 0 }
      );
      if (!results.has(candidate.signature)) results.set(candidate.signature, candidate);
    }

    // 4. 2-stop hub fallback for remote destinations when no 0-stop or 1-stop exists
    if (results.size === 0 && hasAirnet) {
      const twoStopOptions = [];
      const oaNeighbors = airAdj.get(oa.airport.id);
      if (oaNeighbors) {
        for (const h1 of cargoHubs) {
          if (h1.id === oa.airport.id || h1.id === da.airport.id || avoidSet.has(h1.id)) continue;
          const e1 = oaNeighbors.get(h1.id);
          if (!e1) continue;
          const h1Neighbors = airAdj.get(h1.id);
          if (!h1Neighbors) continue;
          for (const [h2Id, e2] of h1Neighbors.entries()) {
            const h2 = airportById.get(h2Id);
            if (!h2 || h2.id === oa.airport.id || h2.id === da.airport.id || avoidSet.has(h2.id)) continue;
            if (!h2.isHub && (h2.routeCount ?? 0) < 30) continue;
            const e3 = getAirEdge(h2.id, da.airport.id);
            if (!e3) continue;
            const d1 = haversineKm(oa.airport.lon, oa.airport.lat, h1.lon, h1.lat);
            const d2 = haversineKm(h1.lon, h1.lat, h2.lon, h2.lat);
            const d3 = haversineKm(h2.lon, h2.lat, da.airport.lon, da.airport.lat);
            if ((d1 + d2 + d3) / Math.max(200, primaryDirectKm) > 1.85) continue;
            twoStopOptions.push({ h1, h2, e1, e2, e3, totalKm: d1 + d2 + d3 });
          }
        }
      }
      twoStopOptions.sort((a, b) => a.totalKm - b.totalKm);
      for (const opt of twoStopOptions.slice(0, 4)) {
        const s1 = planAirSegment(oa.airport, opt.h1, avoidSet);
        const s2 = s1 ? planAirSegment(opt.h1, opt.h2, avoidSet) : null;
        const s3 = s2 ? planAirSegment(opt.h2, da.airport, avoidSet) : null;
        if (!s1 || !s2 || !s3) continue;
        const candidate = buildAirCandidate(
          originNode,
          destNode,
          oa,
          da,
          [
            { from: oa.airport, to: opt.h1, distanceKm: s1.distanceKm, airspaces: s1.airspaces, coords: s1.coords, detouredAirspace: s1.detouredAirspace },
            { from: opt.h1, to: opt.h2, distanceKm: s2.distanceKm, airspaces: s2.airspaces, coords: s2.coords, detouredAirspace: s2.detouredAirspace },
            { from: opt.h2, to: da.airport, distanceKm: s3.distanceKm, airspaces: s3.airspaces, coords: s3.coords, detouredAirspace: s3.detouredAirspace },
          ],
          { includeGeometry, isPrimary: true }
        );
        results.set(candidate.signature, candidate);
        break;
      }
    }

    const list = [...results.values()].sort((a, b) => a.metrics.transitDays - b.metrics.transitDays);
    if (list.length > 0) {
      const minDays = list[0].metrics.transitDays;
      for (let i = 0; i < list.length; i++) {
        list[i].likelihood = i === 0 || list[i].metrics.transitDays <= minDays + 0.35 ? 'primary' : 'alternative';
      }
    }
    return list;
  };
}
