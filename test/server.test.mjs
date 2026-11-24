import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouterService } from '../src/server.mjs';

test('HTTP service endpoints, canonical caching across standard & legacy aliases, and snapshot compatibility', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mmr-srv-'));
  const dbPath = join(tempDir, 'srv-cache.sqlite');

  const service = await createRouterService({ dbPath });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const { port } = service.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.ok(health.graphVersion);

    // 2. Node search returns standard UN/LOCODE IDs
    const nodesRes = await fetch(`${baseUrl}/v1/nodes?q=Rotterdam`);
    assert.equal(nodesRes.status, 200);
    const nodesData = await nodesRes.json();
    assert.ok(nodesData.nodes.some((n) => n.id === 'NLRTM' && n.codeStandard === 'UN/LOCODE'));

    const shanghaiRes = await fetch(`${baseUrl}/v1/nodes?${new URLSearchParams({ q: '上海', endpoint: '1', limit: '8' })}`);
    const shanghai = (await shanghaiRes.json()).nodes;
    assert.equal(shanghai[0].id, 'CNSHA');
    assert.ok(shanghai.some((n) => n.id === 'PVG' && n.name_zh === '上海浦东机场'));
    assert.ok(shanghai.some((n) => n.id === 'SHA'));

    const shenzhenPorts = ['CNYTN', 'CNSHK', 'CNCWN', 'CNMWN', 'CNDCB'];
    for (const q of ['深圳', '深圳港', 'Shenzhen']) {
      const res = await fetch(`${baseUrl}/v1/nodes?${new URLSearchParams({ q, endpoint: '1', limit: '8' })}`);
      assert.equal(res.status, 200);
      const { nodes } = await res.json();
      assert.equal(nodes[0].id, 'CNSZX');
      assert.deepEqual(nodes.filter((node) => node.type === 'port').map((node) => node.id).sort(), [...shenzhenPorts].sort());
    }

    const shekouRes = await fetch(`${baseUrl}/v1/nodes?${new URLSearchParams({ q: '深圳蛇口', endpoint: '1' })}`);
    assert.deepEqual((await shekouRes.json()).nodes.map((node) => node.id), ['CNSHK']);

    const passageRes = await fetch(`${baseUrl}/v1/nodes?${new URLSearchParams({ q: '苏伊士运河', endpoint: '1' })}`);
    assert.deepEqual((await passageRes.json()).nodes, []);

    const graphNodesRes = await fetch(`${baseUrl}/v1/graph/nodes`);
    assert.equal(graphNodesRes.status, 200);
    const graphNodes = await graphNodesRes.json();
    assert.equal(graphNodes.graphVersion, health.graphVersion);
    assert.ok(graphNodes.nodes.length > 100);
    assert.ok(graphNodes.nodes.some((node) => node.id === 'PVG' && node.type === 'airport'));
    assert.ok(graphNodes.nodes.every((node) => Number.isFinite(node.lon) && Number.isFinite(node.lat)));

    const graphLinksRes = await fetch(`${baseUrl}/v1/graph/links`);
    assert.equal(graphLinksRes.status, 200);
    const graphLinks = await graphLinksRes.json();
    assert.equal(graphLinks.graphVersion, health.graphVersion);
    assert.equal(graphLinks.sea.length, health.counts.marnetEdges);
    assert.equal(graphLinks.land.length, health.counts.landEdges);
    assert.ok(graphLinks.land.every(({ coords }) => coords.length === 2 && coords.flat().every(Number.isFinite)));

    // 3. Chokepoints
    const cpRes = await fetch(`${baseUrl}/v1/chokepoints`);
    assert.equal(cpRes.status, 200);
    const cpData = await cpRes.json();
    assert.ok(cpData.chokepoints.some((c) => c.id === 'CP_SUEZ' && c.affectedLaneCount > 0));

    // 4. POST /v1/routes miss -> alias & legacy IDs share exact same cache entry!
    const r1 = await fetch(`${baseUrl}/v1/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'CNSZX', to: 'NLAMS', maxRoutes: 6 }),
    });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal(d1.meta.cache.hit, false);
    assert.equal(d1.origin.id, 'CNSZX');
    assert.equal(d1.origin.name_zh, '深圳');
    assert.equal(d1.destination.id, 'NLAMS');
    assert.equal(d1.destination.name_zh, '阿姆斯特丹');
    assert.ok(!d1.routes.some((r) => r.mode === 'sea' && r.destGateway.id === 'DEDUI'));
    assert.ok(d1.routes.length >= 3);

    // Querying via Chinese names OR legacy IDs hits same canonical cache entry
    const r2 = await fetch(`${baseUrl}/v1/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'CITY_SZ', to: '阿姆斯特丹', maxRoutes: 6 }),
    });
    assert.equal(r2.status, 200);
    const d2 = await r2.json();
    assert.equal(d2.meta.cache.hit, true);
    assert.equal(d2.meta.cache.layer, 'memory');
    assert.equal(d2.origin.id, 'CNSZX');
    assert.equal(d2.destination.id, 'NLAMS');

    const airportRes = await fetch(`${baseUrl}/v1/routes?${new URLSearchParams({ from: '浦东机场', to: '阿姆斯特丹', modes: 'air' })}`);
    assert.equal(airportRes.status, 200);
    assert.equal((await airportRes.json()).origin.id, 'PVG');

    const portRes = await fetch(`${baseUrl}/v1/routes?${new URLSearchParams({ from: 'CNSHK', to: 'NLAMS', modes: 'sea' })}`);
    assert.equal(portRes.status, 200);
    const portRoute = await portRes.json();
    assert.equal(portRoute.origin.id, 'CNSHK');
    assert.ok(portRoute.routes.some((route) => route.originGateway.id === 'CNSHK'));

    // 5. POST /v1/routes/compare
    const cmpRes = await fetch(`${baseUrl}/v1/routes/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'CNSZX', to: 'NLAMS', avoid: ['CP_SUEZ'] }),
    });
    assert.equal(cmpRes.status, 200);
    const cmp = await cmpRes.json();
    assert.equal(cmp.impactSummary.seaDetoured, true);
    assert.ok(cmp.alternatives.some((r) => r.chokepoints.some((c) => c.id === 'CP_CAPE')));

    // 6. POST /v1/precompute
    const preRes = await fetch(`${baseUrl}/v1/precompute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairs: [{ from: 'CNSZX', to: 'GBLON' }],
        avoidScenarios: [[], ['CP_SUEZ']],
      }),
    });
    assert.equal(preRes.status, 200);
    const pre = await preRes.json();
    assert.equal(pre.ok, true);
    assert.equal(pre.warmed, 2);

    // 7. GET /v1/snapshots/risk-radar compatibility check
    const snapRes = await fetch(`${baseUrl}/v1/snapshots/risk-radar`);
    assert.equal(snapRes.status, 200);
    const snap = await snapRes.json();
    assert.ok(Array.isArray(snap.nodes) && snap.nodes.length >= 230);
    assert.equal(snap.lanes.length, 87);
    const nodeIds = new Set(snap.nodes.map((n) => n.id));
    for (const lane of snap.lanes) {
      for (const modeData of Object.values(lane.modes)) {
        for (const p of modeData.paths) {
          for (const id of p.nodes) {
            assert.ok(nodeIds.has(id), `Lane ${lane.lane_id} references missing node ${id}`);
          }
        }
      }
    }

    // 8. Static UI index.html
    const uiRes = await fetch(`${baseUrl}/`);
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.ok(html.includes('Multimodal Router'));
  } finally {
    await service.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
