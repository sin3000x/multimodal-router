import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../src/engine/router.mjs';
import { getLegStrokeStyle } from '../public/map-config.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const graph = JSON.parse(await readFile(join(ROOT_DIR, 'data', 'compiled', 'graph.json'), 'utf8'));
const router = createRouter(graph);

const tokens = {
  baseline: '#dc2626',
  modes: {
    sea: '#0284c7',
    air: '#7c3aed',
    rail: '#059669',
    road: '#d97706',
    local: '#d97706',
  },
};

test('getLegStrokeStyle styles multimodal sea route legs by each leg mode (CNSZX -> AEDXB avoiding CP_HORMUZ)', () => {
  const res = router.findRoutes({
    from: 'CNSZX',
    to: 'AEDXB',
    modes: ['sea'],
    avoid: ['CP_HORMUZ'],
  });
  const seaRoute = res.routes.find((r) => r.mode === 'sea' && r.legs.some((l) => l.mode === 'road'));
  assert.ok(seaRoute, 'Expected a sea route with road drayage legs');
  assert.ok(seaRoute.legs.some((l) => l.mode === 'sea'), 'Expected a sea trunk leg');

  for (const leg of seaRoute.legs) {
    const style = getLegStrokeStyle(seaRoute, leg, tokens);
    if (leg.mode === 'road') {
      assert.deepEqual(style, { color: tokens.modes.road, dash: [] });
    } else if (leg.mode === 'sea') {
      assert.deepEqual(style, { color: tokens.modes.sea, dash: [] });
    }
  }
});

test('getLegStrokeStyle styles air and rail routes per leg', () => {
  const airRoute = {
    mode: 'air',
    legs: [
      { mode: 'road' },
      { mode: 'air' },
      { mode: 'road' },
    ],
  };
  assert.deepEqual(getLegStrokeStyle(airRoute, airRoute.legs[0], tokens), { color: tokens.modes.road, dash: [] });
  assert.deepEqual(getLegStrokeStyle(airRoute, airRoute.legs[1], tokens), { color: tokens.modes.air, dash: [6, 4] });
  assert.deepEqual(getLegStrokeStyle(airRoute, airRoute.legs[2], tokens), { color: tokens.modes.road, dash: [] });

  const railRoute = {
    mode: 'rail',
    legs: [
      { mode: 'road' },
      { mode: 'rail' },
      { mode: 'sea' },
    ],
  };
  assert.deepEqual(getLegStrokeStyle(railRoute, railRoute.legs[0], tokens), { color: tokens.modes.road, dash: [] });
  assert.deepEqual(getLegStrokeStyle(railRoute, railRoute.legs[1], tokens), { color: tokens.modes.rail, dash: [3, 3.5] });
  assert.deepEqual(getLegStrokeStyle(railRoute, railRoute.legs[2], tokens), { color: tokens.modes.sea, dash: [] });
});

test('getLegStrokeStyle preserves baseline-affected styling and falls back to route.mode when leg.mode is missing', () => {
  const affectedRoute = {
    mode: 'sea',
    compareRole: 'baseline-affected',
    legs: [{ mode: 'road' }, { mode: 'sea' }],
  };
  for (const leg of affectedRoute.legs) {
    assert.deepEqual(getLegStrokeStyle(affectedRoute, leg, tokens), {
      color: tokens.baseline,
      dash: [8, 5],
    });
  }

  assert.deepEqual(getLegStrokeStyle({ mode: 'air' }, {}, tokens), {
    color: tokens.modes.air,
    dash: [6, 4],
  });
  assert.deepEqual(getLegStrokeStyle({}, {}, tokens), {
    color: tokens.modes.sea,
    dash: [],
  });
});
