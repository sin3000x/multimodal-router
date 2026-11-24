import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decimateCoords, haversineKm, normalizeLon } from '../src/engine/geo.mjs';
import endpointNamesZh from '../data/curated/endpoint-names-zh.json' with { type: 'json' };
import publicNodeNamesZh from '../data/curated/public-node-names-zh.json' with { type: 'json' };

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const RAW_DIR = join(ROOT_DIR, 'data', 'raw');
const CURATED_DIR = join(ROOT_DIR, 'data', 'curated');
const COMPILED_DIR = join(ROOT_DIR, 'data', 'compiled');

const MAJOR_AIR_CARGO_HUBS = new Set([
  'HKG', 'PVG', 'CAN', 'SZX', 'ICN', 'NRT', 'SIN', 'DXB', 'DOH', 'IST',
  'FRA', 'AMS', 'LHR', 'CDG', 'LGG', 'ANC', 'LAX', 'MIA', 'ORD', 'MEM',
  'ADD', 'JNB', 'GRU', 'MEX', 'RUH',
]);

const MAJOR_SEA_HUB_CODES = new Set([
  'CNYTN', 'CNSHK', 'CNNSA', 'CNCWN', 'CNMWN', 'CNDCB', 'HKHKG', 'SGSIN',
  'MYPKG', 'MYTPP', 'AEJEA', 'AEKHL', 'OMSLL', 'OMSOH', 'AEFJR', 'AEKLF',
  'SADMM', 'SAJED', 'DJJIB', 'EGPSD', 'EGSUE', 'EGALY', 'TRIST', 'TRMER',
  'GRPIR', 'SIKOP', 'NLRTM', 'DEHAM', 'GBFXT', 'GBLGP', 'GBSOU', 'ESALG',
  'ESVLC', 'ESBCN', 'ITGOA', 'PLGDN', 'ZADUR', 'ZACPT', 'MXZLO', 'MXLZC',
  'MXVER', 'COBUN', 'COCTG', 'CLSAI', 'CLVAP', 'PECLL', 'PECHY', 'BRSSZ',
  'JPYOK', 'THLCH', 'IDTPP', 'PHMNL', 'RUVYP', 'RULED', 'RUNVS', 'QAHMD',
]);

// Official 5-char UN/LOCODE mapping for curated cities
const CURATED_CITY_UNLOCODE = {
  CITY_SZ: 'CNSZX',
  CITY_HK: 'HKHKG',
  CITY_GZ: 'CNCAN',
  CITY_DXB: 'AEDXB',
  CITY_AMS: 'NLAMS',
  CITY_BUD: 'HUBUD',
  CITY_IST: 'TRIST',
  CITY_LON: 'GBLON',
  CITY_MAD: 'ESMAD',
  CITY_ROM: 'ITROM',
  CITY_WAW: 'PLWAW',
  CITY_JNB: 'ZAJNB',
  CITY_RUH: 'SARUH',
  CITY_CAI: 'EGCAI',
  CITY_KWI: 'KWKWI',
  CITY_DOH: 'QADOH',
  CITY_MEX: 'MXMEX',
  CITY_BOG: 'COBOG',
  CITY_SCL: 'CLSCL',
  CITY_LIM: 'PELIM',
  CITY_SAO: 'BRSAO',
  CITY_MOW: 'RUMOW',
  CITY_KUL: 'MYKUL',
  CITY_MNL: 'PHMNL',
  CITY_BKK: 'THBKK',
  CITY_JKT: 'IDJKT',
  CITY_TYO: 'JPTYO',
  CITY_BTH: 'IDBTH',
  CITY_MCT: 'OMMCT',
  CITY_ADD: 'ETADD',
  CITY_AMM: 'JOAMM',
};

// Official 5-char UN/LOCODE mapping for curated ports that omitted `code`
const CURATED_PORT_UNLOCODE = {
  PORT_HAMAD: 'QAHMD',
  PORT_ROTTERDAM: 'NLRTM',
  PORT_FELIXSTOWE: 'GBFXT',
  PORT_LONDONGATEWAY: 'GBLGP',
  PORT_SOUTHAMPTON: 'GBSOU',
  PORT_VALENCIA: 'ESVLC',
  PORT_BARCELONA: 'ESBCN',
  PORT_ALGECIRAS: 'ESALG',
  PORT_GENOA: 'ITGOA',
  PORT_CIVITAVECCHIA: 'ITCVV',
  PORT_GIOIATAURO: 'ITGIT',
  PORT_KOPER: 'SIKOP',
  PORT_PIRAEUS: 'GRPIR',
  PORT_HAMBURG: 'DEHAM',
  PORT_GDANSK: 'PLGDN',
  PORT_MANZANILLO: 'MXZLO',
  PORT_LAZAROCARDENAS: 'MXLZC',
  PORT_VERACRUZ: 'MXVER',
  PORT_BUENAVENTURA: 'COBUN',
  PORT_CARTAGENA: 'COCTG',
  PORT_SANANTONIO: 'CLSAI',
  PORT_VALPARAISO: 'CLVAP',
  PORT_CALLAO: 'PECLL',
  PORT_CHANCAY: 'PECHY',
  PORT_SANTOS: 'BRSSZ',
  PORT_KLANG: 'MYPKG',
  PORT_TPP: 'MYTPP',
  PORT_LAEMCHABANG: 'THLCH',
  PORT_BANGKOK: 'THBKK',
  PORT_TANJUNGPRIOK: 'IDTPP',
  PORT_MANILA: 'PHMNL',
  PORT_BATANGAS: 'PHBTG',
  PORT_BATAM: 'IDBUR',
  PORT_SINGAPORE: 'SGSIN',
  PORT_YOKOHAMA: 'JPYOK',
  PORT_VOSTOCHNY: 'RUVYP',
  PORT_STPETERSBURG: 'RULED',
  PORT_NOVOROSSIYSK: 'RUNVS',
};

function roundCoord(val) {
  const r = +Number(val).toFixed(4);
  return Object.is(r, -0) ? 0 : r;
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length < headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }
  return rows;
}

function buildMarnetGraph(marnetGeo, passageMap) {
  const vertexIndexByKey = new Map();
  const vertices = [];
  const edges = [];

  const normCoord = ([lon, lat]) => {
    let nLon = roundCoord(normalizeLon(lon));
    if (nLon >= 180) nLon = -180;
    return [nLon, roundCoord(lat)];
  };
  const coordKey = ([lon, lat]) => `${lon},${lat}`;

  const lines = [];
  for (const feature of marnetGeo.features ?? []) {
    const geom = feature.geometry;
    if (!geom) continue;
    const rawPassage = feature.properties?.passage ?? null;
    if (geom.type === 'LineString') {
      lines.push({ coords: geom.coordinates.map(normCoord), rawPassage });
    } else if (geom.type === 'MultiLineString') {
      for (const ls of geom.coordinates ?? []) {
        lines.push({ coords: ls.map(normCoord), rawPassage });
      }
    }
  }

  const featCount = new Map();
  const endpointKeys = new Set();
  for (const { coords } of lines) {
    if (coords.length < 2) continue;
    endpointKeys.add(coordKey(coords[0]));
    endpointKeys.add(coordKey(coords[coords.length - 1]));
    const seen = new Set();
    for (const c of coords) {
      const k = coordKey(c);
      if (!seen.has(k)) {
        seen.add(k);
        featCount.set(k, (featCount.get(k) || 0) + 1);
      }
    }
  }

  function getOrCreateVertex([nLon, nLat]) {
    const key = `${nLon},${nLat}`;
    const existing = vertexIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    vertices.push({ id, lon: nLon, lat: nLat });
    vertexIndexByKey.set(key, id);
    return id;
  }

  for (const { coords, rawPassage } of lines) {
    if (coords.length < 2) continue;
    const passage = rawPassage ? (passageMap.get(rawPassage) ?? rawPassage) : null;
    let segStart = 0;
    for (let i = 1; i < coords.length; i++) {
      const k = coordKey(coords[i]);
      const isJunction =
        i === coords.length - 1 || endpointKeys.has(k) || (featCount.get(k) || 0) > 1;
      if (!isJunction) continue;

      const sub = coords.slice(segStart, i + 1);
      const u = getOrCreateVertex(sub[0]);
      const v = getOrCreateVertex(sub[sub.length - 1]);
      segStart = i;
      if (u === v) continue;

      let distanceKm = 0;
      for (let j = 1; j < sub.length; j++) {
        distanceKm += haversineKm(sub[j - 1][0], sub[j - 1][1], sub[j][0], sub[j][1]);
      }

      const edgeId = edges.length;
      edges.push({
        id: edgeId,
        u,
        v,
        distanceKm: +distanceKm.toFixed(3),
        passage,
        rawPassage,
        coords: decimateCoords(sub, 6),
      });
    }
  }

  const adjacency = Array.from({ length: vertices.length }, () => []);
  for (const edge of edges) {
    adjacency[edge.u].push({ to: edge.v, edgeId: edge.id, reverse: false });
    adjacency[edge.v].push({ to: edge.u, edgeId: edge.id, reverse: true });
  }

  const visited = new Uint8Array(vertices.length);
  const componentSizes = [];
  for (let i = 0; i < vertices.length; i++) {
    if (visited[i]) continue;
    let size = 0;
    const queue = [i];
    visited[i] = 1;
    while (queue.length) {
      const curr = queue.pop();
      size++;
      for (const next of adjacency[curr]) {
        if (!visited[next.to]) {
          visited[next.to] = 1;
          queue.push(next.to);
        }
      }
    }
    componentSizes.push(size);
  }
  componentSizes.sort((a, b) => b - a);

  return { vertices, edges, adjacency, componentSizes };
}

function buildSpatialGrid(vertices, cellDeg = 2) {
  const buckets = new Map();
  for (const v of vertices) {
    const cx = Math.floor((v.lon + 180) / cellDeg);
    const cy = Math.floor((v.lat + 90) / cellDeg);
    const key = `${cx},${cy}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }
  const numCols = Math.ceil(360 / cellDeg);

  return function snapToMarnet(lon, lat, maxKm = 220) {
    const nLon = normalizeLon(lon);
    const cx = Math.floor((nLon + 180) / cellDeg);
    const cy = Math.floor((lat + 90) / cellDeg);
    let best = null;
    let bestKm = Infinity;

    for (const radius of [1, 2, 4, 6]) {
      for (let dx = -radius; dx <= radius; dx++) {
        const wx = ((cx + dx) % numCols + numCols) % numCols;
        for (let dy = -radius; dy <= radius; dy++) {
          const list = buckets.get(`${wx},${cy + dy}`);
          if (!list) continue;
          for (const v of list) {
            const d = haversineKm(nLon, lat, v.lon, v.lat);
            if (d < bestKm) {
              bestKm = d;
              best = v;
            }
          }
        }
      }
      if (best && bestKm <= maxKm) break;
    }

    if (!best || bestKm > maxKm) return null;
    return { marnetVertexId: best.id, snapDistanceKm: +bestKm.toFixed(2) };
  };
}

function canonicalizeSeedNode(seed) {
  const legacyId = seed.id;
  if (seed.type === 'country' && /^[A-Z]{2}$/i.test(seed.country ?? '')) {
    const code = seed.country.toUpperCase();
    return { id: code, code, codeStandard: 'ISO-3166-1', legacyId };
  }
  if ((seed.type === 'airport' || seed.type === 'hub_airport') && /^[A-Z]{3}$/i.test(seed.code ?? '')) {
    const code = seed.code.toUpperCase();
    return { id: code, code, codeStandard: 'IATA', legacyId };
  }
  if (seed.type === 'port') {
    const code = (seed.code || CURATED_PORT_UNLOCODE[legacyId] || '').toUpperCase();
    if (/^[A-Z0-9]{5}$/.test(code)) {
      return { id: code, code, codeStandard: 'UN/LOCODE', legacyId };
    }
  }
  if (seed.type === 'city') {
    const code = (seed.code || CURATED_CITY_UNLOCODE[legacyId] || '').toUpperCase();
    if (/^[A-Z0-9]{5}$/.test(code)) {
      return { id: code, code, codeStandard: 'UN/LOCODE', legacyId };
    }
  }
  return { id: legacyId, code: seed.code ?? null, codeStandard: 'custom', legacyId };
}

async function main() {
  const [marnetRaw, portsRaw, airportsCsv, chokepointsCfg, corridorsCfg, seedNodes] =
    await Promise.all([
      readFile(join(RAW_DIR, 'marnet_searoute.geojson'), 'utf8').then(JSON.parse),
      readFile(join(RAW_DIR, 'ports.geojson'), 'utf8').then(JSON.parse),
      readFile(join(RAW_DIR, 'airports.csv'), 'utf8'),
      readFile(join(CURATED_DIR, 'chokepoints.json'), 'utf8').then(JSON.parse),
      readFile(join(CURATED_DIR, 'rail-land-corridors.json'), 'utf8').then(JSON.parse),
      readFile(join(CURATED_DIR, 'seed-nodes.json'), 'utf8').then(JSON.parse),
    ]);

  const passageMap = new Map(
    chokepointsCfg.passages.map((cp) => [cp.marnetPassage, cp.id])
  );
  const marnet = buildMarnetGraph(marnetRaw, passageMap);
  const snapToMarnet = buildSpatialGrid(marnet.vertices);

  const nodesById = new Map();
  const portByCode = new Map();
  const airportByCode = new Map();

  function registerNode(node) {
    const existing = nodesById.get(node.id);
    if (existing) {
      // Check intentional UN/LOCODE multi-function unification (e.g. city+port, hub+port)
      const isMultiFunctionUnlocode =
        existing.codeStandard === 'UN/LOCODE' &&
        node.codeStandard === 'UN/LOCODE' &&
        (existing.type === 'port' || node.type === 'port');
      const isSameType = existing.type === node.type;
      if (!isMultiFunctionUnlocode && !isSameType) {
        throw new Error(
          `Canonical node ID collision on "${node.id}": ${existing.type} (${existing.name_en}) vs ${node.type} (${node.name_en})`
        );
      }

      const mergedFunctions = new Set([
        ...(existing.functions ?? [existing.type]),
        ...(node.functions ?? [node.type]),
      ]);
      const preferType = existing.curated ? existing.type : node.curated ? node.type : existing.type;

      const merged = {
        ...existing,
        ...node,
        id: existing.id,
        type: preferType,
        functions: [...mergedFunctions],
        name_zh: existing.curated ? existing.name_zh : (node.name_zh || existing.name_zh),
        name_en: existing.curated ? existing.name_en : (node.name_en || existing.name_en),
        curated: Boolean(existing.curated || node.curated),
        isCuratedPort: Boolean(existing.isCuratedPort || node.isCuratedPort),
        verified: Boolean(existing.verified || node.verified),
        isMajor: Boolean(existing.isMajor || node.isMajor),
        isHub: Boolean(existing.isHub || node.isHub),
        marnetVertexId: existing.marnetVertexId ?? node.marnetVertexId,
        snapDistanceKm: existing.snapDistanceKm ?? node.snapDistanceKm,
        aliases: [...new Set([...(existing.aliases ?? []), ...(node.aliases ?? [])])],
        legacyIds: [...new Set([...(existing.legacyIds ?? []), ...(node.legacyIds ?? [])])],
      };
      nodesById.set(merged.id, merged);
      if (mergedFunctions.has('port') && merged.code) {
        portByCode.set(merged.code.toUpperCase(), merged.id);
      }
      if ((merged.type === 'airport' || merged.type === 'hub_airport') && merged.code) {
        airportByCode.set(merged.code.toUpperCase(), merged.id);
      }
      return;
    }

    const created = {
      ...node,
      functions: [...new Set(node.functions ?? [node.type])],
      aliases: [...new Set(node.aliases ?? [])],
      legacyIds: [...new Set(node.legacyIds ?? [])],
    };
    nodesById.set(created.id, created);
    if (created.functions.includes('port') && created.code) {
      portByCode.set(created.code.toUpperCase(), created.id);
    }
    if ((created.type === 'airport' || created.type === 'hub_airport') && created.code) {
      airportByCode.set(created.code.toUpperCase(), created.id);
    }
  }

  // 1. Seed curated nodes canonicalized to ISO / IATA / UN/LOCODE
  // Defer non-city/port rail nodes because rail-land-corridors.json defines updated canonical IDs
  const railCorridorIds = new Set(corridorsCfg.nodes.map((n) => n.id));
  const railLegacyToCanonical = new Map();
  for (const rNode of corridorsCfg.nodes) {
    for (const lid of rNode.legacyIds ?? []) railLegacyToCanonical.set(lid, rNode.id);
  }

  for (const seed of seedNodes) {
    if (railLegacyToCanonical.has(seed.id) || railCorridorIds.has(seed.id)) {
      continue;
    }
    const { id, code, codeStandard, legacyId } = canonicalizeSeedNode(seed);
    const legacyIds = legacyId !== id ? [legacyId] : [];
    const aliases = [...(seed.aliases ?? []), ...(code ? [code] : []), ...legacyIds];

    const node = {
      id,
      type: seed.type,
      functions: [seed.type],
      code,
      codeStandard,
      name_zh: seed.name_zh,
      name_en: seed.name_en ?? seed.name_zh ?? id,
      country: seed.country ?? '',
      region: seed.region ?? null,
      lon: normalizeLon(seed.lon),
      lat: seed.lat,
      aliases,
      legacyIds,
      curated: true,
      verified: Boolean(seed.verified),
    };

    if (node.type === 'port') {
      const snap = snapToMarnet(node.lon, node.lat, 300);
      if (snap) {
        node.marnetVertexId = snap.marnetVertexId;
        node.snapDistanceKm = snap.snapDistanceKm;
      }
      if (node.code && MAJOR_SEA_HUB_CODES.has(node.code.toUpperCase())) {
        node.isHub = true;
      }
      node.isCuratedPort = true;
      if (node.verified || MAJOR_SEA_HUB_CODES.has(node.code)) node.isMajor = true;
    }
    if (node.type === 'airport' || node.type === 'hub_airport') {
      if (node.code && MAJOR_AIR_CARGO_HUBS.has(node.code.toUpperCase())) {
        node.isHub = true;
      }
      node.isMajor = true;
    }
    registerNode(node);
  }

  // 2. Canonical chokepoints & airspaces
  for (const cp of chokepointsCfg.passages) {
    registerNode({
      id: cp.id,
      type: 'chokepoint',
      code: cp.id,
      codeStandard: 'custom',
      name_zh: cp.name_zh,
      name_en: cp.name_en,
      region: cp.region,
      lon: cp.lon,
      lat: cp.lat,
      major: Boolean(cp.major),
      marnetPassage: cp.marnetPassage,
      aliases: cp.aliases ?? [],
      curated: true,
    });
  }
  for (const as of chokepointsCfg.airspaces) {
    registerNode({
      id: as.id,
      type: 'airspace',
      code: as.id,
      codeStandard: 'custom',
      name_zh: as.name_zh,
      name_en: as.name_en,
      region: as.region,
      lon: as.lon,
      lat: as.lat,
      boxes: as.boxes,
      aliases: as.aliases ?? [],
      curated: true,
    });
  }

  // 3. Curated rail/land corridor nodes (with UN/LOCODE IDs like DEDUI, KZAAU, AZBAK, GETBS, CNALA, PLMLW, CNMZH, RUZAB)
  for (const rNode of corridorsCfg.nodes) {
    const legacyIds = rNode.legacyIds ?? [];
    registerNode({
      ...rNode,
      aliases: [...(rNode.aliases ?? []), ...(rNode.code ? [rNode.code] : []), ...legacyIds],
      legacyIds,
      curated: true,
    });
  }

  // 4. Ingest global public ports directly under raw 5-char UN/LOCODE IDs
  let publicPortsLoaded = 0;
  let publicPortsSnapped = 0;
  for (const feature of portsRaw.features ?? []) {
    if (feature.geometry?.type !== 'Point') continue;
    const [rawLon, lat] = feature.geometry.coordinates ?? [];
    if (!Number.isFinite(rawLon) || !Number.isFinite(lat)) continue;
    const lon = normalizeLon(rawLon);
    const props = feature.properties ?? {};
    const locode = typeof props.port === 'string' ? props.port.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(locode)) continue;
    publicPortsLoaded++;

    const snap = snapToMarnet(lon, lat, 200);
    if (!snap) continue;
    publicPortsSnapped++;

    const country = locode.slice(0, 2);
    registerNode({
      id: locode,
      type: 'port',
      functions: ['port'],
      code: locode,
      codeStandard: 'UN/LOCODE',
      name_en: props.name || locode,
      country,
      lon: +lon.toFixed(4),
      lat: +lat.toFixed(4),
      aliases: [locode, props.name].filter(Boolean),
      marnetVertexId: snap.marnetVertexId,
      snapDistanceKm: snap.snapDistanceKm,
      isMajor: props.t === 1 || MAJOR_SEA_HUB_CODES.has(locode),
      isHub: MAJOR_SEA_HUB_CODES.has(locode),
      curated: false,
    });
  }

  // 5. Ingest global scheduled airports directly under raw 3-char IATA IDs
  const airportRows = parseCsv(airportsCsv);
  let publicAirportsLoaded = 0;
  for (const row of airportRows) {
    if (row.type !== 'large_airport' && row.type !== 'medium_airport') continue;
    if (row.scheduled_service !== 'yes') continue;
    const iata = (row.iata_code ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) continue;
    const lat = Number(row.latitude_deg);
    const lon = normalizeLon(Number(row.longitude_deg));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    publicAirportsLoaded++;

    const isHub = MAJOR_AIR_CARGO_HUBS.has(iata);
    registerNode({
      id: iata,
      type: 'airport',
      functions: ['airport'],
      code: iata,
      codeStandard: 'IATA',
      name_en: row.name,
      country: row.iso_country ?? '',
      municipality: row.municipality ?? '',
      airportSize: row.type,
      lon: +lon.toFixed(4),
      lat: +lat.toFixed(4),
      aliases: [iata, row.municipality, row.name].filter(Boolean),
      isMajor: row.type === 'large_airport',
      isHub,
      curated: false,
    });
  }

  // 6. Build curated land/rail corridor edges with Haversine distance
  const landEdges = [];
  for (const c of corridorsCfg.corridors) {
    const u = nodesById.get(c.from);
    const v = nodesById.get(c.to);
    if (!u || !v) {
      throw new Error(`Invalid land corridor ${c.id}: missing ${!u ? c.from : c.to}`);
    }
    const distanceKm = +haversineKm(u.lon, u.lat, v.lon, v.lat).toFixed(2);
    landEdges.push({
      id: c.id,
      from: c.from,
      to: c.to,
      mode: c.mode,
      corridor: c.corridor,
      distanceKm,
      bidirectional: c.bidirectional !== false,
    });
  }

  const nodes = [...nodesById.values()];
  const missingChineseNames = [];
  for (const node of nodes) {
    const nameZh = [node.name_zh, endpointNamesZh[node.id]?.[0], publicNodeNamesZh[node.id]]
      .find((name) => /\p{Script=Han}/u.test(name ?? ''));
    if (nameZh) {
      node.name_zh = nameZh;
    } else {
      missingChineseNames.push(`${node.id} (${node.name_en})`);
    }
  }
  if (missingChineseNames.length) {
    throw new Error(`Missing Chinese node names:\n${missingChineseNames.join('\n')}`);
  }

  const payload = {
    nodes,
    chokepoints: chokepointsCfg,
    marnet: {
      vertices: marnet.vertices,
      edges: marnet.edges,
    },
    landEdges,
  };

  const payloadJson = JSON.stringify(payload);
  const graphVersion = createHash('sha256').update(payloadJson).digest('hex').slice(0, 12);

  const [marnetStat, portsStat, airportsStat] = await Promise.all([
    stat(join(RAW_DIR, 'marnet_searoute.geojson')),
    stat(join(RAW_DIR, 'ports.geojson')),
    stat(join(RAW_DIR, 'airports.csv')),
  ]);

  const counts = {
    nodesTotal: nodes.length,
    cities: nodes.filter((n) => n.type === 'city').length,
    ports: nodes.filter((n) => n.functions?.includes('port')).length,
    snappedPorts: nodes.filter((n) => n.functions?.includes('port') && n.marnetVertexId != null).length,
    airports: nodes.filter((n) => n.type === 'airport' || n.type === 'hub_airport').length,
    chokepoints: nodes.filter((n) => n.type === 'chokepoint').length,
    marnetVertices: marnet.vertices.length,
    marnetEdges: marnet.edges.length,
    marnetComponents: marnet.componentSizes.slice(0, 5),
    landEdges: landEdges.length,
    publicPortsLoaded,
    publicPortsSnapped,
    publicAirportsLoaded,
    byStandard: nodes.reduce((acc, n) => {
      const s = n.codeStandard || 'custom';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {}),
  };

  const manifest = {
    graphVersion,
    builtAt: new Date().toISOString(),
    sources: {
      marnet_searoute: { bytes: marnetStat.size, mtime: marnetStat.mtime.toISOString() },
      ports: { bytes: portsStat.size, mtime: portsStat.mtime.toISOString() },
      airports: { bytes: airportsStat.size, mtime: airportsStat.mtime.toISOString() },
    },
    counts,
  };

  await mkdir(COMPILED_DIR, { recursive: true });
  await Promise.all([
    writeFile(join(COMPILED_DIR, 'graph.json'), JSON.stringify({ graphVersion, ...payload })),
    writeFile(join(COMPILED_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'),
  ]);

  console.log(`Built graphVersion=${graphVersion}`);
  console.log('Counts:', counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
