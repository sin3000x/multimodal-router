import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRouter } from './engine/router.mjs';
import { createRouteCache } from './cache/route-cache.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function parseBool(val, fallback = false) {
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'boolean') return val;
  return ['1', 'true', 'yes'].includes(String(val).toLowerCase());
}

function parseList(val, fallback = []) {
  if (val === undefined || val === null) return fallback;
  if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

function getGatewayTypes(graph) {
  const gatewayTypes = new Map();
  const countryById = new Map();
  for (const node of graph.nodes) {
    if (node.type === 'border' || node.type === 'rail_border') {
      gatewayTypes.set(node.id, 'land');
    } else if (node.type === 'ferry_port' || (node.type === 'port' && (node.isCuratedPort || node.isHub))) {
      gatewayTypes.set(node.id, 'water');
    } else if (node.type === 'airport' || node.type === 'hub_airport') {
      if (node.country) countryById.set(node.id, node.country);
    }
  }
  for (const [from, to] of graph.airnet?.edges ?? []) {
    const fromCountry = countryById.get(from);
    const toCountry = countryById.get(to);
    if (fromCountry && toCountry && fromCountry !== toCountry) {
      gatewayTypes.set(from, 'air');
      gatewayTypes.set(to, 'air');
    }
  }
  return gatewayTypes;
}

export async function createRouterService({
  graphPath = join(ROOT_DIR, 'data', 'compiled', 'graph.json'),
  manifestPath = join(ROOT_DIR, 'data', 'compiled', 'manifest.json'),
  precomputedPath = join(ROOT_DIR, 'data', 'compiled', 'precomputed.json'),
  cohortPath = join(ROOT_DIR, 'data', 'curated', 'cohort-od.json'),
  dbPath = join(ROOT_DIR, 'var', 'route-cache.sqlite'),
  maxMemoryEntries = 2000,
} = {}) {
  const [graph, manifest, precomputed, cohort] = await Promise.all([
    readFile(graphPath, 'utf8').then(JSON.parse),
    readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null),
    readFile(precomputedPath, 'utf8').then(JSON.parse).catch(() => null),
    readFile(cohortPath, 'utf8').then(JSON.parse).catch(() => ({ pairs: [], scenarios: [] })),
  ]);

  const router = createRouter(graph);
  const gatewayTypes = getGatewayTypes(graph);
  const chokepointIndex = precomputed?.chokepointIndex ?? {};
  const landDegreeById = new Map();
  for (const edge of graph.landEdges ?? []) {
    if (edge.from) landDegreeById.set(edge.from, (landDegreeById.get(edge.from) ?? 0) + 1);
    if (edge.to) landDegreeById.set(edge.to, (landDegreeById.get(edge.to) ?? 0) + 1);
  }
  const cache = createRouteCache({
    dbPath,
    graphVersion: graph.graphVersion,
    maxMemoryEntries,
  });

  function canonicalRouteParams(raw) {
    const from = raw.from;
    const to = raw.to;
    if (!from || !to) {
      throw Object.assign(new Error('Both "from" and "to" parameters are required'), { statusCode: 400 });
    }
    const origin = router.resolveNode(from);
    if (!origin) {
      throw Object.assign(new Error(`Unknown origin node: ${from}`), { statusCode: 400 });
    }
    const dest = router.resolveNode(to);
    if (!dest) {
      throw Object.assign(new Error(`Unknown destination node: ${to}`), { statusCode: 400 });
    }
    const modes = parseList(raw.modes, ['sea', 'air', 'rail', 'road']);
    const avoid = parseList(raw.avoid, []);
    const maxRoutes = Math.max(1, Math.min(24, Number(raw.maxRoutes ?? 8) || 8));
    const includeGeometry = parseBool(raw.includeGeometry, false);
    return {
      origin,
      dest,
      params: {
        from: origin.id,
        to: dest.id,
        modes: modes.length ? modes : ['sea', 'air', 'rail', 'road'],
        avoid,
        maxRoutes,
        includeGeometry,
      },
    };
  }

  async function handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'multimodal-router',
          graphVersion: graph.graphVersion,
          builtAt: manifest?.builtAt ?? null,
          counts: manifest?.counts ?? null,
          precomputed: precomputed
            ? { laneCount: precomputed.laneCount, generatedAt: precomputed.generatedAt }
            : null,
          cache: cache.stats(),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/nodes') {
        const q = url.searchParams.get('q') ?? '';
        const type = url.searchParams.get('type') ?? '';
        const endpoint = url.searchParams.get('endpoint') === '1';
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 20) || 20));
        sendJson(res, 200, {
          graphVersion: graph.graphVersion,
          nodes: router.searchNodes({ q, type, limit, endpoint }),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/graph/nodes') {
        const nodes = graph.nodes
          .filter((node) => node.type !== 'country' && Number.isFinite(node.lon) && Number.isFinite(node.lat))
          .map((node) => {
            const item = {
              id: node.id,
              code: node.code,
              type: node.type,
              functions: node.functions,
              gatewayType: gatewayTypes.get(node.id),
              name_zh: node.name_zh,
              name_en: node.name_en,
              country: node.country,
              lon: node.lon,
              lat: node.lat,
              aliases: node.aliases,
              featured: Boolean(node.curated || node.isMajor),
              hasMarnet: Number.isInteger(node.marnetVertexId),
              hasRoadnet: Number.isInteger(node.roadVertexId),
              landDegree: landDegreeById.get(node.id) ?? 0,
            };
            for (const key of [
              'codeStandard', 'region', 'portTier', 'airportSize', 'routeCount',
              'isHub', 'major', 'marnetPassage', 'boxes', 'firs', 'polygons',
              'municipality', 'snapDistanceKm', 'roadSnapKm',
            ]) {
              if (node[key] !== undefined) item[key] = node[key];
            }
            const affectedLaneCount = chokepointIndex[node.id]?.affectedLaneCount;
            if (affectedLaneCount !== undefined) item.affectedLaneCount = affectedLaneCount;
            return item;
          });
        sendJson(res, 200, { graphVersion: graph.graphVersion, nodes });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/graph/links') {
        const counts = {
          sea: (graph.marnet?.edges ?? []).length,
          land: (graph.landEdges ?? []).length,
          road: (graph.roadnet?.edges ?? []).length,
          air: (graph.airnet?.edges ?? []).length,
          fir: (graph.firs ?? []).length,
        };
        const rawLayers = url.searchParams.get('layers');
        const requested = rawLayers
          ? new Set(rawLayers.split(',').map((s) => s.trim()).filter(Boolean))
          : new Set(['sea', 'land']);

        const payload = { graphVersion: graph.graphVersion, counts };
        if (requested.has('sea')) {
          payload.sea = (graph.marnet?.edges ?? []).map(({ coords }) => ({ mode: 'sea', coords }));
        }
        if (requested.has('land')) {
          const nodes = new Map(graph.nodes.map((node) => [node.id, [node.lon, node.lat]]));
          payload.land = (graph.landEdges ?? []).flatMap(({ from, to, mode, corridor, distanceKm, coords }) => {
            const line = coords?.length >= 2 ? coords : [nodes.get(from), nodes.get(to)];
            return line.every((point) => point?.every(Number.isFinite))
              ? [{ mode, from, to, corridor, distanceKm, coords: line }]
              : [];
          });
        }
        if (requested.has('road')) {
          payload.road = (graph.roadnet?.edges ?? []).map(({ coords }) => ({ mode: 'road', coords }));
        }
        if (requested.has('air')) {
          payload.air = graph.airnet?.edges ?? [];
        }
        if (requested.has('fir')) {
          payload.fir = graph.firs ?? [];
        }
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/chokepoints') {
        const index = precomputed?.chokepointIndex ?? {};
        const items = router.chokepoints.map((cp) => ({
          id: cp.id,
          type: cp.type,
          name_zh: cp.name_zh,
          name_en: cp.name_en,
          lon: cp.lon,
          lat: cp.lat,
          major: Boolean(cp.major),
          region: cp.region ?? null,
          affectedLaneCount: index[cp.id]?.affectedLaneCount ?? 0,
          mustExposeLaneCount: index[cp.id]?.mustExposeLaneCount ?? 0,
          totalPaths: index[cp.id]?.totalPaths ?? 0,
        }));
        sendJson(res, 200, { graphVersion: graph.graphVersion, chokepoints: items });
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/v1/routes') {
        const raw =
          req.method === 'POST'
            ? await readJsonBody(req)
            : Object.fromEntries(url.searchParams.entries());
        const { origin, dest, params } = canonicalRouteParams(raw);
        const { value, cache: cacheInfo } = await cache.getOrCompute('routes', params, () =>
          router.findRoutes({ ...params, from: origin, to: dest })
        );
        sendJson(res, 200, { ...value, meta: { cache: cacheInfo } });
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/v1/routes/compare') {
        const raw =
          req.method === 'POST'
            ? await readJsonBody(req)
            : Object.fromEntries(url.searchParams.entries());
        const { origin, dest, params } = canonicalRouteParams(raw);
        const { value, cache: cacheInfo } = await cache.getOrCompute('compare', params, () =>
          router.compareDisruption({ ...params, from: origin, to: dest })
        );
        sendJson(res, 200, { ...value, meta: { cache: cacheInfo } });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/precompute') {
        const body = await readJsonBody(req);
        const pairs = Array.isArray(body.pairs) && body.pairs.length
          ? body.pairs
          : cohort.pairs.map((p) => ({ from: p.origin_city, to: p.dest_city }));
        const avoidScenarios = Array.isArray(body.avoidScenarios) && body.avoidScenarios.length
          ? body.avoidScenarios
          : [[]];
        const includeGeometry = parseBool(body.includeGeometry, true);
        const maxRoutes = Math.max(1, Math.min(24, Number(body.maxRoutes ?? 8) || 8));

        let warmed = 0;
        let cacheHits = 0;
        for (const pair of pairs) {
          for (const avoid of avoidScenarios) {
            const { origin, dest, params } = canonicalRouteParams({
              from: pair.from,
              to: pair.to,
              modes: pair.modes ?? body.modes,
              avoid: pair.avoid ?? avoid,
              maxRoutes,
              includeGeometry,
            });
            const resRoute = await cache.getOrCompute('routes', params, () =>
              router.findRoutes({ ...params, from: origin, to: dest })
            );
            if (resRoute.cache.hit) cacheHits++;
            else warmed++;
          }
        }
        sendJson(res, 200, {
          ok: true,
          graphVersion: graph.graphVersion,
          warmed,
          cacheHits,
          cache: cache.stats(),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/snapshots/risk-radar') {
        if (!precomputed?.riskRadarSnapshot) {
          sendJson(res, 404, { error: 'Precomputed snapshot not found. Run npm run precompute first.' });
          return;
        }
        sendJson(res, 200, precomputed.riskRadarSnapshot);
        return;
      }

      // Static UI files
      if (req.method === 'GET') {
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = resolve(PUBLIC_DIR, relPath);
        if (!filePath.startsWith(PUBLIC_DIR)) {
          sendJson(res, 403, { error: 'Forbidden' });
          return;
        }
        try {
          const content = await readFile(filePath);
          const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
          res.writeHead(200, { 'content-type': mime });
          res.end(content);
          return;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.statusCode ?? 500;
      sendJson(res, status, { error: err.message || 'Internal error' });
    }
  }

  const server = createServer(handleRequest);
  return {
    server,
    router,
    cache,
    graphVersion: graph.graphVersion,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => {
          cache.close();
          resolveClose();
        });
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 4180);
  const host = process.env.HOST ?? '127.0.0.1';
  const service = await createRouterService();
  service.server.listen(port, host, () => {
    console.log(`multimodal-router listening on http://${host}:${port} (graph ${service.graphVersion})`);
  });
}
