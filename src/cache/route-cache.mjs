import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Routing changes can invalidate cached results even when the graph is unchanged.
const ROUTING_VERSION = 2;

function canonicalParams(params = {}) {
  const normList = (v) =>
    [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean))].sort();
  return {
    from: String(params.from ?? '').trim(),
    to: String(params.to ?? '').trim(),
    modes: normList(params.modes ?? ['sea', 'air', 'rail', 'road']),
    avoid: normList(params.avoid ?? []),
    maxRoutes: Number(params.maxRoutes ?? 8),
    includeGeometry: Boolean(params.includeGeometry),
  };
}

export function createRouteCache({
  dbPath,
  graphVersion,
  maxMemoryEntries = 2000,
}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_cache (
      cache_key TEXT PRIMARY KEY,
      graph_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_cache_version ON route_cache(graph_version);
  `);

  const stmtGet = db.prepare(
    'SELECT payload FROM route_cache WHERE cache_key = ? AND graph_version = ?'
  );
  const stmtSet = db.prepare(
    'INSERT OR REPLACE INTO route_cache (cache_key, graph_version, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const stmtCount = db.prepare(
    'SELECT COUNT(*) AS cnt FROM route_cache WHERE graph_version = ?'
  );
  const stmtPrune = db.prepare(
    'DELETE FROM route_cache WHERE graph_version != ?'
  );

  const memory = new Map();
  const inFlight = new Map();
  const counters = {
    memoryHits: 0,
    sqliteHits: 0,
    inflightHits: 0,
    misses: 0,
  };

  function makeKey(kind, params) {
    const body = JSON.stringify({
      graphVersion,
      routingVersion: ROUTING_VERSION,
      kind,
      ...canonicalParams(params),
    });
    return createHash('sha256').update(body).digest('hex');
  }

  function touchMemory(key, value) {
    if (memory.has(key)) memory.delete(key);
    memory.set(key, value);
    if (memory.size > maxMemoryEntries) {
      const oldestKey = memory.keys().next().value;
      memory.delete(oldestKey);
    }
  }

  function get(kind, params) {
    const key = makeKey(kind, params);
    if (memory.has(key)) {
      const value = memory.get(key);
      touchMemory(key, value);
      counters.memoryHits++;
      return { value, cache: { hit: true, layer: 'memory', key } };
    }

    const row = stmtGet.get(key, graphVersion);
    if (row) {
      const value = JSON.parse(row.payload);
      touchMemory(key, value);
      counters.sqliteHits++;
      return { value, cache: { hit: true, layer: 'sqlite', key } };
    }

    return null;
  }

  function set(kind, params, value) {
    const key = makeKey(kind, params);
    touchMemory(key, value);
    stmtSet.run(key, graphVersion, kind, JSON.stringify(value), Date.now());
    return key;
  }

  async function getOrCompute(kind, params, computeFn) {
    const hit = get(kind, params);
    if (hit) return hit;

    const key = makeKey(kind, params);
    if (inFlight.has(key)) {
      const value = await inFlight.get(key);
      counters.inflightHits++;
      return { value, cache: { hit: true, layer: 'inflight', key } };
    }

    const promise = Promise.resolve().then(() => computeFn());
    inFlight.set(key, promise);
    try {
      const value = await promise;
      set(kind, params, value);
      counters.misses++;
      return { value, cache: { hit: false, layer: 'compute', key } };
    } finally {
      inFlight.delete(key);
    }
  }

  function pruneOldVersions() {
    const res = stmtPrune.run(graphVersion);
    for (const key of memory.keys()) {
      memory.delete(key);
    }
    return Number(res.changes ?? 0);
  }

  function stats() {
    const row = stmtCount.get(graphVersion);
    return {
      graphVersion,
      memoryEntries: memory.size,
      sqliteEntries: Number(row?.cnt ?? 0),
      ...counters,
    };
  }

  function close() {
    db.close();
  }

  return {
    makeKey,
    get,
    set,
    getOrCompute,
    pruneOldVersions,
    stats,
    close,
  };
}
