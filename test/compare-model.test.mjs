import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../src/engine/router.mjs';
import {
  buildCompareModel,
  formatKm,
  formatDeltaDays,
  formatDeltaKm,
  formatCostMultiplier,
} from '../public/compare-model.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const graph = JSON.parse(await readFile(join(ROOT_DIR, 'data', 'compiled', 'graph.json'), 'utf8'));
const router = createRouter(graph);
const cpNames = new Map(router.chokepoints.map((cp) => [cp.id, cp.name_zh]));

test('format helpers normalize -0 and format units consistently', () => {
  assert.equal(formatKm(18284.6), '18,285 km');
  assert.equal(formatKm(null), '—');
  assert.equal(formatDeltaDays(-0.02), '0 天');
  assert.equal(formatDeltaDays(7.3), '+7.3 天');
  assert.equal(formatDeltaDays(-1.5), '-1.5 天');
  assert.equal(formatDeltaKm(-0.2), '0 km');
  assert.equal(formatDeltaKm(6294.6), '+6,295 km');
  assert.equal(formatDeltaKm(-120.4), '-120 km');
  assert.equal(formatCostMultiplier(1.28), '1.28x');
  assert.equal(formatCostMultiplier(1), '1x');
});

test('buildCompareModel handles CNSZX -> NLAMS avoiding CP_SUEZ', () => {
  const raw = router.compareDisruption({
    from: 'CNSZX',
    to: 'NLAMS',
    avoid: ['CP_SUEZ'],
    maxRoutes: 8,
  });
  const model = buildCompareModel(raw, cpNames);

  assert.equal(model.hasAvoid, true);
  assert.deepEqual(model.avoidNames, ['苏伊士运河']);

  // Unique routeIds across both layer (no base/alt collision)
  const both = model.getRoutes('both');
  const ids = both.map((r) => r.routeId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.some((id) => id.startsWith('base::')));
  assert.ok(ids.some((id) => id.startsWith('alt::')));

  // Sea summary is detour with positive deltas
  const sea = model.modeSummaries.find((m) => m.mode === 'sea');
  assert.ok(sea);
  assert.equal(sea.status, 'detour');
  assert.ok(sea.deltaDays > 0);
  assert.ok(sea.deltaKm > 0);
  assert.ok(sea.costMultiplier > 1);
  assert.ok(sea.pairBaselineId?.startsWith('base::'));
  assert.ok(sea.pairDisruptedId?.startsWith('alt::'));

  // Rail is land-sub, air is unchanged with showDelta === false
  const rail = model.modeSummaries.find((m) => m.mode === 'rail');
  assert.equal(rail?.status, 'land-sub');
  const air = model.modeSummaries.find((m) => m.mode === 'air');
  assert.equal(air?.status, 'unchanged');
  const airDisrupted = model.disruptedRoutes.filter((r) => r.mode === 'air');
  assert.ok(airDisrupted.length > 0);
  assert.ok(airDisrupted.every((r) => r.showDelta === false));

  // Default route in 'both' is the sea detour paired to affected Suez baseline
  const defaultId = model.defaultRouteId('both');
  const defaultRoute = both.find((r) => r.routeId === defaultId);
  assert.equal(defaultRoute?.mode, 'sea');
  assert.equal(defaultRoute?.compareRole, 'detour');
  assert.equal(defaultRoute?.pairedRouteId, sea.pairBaselineId);

  // Layer filtering
  const detourOnly = model.getRoutes('detour');
  assert.ok(detourOnly.every((r) => r.compareGroup === 'disrupted'));
  const baselineOnly = model.getRoutes('baseline');
  assert.ok(baselineOnly.every((r) => r.compareGroup === 'baseline'));
  assert.ok(both.length < detourOnly.length + baselineOnly.length, 'deduplicates identical unaffected routes in both');
});

test('buildCompareModel handles CNSZX -> QADOH avoiding CP_HORMUZ (sea cutoff)', () => {
  const raw = router.compareDisruption({
    from: 'CNSZX',
    to: 'QADOH',
    avoid: ['CP_HORMUZ'],
    maxRoutes: 8,
  });
  const model = buildCompareModel(raw, cpNames);

  const sea = model.modeSummaries.find((m) => m.mode === 'sea');
  assert.equal(sea?.status, 'cutoff');
  assert.equal(sea?.bestDisrupted, null);
  assert.equal(model.headline.hasCutoff, true);

  const defaultId = model.defaultRouteId('both');
  const defaultRoute = model.getRoutes('both').find((r) => r.routeId === defaultId);
  assert.equal(defaultRoute?.compareRole, 'baseline-affected');
  assert.equal(defaultRoute?.mode, 'sea');
});

test('buildCompareModel handles CNSZX -> NLAMS avoiding AS_RUSSIA (air detour)', () => {
  const raw = router.compareDisruption({
    from: 'CNSZX',
    to: 'NLAMS',
    avoid: ['AS_RUSSIA'],
    maxRoutes: 8,
  });
  const model = buildCompareModel(raw, cpNames);

  assert.equal(model.modeSummaries[0]?.mode, 'air');
  assert.equal(model.modeSummaries[0]?.status, 'detour');
  assert.ok(model.modeSummaries[0]?.deltaDays > 0);
});

test('buildCompareModel handles CNSZX -> MXMEX avoiding CP_PANAMA (partial sea impact)', () => {
  const raw = router.compareDisruption({
    from: 'CNSZX',
    to: 'MXMEX',
    avoid: ['CP_PANAMA'],
    maxRoutes: 8,
  });
  const model = buildCompareModel(raw, cpNames);

  const sea = model.modeSummaries.find((m) => m.mode === 'sea');
  assert.equal(sea?.status, 'partial');
  assert.ok(sea?.pairBaselineId);
  const affectedBase = model.baselineRoutes.find((r) => r.routeId === sea.pairBaselineId);
  assert.equal(affectedBase?.isAffected, true);
});

test('buildCompareModel handles CNSZX -> AEDXB avoiding CP_HORMUZ as sea detour (Jebel Ali -> Khor Fakkan)', () => {
  const raw = router.compareDisruption({
    from: 'CNSZX',
    to: 'AEDXB',
    avoid: ['CP_HORMUZ'],
    maxRoutes: 8,
  });
  const model = buildCompareModel(raw, cpNames);

  const sea = model.modeSummaries.find((m) => m.mode === 'sea');
  assert.equal(sea?.status, 'detour');
  assert.equal(sea?.bestBaseline?.destGateway?.id, 'AEJEA');
  assert.equal(sea?.bestDisrupted?.destGateway?.id, 'AEKLF');
  assert.ok(sea?.deltaDays > 0);
  assert.ok(sea?.costMultiplier > 1);
});

test('buildCompareModel handles empty avoid list as no-avoid', () => {
  const raw = router.compareDisruption({
    from: 'CNSZX',
    to: 'NLAMS',
    avoid: [],
    maxRoutes: 8,
  });
  const model = buildCompareModel(raw, cpNames);

  assert.equal(model.hasAvoid, false);
  assert.ok(model.modeSummaries.every((m) => m.status === 'no-avoid'));
});
