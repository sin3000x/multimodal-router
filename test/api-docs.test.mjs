import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_CONVENTIONS,
  API_ENDPOINTS,
  API_GROUPS,
  API_STATUS_CODES,
  buildRequestSpec,
  shellQuote,
} from '../public/api-docs-data.js';
import { renderApiMarkdown } from '../scripts/generate-api-docs.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

test('API_ENDPOINTS covers all 9 HTTP endpoints with complete metadata', () => {
  const expectedPaths = [
    '/v1/routes',
    '/v1/routes/compare',
    '/v1/precompute',
    '/v1/nodes',
    '/v1/chokepoints',
    '/v1/graph/nodes',
    '/v1/graph/links',
    '/v1/snapshots/risk-radar',
    '/health',
  ];
  assert.deepEqual(
    API_ENDPOINTS.map((ep) => ep.path),
    expectedPaths
  );

  const groupIds = new Set(API_GROUPS.map((g) => g.id));
  for (const ep of API_ENDPOINTS) {
    assert.ok(ep.id, `missing id for ${ep.path}`);
    assert.ok(groupIds.has(ep.group), `unknown group ${ep.group} for ${ep.path}`);
    assert.ok(['GET', 'POST'].includes(ep.method));
    assert.ok(Array.isArray(ep.methods) && ep.methods.includes(ep.method));
    assert.ok(ep.title && ep.summary);
    assert.ok(Array.isArray(ep.params));
    assert.ok(Array.isArray(ep.responseFields) && ep.responseFields.length > 0);
    assert.ok(ep.responseSample && typeof ep.responseSample === 'object');
  }
  assert.ok(API_CONVENTIONS.length >= 4);
  for (const section of API_CONVENTIONS) {
    assert.ok(section.id && section.title);
    assert.ok(Array.isArray(section.items) && section.items.length > 0);
  }
  assert.ok(API_STATUS_CODES.some((s) => s.code.startsWith('200')));
  assert.ok(API_STATUS_CODES.some((s) => s.code.startsWith('413')));
});

test('docs/API.md stays in sync with public/api-docs-data.js', async () => {
  const actual = await readFile(join(ROOT_DIR, 'docs', 'API.md'), 'utf8');
  const expected = renderApiMarkdown();
  assert.equal(actual, expected, 'docs/API.md is out of sync with public/api-docs-data.js; run npm run docs:api');
});

test('buildRequestSpec generates valid POST/GET specs and shell-safe cURL commands', () => {
  const byId = new Map(API_ENDPOINTS.map((ep) => [ep.id, ep]));
  const state = {
    route: {
      from: 'CNSZX',
      to: 'NLAMS',
      modes: ['sea', 'air'],
      avoid: ['CP_SUEZ'],
      maxRoutes: 6,
      includeGeometry: false,
    },
    nodeSearch: {
      q: '深圳',
      type: 'city',
      endpoint: '1',
      limit: '15',
    },
  };

  const postRoutes = buildRequestSpec(byId.get('routes'), state, 'http://localhost:4180', 'POST');
  assert.equal(postRoutes.method, 'POST');
  assert.equal(postRoutes.url, 'http://localhost:4180/v1/routes');
  assert.deepEqual(JSON.parse(postRoutes.bodyText), state.route);
  assert.match(postRoutes.curl, /^curl -X POST 'http:\/\/localhost:4180\/v1\/routes' -H 'Content-Type: application\/json' --data-raw /);

  const getRoutes = buildRequestSpec(byId.get('routes'), state, 'http://localhost:4180', 'GET');
  assert.equal(getRoutes.method, 'GET');
  assert.equal(getRoutes.bodyText, '');
  const getUrl = new URL(getRoutes.url);
  assert.equal(getUrl.searchParams.get('from'), 'CNSZX');
  assert.equal(getUrl.searchParams.get('modes'), 'sea,air');
  assert.equal(getUrl.searchParams.get('avoid'), 'CP_SUEZ');
  assert.equal(getUrl.searchParams.get('maxRoutes'), '6');

  const compareSpec = buildRequestSpec(byId.get('compare'), state, 'http://localhost:4180', 'POST');
  assert.equal(compareSpec.url, 'http://localhost:4180/v1/routes/compare');
  assert.deepEqual(JSON.parse(compareSpec.bodyText).avoid, ['CP_SUEZ']);

  const precomputeSpec = buildRequestSpec(byId.get('precompute'), state, 'http://localhost:4180');
  assert.deepEqual(JSON.parse(precomputeSpec.bodyText), {
    pairs: [{ from: 'CNSZX', to: 'NLAMS' }],
    avoidScenarios: [[], ['CP_SUEZ']],
    modes: ['sea', 'air'],
    maxRoutes: 6,
    includeGeometry: false,
  });

  const nodesSpec = buildRequestSpec(byId.get('nodes'), state, 'http://localhost:4180');
  assert.equal(nodesSpec.method, 'GET');
  const nodesUrl = new URL(nodesSpec.url);
  assert.equal(nodesUrl.searchParams.get('q'), '深圳');
  assert.equal(nodesUrl.searchParams.get('type'), 'city');
  assert.equal(nodesUrl.searchParams.get('endpoint'), '1');
  assert.equal(nodesUrl.searchParams.get('limit'), '15');

  const healthSpec = buildRequestSpec(byId.get('health'), state, 'http://localhost:4180');
  assert.equal(healthSpec.curl, "curl 'http://localhost:4180/health'");

  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});

test('index.html exposes upgraded API 说明 dialog and tabs', async () => {
  const html = await readFile(join(ROOT_DIR, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('>API 说明</button>'));
  assert.ok(html.includes('<h2 id="api-catalog-title">API 说明</h2>'));
  for (const id of [
    'api-panel-docs',
    'api-panel-dict',
    'api-panel-guide',
    'api-nav',
    'api-try-btn',
    'api-live-box',
    'api-guide-grid',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
});
