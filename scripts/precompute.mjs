import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../src/engine/router.mjs';
import { createRouteCache } from '../src/cache/route-cache.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const COMPILED_DIR = join(ROOT_DIR, 'data', 'compiled');
const CURATED_DIR = join(ROOT_DIR, 'data', 'curated');
const DB_PATH = join(ROOT_DIR, 'var', 'route-cache.sqlite');

function computeNodeExposure(paths) {
  if (!paths.length) return {};
  const mainPaths = paths.filter((p) => p.likelihood === '主要');
  const allNodes = new Set(paths.flatMap((p) => p.nodes));
  const out = {};
  for (const id of allNodes) {
    if (paths.every((p) => p.nodes.includes(id))) {
      out[id] = 'must';
    } else if (mainPaths.length > 0) {
      if (mainPaths.every((p) => p.nodes.includes(id))) out[id] = 'main';
      else if (mainPaths.some((p) => p.nodes.includes(id))) out[id] = 'shared';
      else out[id] = 'alt_only';
    } else {
      out[id] = 'shared';
    }
  }
  return out;
}

async function atomicWriteJson(targetPath, data) {
  const tmpPath = `${targetPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data));
  await rename(tmpPath, targetPath);
}

async function main() {
  const startedAt = Date.now();
  const [graph, cohort] = await Promise.all([
    readFile(join(COMPILED_DIR, 'graph.json'), 'utf8').then(JSON.parse),
    readFile(join(CURATED_DIR, 'cohort-od.json'), 'utf8').then(JSON.parse),
  ]);

  const router = createRouter(graph);
  const cache = createRouteCache({
    dbPath: DB_PATH,
    graphVersion: graph.graphVersion,
    maxMemoryEntries: 4000,
  });

  const pruned = cache.pruneOldVersions();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const cpMeta = new Map(router.chokepoints.map((cp) => [cp.id, cp]));

  const chokepointIndex = new Map();
  for (const cp of router.chokepoints) {
    chokepointIndex.set(cp.id, {
      id: cp.id,
      type: cp.type,
      name_zh: cp.name_zh,
      name_en: cp.name_en,
      affectedLanes: new Set(),
      mustExposeLanes: new Set(),
      totalPaths: 0,
    });
  }

  const riskLanes = [];
  const referencedNodeIds = new Set();

  // Keep curated nodes in risk-radar snapshot by default
  for (const node of graph.nodes) {
    if (node.curated) referencedNodeIds.add(node.id);
  }

  let warmQueries = 0;

  for (const pair of cohort.pairs) {
    const laneModes = {};

    for (const scenario of cohort.scenarios) {
      const routeParams = {
        from: pair.origin_city,
        to: pair.dest_city,
        modes: ['sea', 'air', 'rail', 'road'],
        avoid: scenario.avoid,
        maxRoutes: 8,
        includeGeometry: true,
      };
      const routeResult = router.findRoutes(routeParams);
      cache.set('routes', routeParams, routeResult);
      warmQueries++;

      // Also warm baseline without geometry for fast lightweight API queries
      const lightParams = { ...routeParams, includeGeometry: false };
      const lightResult = router.findRoutes(lightParams);
      cache.set('routes', lightParams, lightResult);
      warmQueries++;

      if (scenario.avoid.length > 0) {
        const compareParams = { ...routeParams, includeGeometry: true };
        const compareResult = router.compareDisruption(compareParams);
        cache.set('compare', compareParams, compareResult);
        warmQueries++;
      } else {
        // Build risk-radar compatible lane snapshot + chokepoint inverse index from baseline
        const byMode = new Map();
        for (const r of routeResult.routes) {
          if (!byMode.has(r.mode)) byMode.set(r.mode, []);
          const seq = [
            pair.origin_city,
            pair.origin_country,
            ...(pair.upstream_country ? [pair.upstream_country] : []),
            ...r.nodeSequence,
            pair.dest_country,
            pair.dest_city,
          ];
          const dedupSeq = [];
          for (const id of seq) {
            if (!dedupSeq.includes(id) && nodeById.has(id)) {
              dedupSeq.push(id);
              referencedNodeIds.add(id);
            }
          }
          byMode.get(r.mode).push({
            id: `${pair.lane_id}|${r.mode}|${byMode.get(r.mode).length + 1}`,
            likelihood: r.likelihood === 'primary' ? '主要' : '备选',
            nodes: dedupSeq,
            metrics: r.metrics,
          });

          for (const cp of r.chokepoints) {
            if (!chokepointIndex.has(cp.id)) {
              const meta = cpMeta.get(cp.id);
              chokepointIndex.set(cp.id, {
                id: cp.id,
                type: meta?.type ?? 'chokepoint',
                name_zh: cp.name_zh,
                name_en: cp.name_en,
                affectedLanes: new Set(),
                mustExposeLanes: new Set(),
                totalPaths: 0,
              });
            }
            const entry = chokepointIndex.get(cp.id);
            entry.affectedLanes.add(pair.lane_id);
            entry.totalPaths++;
          }
        }

        for (const [mode, paths] of byMode.entries()) {
          const exposure = computeNodeExposure(paths);
          laneModes[mode] = {
            confidence: mode === 'sea' ? '高' : '中',
            paths,
            node_exposure: exposure,
          };
          for (const [nodeId, level] of Object.entries(exposure)) {
            if (level === 'must' && chokepointIndex.has(nodeId)) {
              chokepointIndex.get(nodeId).mustExposeLanes.add(pair.lane_id);
            }
          }
        }
      }
    }

    riskLanes.push({
      lane_id: pair.lane_id,
      origin_id: pair.origin_id,
      origin_name: pair.origin_name,
      origin_city: pair.origin_city,
      origin_country: pair.origin_country,
      upstream_country: pair.upstream_country,
      dest_wh: pair.dest_wh,
      dest_name: pair.dest_name,
      dest_city: pair.dest_city,
      dest_country: pair.dest_country,
      product_categories: [],
      modes: laneModes,
    });
  }

  const riskNodes = [...referencedNodeIds]
    .map((id) => nodeById.get(id))
    .filter(Boolean)
    .map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.code && { code: n.code }),
      name_zh: n.name_zh,
      name_en: n.name_en,
      country: n.country ?? '',
      ...(n.region && { region: n.region }),
      lon: n.lon,
      lat: n.lat,
      aliases: n.aliases ?? [],
    }));

  const serializedChokepointIndex = Object.fromEntries(
    [...chokepointIndex.entries()].map(([id, item]) => [
      id,
      {
        id: item.id,
        type: item.type,
        name_zh: item.name_zh,
        name_en: item.name_en,
        affectedLaneCount: item.affectedLanes.size,
        mustExposeLaneCount: item.mustExposeLanes.size,
        totalPaths: item.totalPaths,
        affectedLanes: [...item.affectedLanes],
        mustExposeLanes: [...item.mustExposeLanes],
      },
    ])
  );

  const precomputed = {
    graphVersion: graph.graphVersion,
    generatedAt: new Date().toISOString(),
    laneCount: riskLanes.length,
    chokepointIndex: serializedChokepointIndex,
    riskRadarSnapshot: {
      nodes: riskNodes,
      lanes: riskLanes,
      meta: {
        generated_by: 'multimodal-router/precompute.mjs',
        graph_version: graph.graphVersion,
        basis: '基于 MARNET 海运网络、OurAirports 与欧亚陆铁走廊自动计算的基线及绕行多式联运快照',
        exposure_levels: {
          must: '该方式下所有候选路径都经过',
          main: '所有主要路径都经过（仅备选路径可绕开）',
          shared: '部分主要路径经过（存在同等级的绕行方案）',
          alt_only: '仅备选路径经过',
        },
      },
    },
  };

  await mkdir(COMPILED_DIR, { recursive: true });
  await atomicWriteJson(join(COMPILED_DIR, 'precomputed.json'), precomputed);

  const cacheStats = cache.stats();
  cache.close();

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `Precomputed ${riskLanes.length} lanes (${warmQueries} cached queries, pruned ${pruned} stale rows) in ${elapsedMs}ms.`
  );
  console.log('SQLite cache entries:', cacheStats.sqliteEntries);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
