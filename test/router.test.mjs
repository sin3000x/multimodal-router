import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../src/engine/router.mjs';
import { createRouteCache } from '../src/cache/route-cache.mjs';
import { crossesOpenSea } from '../src/engine/land-mask.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const graph = JSON.parse(await readFile(join(ROOT_DIR, 'data', 'compiled', 'graph.json'), 'utf8'));
const router = createRouter(graph);

test('Node IDs reuse ISO-3166-1, IATA, and UN/LOCODE standard codes without synthetic prefixes', () => {
  const badPrefixes = /^(UNLOC_|IATA_|CITY_|PORT_|AP_|CTY_)/;
  const badIds = graph.nodes.filter((n) => badPrefixes.test(n.id)).map((n) => n.id);
  assert.deepEqual(badIds, []);

  assert.equal(router.resolveNode('CNSZX')?.id, 'CNSZX');
  assert.equal(router.resolveNode('NLRTM')?.id, 'NLRTM');
  assert.equal(router.resolveNode('SZX')?.id, 'SZX');
  assert.equal(router.resolveNode('CN')?.id, 'CN');

  // Legacy IDs resolve cleanly to canonical standard IDs
  assert.equal(router.resolveNode('CITY_SZ')?.id, 'CNSZX');
  assert.equal(router.resolveNode('PORT_YANTIAN')?.id, 'CNYTN');
  assert.equal(router.resolveNode('AP_SZX')?.id, 'SZX');
  assert.equal(router.resolveNode('RAIL_DUISBURG')?.id, 'DEDUI');

  // Decoupled clean geographic names
  assert.equal(router.resolveNode('CP_CAPE')?.name_zh, '好望角');
  assert.equal(router.resolveNode('AS_MIDEAST')?.name_zh, '中东空域');
  assert.equal(router.resolveNode('CNALA')?.name_zh, '阿拉山口');
});

test('CNSZX -> NLAMS returns Suez sea, Cape sea detour, air, and China-Europe rail', () => {
  const res = router.findRoutes({
    from: 'CNSZX',
    to: 'NLAMS',
    maxRoutes: 12,
    includeGeometry: true,
  });

  assert.equal(res.origin.id, 'CNSZX');
  assert.equal(res.destination.id, 'NLAMS');

  const seaRoutes = res.routes.filter((r) => r.mode === 'sea');
  const airRoutes = res.routes.filter((r) => r.mode === 'air');
  const railRoutes = res.routes.filter((r) => r.mode === 'rail');

  assert.ok(seaRoutes.length >= 2, 'should generate multiple sea options');
  assert.ok(
    seaRoutes.some((r) => r.chokepoints.some((c) => c.id === 'CP_SUEZ')),
    'primary sea should cross CP_SUEZ'
  );
  assert.ok(
    seaRoutes.some((r) => r.destGateway.id === 'NLRTM'),
    'should route via Rotterdam (NLRTM)'
  );
  assert.ok(
    seaRoutes.some((r) => r.chokepoints.some((c) => c.id === 'CP_CAPE')),
    'alternative sea should detour via CP_CAPE'
  );
  assert.ok(airRoutes.length >= 1, 'should include air options');
  assert.ok(
    railRoutes.some((r) =>
      r.chokepoints.some((c) => c.id === 'CNALA' || c.id === 'RB_KHORGOS')
    ),
    'should include China-Europe rail via CNALA or RB_KHORGOS'
  );
  assert.ok(seaRoutes[0].legs.every((l) => Array.isArray(l.geometry) && l.geometry.length >= 2));
  assert.ok(Array.isArray(seaRoutes[0].waypoints) && seaRoutes[0].waypoints.length >= 4);
  assert.equal(seaRoutes[0].waypoints[0].role, 'origin');
  assert.equal(seaRoutes[0].waypoints[seaRoutes[0].waypoints.length - 1].role, 'destination');
  assert.ok(seaRoutes[0].waypoints.some((w) => w.role === 'chokepoint' && w.id === 'CP_SUEZ'));
});

test('CNSZX -> AEDXB with avoid CP_HORMUZ uses Jebel Ali as baseline and bypasses via east-coast port', () => {
  const cmp = router.compareDisruption({
    from: '深圳',
    to: '迪拜',
    avoid: ['CP_HORMUZ'],
    maxRoutes: 10,
  });

  assert.equal(cmp.origin.id, 'CNSZX');
  assert.equal(cmp.destination.id, 'AEDXB');

  const baseSea = cmp.baseline.filter((r) => r.mode === 'sea');
  assert.ok(baseSea.length >= 2, 'should have baseline sea routes');
  assert.equal(baseSea[0].destGateway.id, 'AEJEA', 'primary baseline port for Dubai should be Jebel Ali (AEJEA)');
  assert.ok(
    baseSea[0].chokepoints.some((c) => c.id === 'CP_HORMUZ'),
    'primary baseline for Dubai should cross CP_HORMUZ'
  );
  assert.ok(
    !baseSea.some((r) => r.destGateway.id === 'AEMSA'),
    'should not surface minor bulk port AEMSA when major hubs exist'
  );

  assert.ok(
    cmp.affected.some((r) => r.chokepoints.some((c) => c.id === 'CP_HORMUZ')),
    'baseline should cross CP_HORMUZ'
  );
  const altSea = cmp.alternatives.filter((r) => r.mode === 'sea');
  assert.ok(altSea.length >= 1, 'should discover sea port outside Hormuz');
  assert.ok(
    ['AEKLF', 'AEFJR'].includes(altSea[0].destGateway.id),
    `expected UAE east-coast bypass port, got ${altSea[0].destGateway.id}`
  );
  assert.ok(
    altSea.every((r) => !r.chokepoints.some((c) => c.id === 'CP_HORMUZ')),
    'surviving sea route must not cross CP_HORMUZ'
  );
  assert.ok(altSea[0].deltaDays > 0, `expected positive detour delay, got ${altSea[0].deltaDays}`);
  assert.ok(altSea[0].costMultiplier > 1, `expected cost increase on detour, got ${altSea[0].costMultiplier}`);
});

test('Major destination cities select realistic primary maritime hubs', () => {
  const lonSea = router.findRoutes({ from: 'CNSZX', to: 'GBLON', modes: ['sea'], maxRoutes: 6 }).routes;
  assert.equal(lonSea[0].destGateway.id, 'GBLGP', 'London primary gateway should be London Gateway (GBLGP)');

  const ruhSea = router.findRoutes({ from: 'CNSZX', to: 'SARUH', modes: ['sea'], maxRoutes: 6 }).routes;
  assert.equal(ruhSea[0].destGateway.id, 'SADMM', 'Riyadh primary gateway should be Dammam rail corridor (SADMM)');
});

test('Trans-Pacific CNSZX -> MXMEX crosses antimeridian cleanly and offers Panama east-coast option', () => {
  const res = router.findRoutes({
    from: 'CNSZX',
    to: 'MXMEX',
    modes: ['sea', 'air'],
    maxRoutes: 10,
  });

  const seaRoutes = res.routes.filter((r) => r.mode === 'sea');
  assert.ok(seaRoutes.length >= 2);
  const pacificDirect = seaRoutes[0];
  assert.ok(pacificDirect.metrics.distanceKm < 16500, `Expected trans-Pacific < 16500km, got ${pacificDirect.metrics.distanceKm}`);
  assert.ok(
    seaRoutes.some((r) => r.chokepoints.some((c) => c.id === 'CP_PANAMA')),
    'should also provide Atlantic gateway via CP_PANAMA'
  );
});

test('Airspace avoidance on AS_RUSSIA produces non-Russian hub routing for SZX -> AMS', () => {
  const res = router.findRoutes({
    from: 'SZX',
    to: 'AMS',
    modes: ['air'],
    avoid: ['AS_RUSSIA'],
    maxRoutes: 6,
  });

  assert.ok(res.routes.length >= 1, 'should find air detour avoiding Russian airspace');
  for (const r of res.routes) {
    assert.ok(
      !r.chokepoints.some((c) => c.id === 'AS_RUSSIA'),
      `Route ${r.routeId} still crossed AS_RUSSIA`
    );
  }
});

test('Two-tier cache serves memory hit and persists across fresh SQLite instances', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mmr-cache-'));
  const dbPath = join(tempDir, 'cache.sqlite');

  try {
    const cache1 = createRouteCache({ dbPath, graphVersion: graph.graphVersion });
    const params = {
      from: 'CNSZX',
      to: 'NLAMS',
      modes: ['sea', 'air'],
      avoid: [],
      maxRoutes: 6,
      includeGeometry: false,
    };

    const first = await cache1.getOrCompute('routes', params, () => router.findRoutes(params));
    assert.equal(first.cache.hit, false);
    assert.equal(first.cache.layer, 'compute');

    const second = await cache1.getOrCompute('routes', params, () => {
      throw new Error('Should not recompute on memory hit');
    });
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.layer, 'memory');
    cache1.close();

    const cache2 = createRouteCache({ dbPath, graphVersion: graph.graphVersion });
    const third = await cache2.getOrCompute('routes', params, () => {
      throw new Error('Should not recompute on SQLite hit');
    });
    assert.equal(third.cache.hit, true);
    assert.equal(third.cache.layer, 'sqlite');
    assert.equal(third.value.routes.length, first.value.routes.length);
    cache2.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('selectGatewayPorts excludes ports separated by open sea (e.g. IRKIH -> AEDXB)', () => {
  const dxbSea = router.findRoutes({ from: 'CNSZX', to: 'AEDXB', modes: ['sea'], maxRoutes: 8 }).routes;
  assert.ok(dxbSea.some((r) => r.destGateway.id === 'AEJEA'));
  assert.ok(dxbSea.some((r) => r.destGateway.id === 'AEKLF'));
  assert.ok(!dxbSea.some((r) => r.destGateway.id === 'IRKIH'), 'should not route Dubai via Kish Island across Persian Gulf');

  const kwiSea = router.findRoutes({ from: 'CNSZX', to: 'KWKWI', modes: ['sea'], maxRoutes: 8 }).routes;
  assert.ok(!kwiSea.some((r) => r.destGateway.id === 'IRMRX'), 'should not route Kuwait via Bandar Mahshahr across sea');

  const jktSea = router.findRoutes({ from: 'CNSZX', to: 'IDJKT', modes: ['sea'], maxRoutes: 8 }).routes;
  assert.ok(!jktSea.some((r) => r.destGateway.id === 'IDPJG'), 'should not route Jakarta via Panjang across Sunda Strait');

  const dohSea = router.findRoutes({ from: 'CNSZX', to: 'QADOH', modes: ['sea'], maxRoutes: 8 }).routes;
  assert.ok(!dohSea.some((r) => r.destGateway.id === 'SADMM'), 'should not route Doha via Dammam across Gulf waters');

  const mctSea = router.findRoutes({ from: 'CNSZX', to: 'OMMCT', modes: ['sea'], maxRoutes: 8, includeGeometry: true }).routes;
  assert.equal(mctSea[0].destGateway.id, 'OMMCT');
  const sohViaMct = mctSea.find((r) => r.destGateway.id === 'OMSOH');
  if (sohViaMct) {
    const dray = sohViaMct.legs[sohViaMct.legs.length - 1];
    assert.ok(dray.geometry.length >= 4, 'coastal corridor should use curved overland polyline');
    for (let i = 1; i < dray.geometry.length; i++) {
      assert.equal(crossesOpenSea(dray.geometry[i - 1], dray.geometry[i]), false);
    }
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const pt = (id) => [nodeById.get(id).lon, nodeById.get(id).lat];
  assert.equal(crossesOpenSea(pt('IRKIH'), pt('AEDXB')), true);
  assert.equal(crossesOpenSea(pt('IDPJG'), pt('IDJKT')), true);
  assert.equal(crossesOpenSea(pt('OMSOH'), pt('OMMCT')), true);
  assert.equal(crossesOpenSea(pt('AEKLF'), pt('AEDXB')), false);
  assert.equal(crossesOpenSea(pt('AEJEA'), pt('AEDXB')), false);
  assert.equal(crossesOpenSea(pt('HKHKG'), pt('CNSZX')), false);

  for (const [from, to] of [
    ['AEDXB', 'IRKIH'],
    ['AEDXB', 'IRBND'],
    ['DJJIB', 'YEADE'],
  ]) {
    const roadRes = router.findRoutes({ from, to, modes: ['road'], maxRoutes: 4 });
    assert.equal(roadRes.routes.length, 0, `expected no direct cross-sea road route for ${from} -> ${to}`);
  }

  // KWKWI -> IRMRX is connected overland around Iraq/Shatt al-Arab (not 167.8 km across sea)
  const kwiMrx = router.findRoutes({ from: 'KWKWI', to: 'IRMRX', modes: ['road'], includeGeometry: true }).routes;
  if (kwiMrx.length > 0) {
    assert.ok(kwiMrx[0].metrics.distanceKm > 220);
    assert.ok(kwiMrx[0].legs[0].geometry.length >= 4);
  }

  const dohDmm = router.findRoutes({ from: 'QADOH', to: 'SADMM', modes: ['road'], maxRoutes: 4 }).routes;
  assert.equal(dohDmm.length, 1);
  assert.ok(dohDmm[0].chokepoints.some((c) => c.id === 'BORDER_SALWA'));

  const overlandRoad = router.findRoutes({ from: 'AEDXB', to: 'AEKLF', modes: ['road'], maxRoutes: 4 });
  assert.equal(overlandRoad.routes.length, 1);

  for (const to of ['AEDXB', 'OMMCT', 'DJJIB']) {
    const airRes = router.findRoutes({ from: 'CNSZX', to, modes: ['air'], includeGeometry: true });
    for (const r of airRes.routes) {
      for (const leg of r.legs) {
        if (leg.mode === 'road' && leg.geometry?.length === 2) {
          assert.equal(crossesOpenSea(leg.geometry[0], leg.geometry[1]), false);
        }
      }
    }
  }
});

test('3-tier port hierarchy, cross-border friction, and MEA landbridge corridors work end-to-end', () => {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('AEJEA')?.portTier, 1);
  assert.equal(byId.get('AEKLF')?.portTier, 2);
  assert.equal(byId.get('OMSOH')?.portTier, 2);
  assert.equal(byId.get('QAHMD')?.portTier, 2);

  // Cross-border Sohar -> Dubai incurs GCC border friction vs domestic Khor Fakkan -> Dubai
  const domestic = router.findRoutes({ from: 'AEKLF', to: 'AEDXB', modes: ['road'], maxRoutes: 4 }).routes[0];
  const crossBorder = router.findRoutes({ from: 'OMSOH', to: 'AEDXB', modes: ['road'], maxRoutes: 4 }).routes[0];
  assert.ok(domestic && crossBorder);
  assert.ok(crossBorder.chokepoints.some((c) => c.id === 'BORDER_HATTA'));
  assert.ok(crossBorder.metrics.transitDays > domestic.metrics.transitDays);
  assert.ok(crossBorder.metrics.costIndex > domestic.metrics.costIndex);

  // Red Sea (Jeddah) -> Gulf cities via Saudi landbridge
  const jedDoh = router.findRoutes({ from: 'SAJED', to: 'QADOH', modes: ['road', 'rail'], maxRoutes: 4 }).routes;
  assert.ok(jedDoh.some((r) => r.chokepoints.some((c) => c.id === 'BORDER_SALWA')));
  const jedKwi = router.findRoutes({ from: 'SAJED', to: 'KWKWI', modes: ['road', 'rail'], maxRoutes: 4 }).routes;
  assert.ok(jedKwi.some((r) => r.chokepoints.some((c) => c.id === 'BORDER_KHAFJI')));

  // East Africa SGR rail & landlocked multi-hop corridor (Kampala -> Mombasa)
  const nboSea = router.findRoutes({ from: 'CNSZX', to: 'KENBO', modes: ['sea'], maxRoutes: 4 }).routes;
  assert.equal(nboSea[0].destGateway.id, 'KEMBA');
  const klaSea = router.findRoutes({ from: 'CNSZX', to: 'UGKLA', modes: ['sea'], maxRoutes: 4 }).routes;
  assert.equal(klaSea[0].destGateway.id, 'KEMBA');
});

test('Global roadnet routes overland around Bohai Bay for Weihai -> Dalian (CNWEI -> CNDLC)', () => {
  const res = router.findRoutes({
    from: 'CNWEI',
    to: 'CNDLC',
    modes: ['road'],
    includeGeometry: true,
  });
  assert.equal(res.routes.length, 1);
  const route = res.routes[0];
  assert.equal(route.mode, 'road');
  assert.ok(
    route.metrics.distanceKm >= 1100 && route.metrics.distanceKm <= 2000,
    `expected Bohai Bay overland detour (~1100-2000 km), got ${route.metrics.distanceKm}`
  );
  const geom = route.legs[0].geometry;
  assert.ok(geom.length >= 10, `expected detailed overland polyline, got ${geom.length} points`);
  assert.equal(crossesOpenSea(geom[0], geom[geom.length - 1]), true);
  assert.ok(geom.some(([lon, lat]) => lon < 118.5 && lat > 38.8), 'should detour west/north around Bohai Bay');
});
