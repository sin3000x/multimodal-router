import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../src/engine/router.mjs';
import { createRouteCache } from '../src/cache/route-cache.mjs';

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

test('CNSZX -> AEDXB with avoid CP_HORMUZ uses bypass port outside Hormuz and reports comparison', () => {
  const cmp = router.compareDisruption({
    from: '深圳',
    to: '迪拜',
    avoid: ['CP_HORMUZ'],
    maxRoutes: 10,
  });

  assert.equal(cmp.origin.id, 'CNSZX');
  assert.equal(cmp.destination.id, 'AEDXB');
  assert.ok(
    cmp.affected.some((r) => r.chokepoints.some((c) => c.id === 'CP_HORMUZ')),
    'baseline should cross CP_HORMUZ'
  );
  const altSea = cmp.alternatives.filter((r) => r.mode === 'sea');
  assert.ok(altSea.length >= 1, 'should discover sea port outside Hormuz');
  assert.ok(
    altSea.every((r) => !r.chokepoints.some((c) => c.id === 'CP_HORMUZ')),
    'surviving sea route must not cross CP_HORMUZ'
  );
  assert.equal(typeof altSea[0].deltaDays, 'number');
  assert.equal(typeof altSea[0].costMultiplier, 'number');
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
