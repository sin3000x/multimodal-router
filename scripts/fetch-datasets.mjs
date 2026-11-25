import { createWriteStream } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const RAW_DIR = join(ROOT_DIR, 'data', 'raw');

const DATASETS = [
  {
    name: 'marnet_searoute.geojson',
    url: 'https://raw.githubusercontent.com/genthalili/searoute-py/main/searoute/data/marnet_searoute.geojson',
    description: 'Eurostat/ORNL MARNET maritime routing graph (4,109 edges + 13 passages)',
  },
  {
    name: 'ports.geojson',
    url: 'https://raw.githubusercontent.com/genthalili/searoute-py/main/searoute/data/ports.geojson',
    description: 'Global maritime ports with UN/LOCODE and coordinates',
  },
  {
    name: 'airports.csv',
    url: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
    description: 'OurAirports public-domain global airport catalog',
  },
  {
    name: 'ne_10m_roads.geojson',
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson',
    description: 'Natural Earth 1:10m global highway network',
  },
  {
    name: 'airline_routes.json',
    url: 'https://raw.githubusercontent.com/Jonty/airline-route-data/main/airline_routes.json',
    description: 'Global scheduled airline route network indexed by IATA code',
  },
  {
    name: 'fir_boundaries.geojson',
    url: 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson',
    description: 'VATSIM VATSpy global ICAO FIR/UIR airspace boundary polygons (GeoJSON)',
  },
];

async function existsNonEmpty(filePath) {
  try {
    await access(filePath);
    const info = await stat(filePath);
    return info.size > 0;
  } catch {
    return false;
  }
}

async function downloadFile(dataset, force) {
  const target = join(RAW_DIR, dataset.name);
  if (!force && (await existsNonEmpty(target))) {
    const info = await stat(target);
    console.log(`[skip] ${dataset.name} (${(info.size / 1024).toFixed(1)} KB)`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  console.log(`[fetch] ${dataset.name} <- ${dataset.url}`);
  const response = await fetch(dataset.url, {
    headers: { 'user-agent': 'multimodal-router/1.0' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${dataset.url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const info = await stat(target);
  console.log(`[done] ${dataset.name} (${(info.size / 1024).toFixed(1)} KB)`);
}

async function main() {
  const force = process.argv.includes('--force');
  await mkdir(RAW_DIR, { recursive: true });
  for (const dataset of DATASETS) {
    await downloadFile(dataset, force);
  }
  console.log('All public datasets ready in data/raw/.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
