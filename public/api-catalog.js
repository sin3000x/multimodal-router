import {
  API_CONVENTIONS,
  API_ENDPOINTS,
  API_ERROR_FORMAT,
  API_GROUPS,
  API_STATUS_CODES,
  buildRequestSpec,
  shellQuote,
} from './api-docs-data.js';

const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const MAX_PREVIEW_CHARS = 28000;

function appendInlineCode(parent, text) {
  const parts = String(text).split(/`([^`]+)`/g);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    parent.appendChild(i % 2 === 1 ? el('code', '', parts[i]) : document.createTextNode(parts[i]));
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildTable(headers, rowsData) {
  const wrap = el('div', 'api-spec-wrap');
  const table = el('table', 'api-spec-table');
  const thead = table.createTHead();
  const headRow = thead.insertRow();
  for (const label of headers) {
    const th = el('th', '', label);
    th.scope = 'col';
    headRow.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const cells of rowsData) {
    const row = tbody.insertRow();
    for (const cell of cells) {
      const td = row.insertCell();
      if (typeof cell === 'function') cell(td);
      else td.textContent = cell;
    }
  }
  wrap.appendChild(table);
  return wrap;
}

export function initApiCatalog({ fetchJson, getRoutePayload, nodeGroups, groupLabels }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('api-catalog');
  const baseUrlEl = get('api-base-url');
  const nav = get('api-nav');
  const docMethod = get('api-doc-method');
  const docPath = get('api-doc-path');
  const docTitle = get('api-doc-title');
  const methodSwitch = get('api-method-switch');
  const docSummary = get('api-doc-summary');
  const docNote = get('api-doc-note');
  const docParams = get('api-doc-params');
  const nodeSearchControls = get('api-node-search-controls');
  const nsQ = get('api-ns-q');
  const nsType = get('api-ns-type');
  const nsEndpoint = get('api-ns-endpoint');
  const nsLimit = get('api-ns-limit');
  const reqUrlEl = get('api-req-url');
  const payload = get('api-payload');
  const copyJsonBtn = get('api-copy-json');
  const copyCurlBtn = get('api-copy-curl');
  const tryBtn = get('api-try-btn');
  const copyStatus = get('api-copy-status');
  const liveBox = get('api-live-box');
  const liveStatus = get('api-live-status');
  const liveMeta = get('api-live-meta');
  const liveOutput = get('api-live-output');
  const docResponseFields = get('api-doc-response-fields');
  const docSampleWrap = get('api-doc-sample-wrap');
  const docSample = get('api-doc-sample');

  const dictSelection = get('api-dict-selection');
  const dictionary = get('api-dictionary');
  const search = get('api-search');
  const rows = get('api-values');
  const count = get('api-result-count');
  const pageSizeSelect = get('api-page-size');
  const prev = get('api-prev');
  const next = get('api-next');

  const catalogs = new Map();
  let page = 0;
  let activeTab = 'docs';
  let activeEndpointId = 'routes';
  let activeMethod = 'POST';
  let customBodyText = null;
  let lastResponseText = '';
  let statusTimer = null;

  const state = {
    route: {
      from: 'CNSZX',
      to: 'NLAMS',
      modes: ['sea', 'air', 'rail', 'road'],
      avoid: [],
      maxRoutes: 8,
      includeGeometry: false,
    },
    nodeSearch: {
      q: '深圳',
      type: '',
      endpoint: '1',
      limit: '10',
    },
  };

  function showStatus(text) {
    copyStatus.textContent = text;
    clearTimeout(statusTimer);
    if (text) {
      statusTimer = setTimeout(() => {
        copyStatus.textContent = '';
      }, 2400);
    }
  }

  async function copy(value, message = '已复制') {
    try {
      await navigator.clipboard.writeText(value);
      showStatus(message);
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      showStatus(ok ? message : '复制失败，请手动复制');
    }
  }

  function currentEndpoint() {
    return API_ENDPOINTS.find((ep) => ep.id === activeEndpointId) ?? API_ENDPOINTS[0];
  }

  function setTab(tab) {
    activeTab = tab;
    for (const btn of dialog.querySelectorAll('[data-api-tab]')) {
      const selected = btn.dataset.apiTab === tab;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-selected', String(selected));
    }
    for (const panel of dialog.querySelectorAll('[data-api-panel]')) {
      panel.hidden = panel.dataset.apiPanel !== tab;
    }
    if (tab === 'dict') {
      renderDictSelection();
      loadCatalog();
    }
  }

  function renderNav() {
    nav.replaceChildren();
    for (const group of API_GROUPS) {
      const groupTitle = el('div', 'api-nav-group', group.label);
      nav.appendChild(groupTitle);
      const items = API_ENDPOINTS.filter((ep) => ep.group === group.id);
      for (const ep of items) {
        const btn = el('button', 'api-nav-item');
        btn.type = 'button';
        btn.dataset.endpointId = ep.id;
        btn.setAttribute('aria-current', ep.id === activeEndpointId ? 'page' : 'false');
        btn.classList.toggle('active', ep.id === activeEndpointId);

        const badge = el('span', `api-method api-method-${ep.method.toLowerCase()}`, ep.method);
        const textWrap = el('span', 'api-nav-text');
        const title = el('strong', '', ep.title);
        const path = el('code', '', ep.path);
        textWrap.append(title, path);
        btn.append(badge, textWrap);

        btn.onclick = () => {
          activeEndpointId = ep.id;
          activeMethod = ep.method;
          customBodyText = null;
          liveBox.hidden = true;
          lastResponseText = '';
          renderNav();
          renderEndpointDoc();
        };
        nav.appendChild(btn);
      }
    }
  }

  function currentSpec() {
    const ep = currentEndpoint();
    const spec = buildRequestSpec(ep, state, location.origin, activeMethod);
    if (spec.method === 'POST' && customBodyText !== null) {
      return {
        ...spec,
        bodyText: customBodyText,
        curl: `curl -X POST ${shellQuote(spec.url)} -H 'Content-Type: application/json' --data-raw ${shellQuote(customBodyText)}`,
      };
    }
    return spec;
  }

  function renderRequestPreview() {
    const ep = currentEndpoint();
    const spec = currentSpec();
    const isPost = spec.method === 'POST';

    docMethod.textContent = spec.method;
    docMethod.className = `api-method api-method-${spec.method.toLowerCase()}`;
    reqUrlEl.textContent = `${spec.method} ${spec.pathWithQuery}`;

    nodeSearchControls.hidden = ep.id !== 'nodes';
    payload.hidden = !isPost;
    copyJsonBtn.hidden = !isPost;
    if (isPost) {
      payload.value = spec.bodyText;
    }
  }

  function renderEndpointDoc() {
    const ep = currentEndpoint();
    docPath.textContent = ep.path;
    docTitle.textContent = ep.title;
    docSummary.textContent = ep.summary;

    if (ep.note) {
      docNote.textContent = ep.note;
      docNote.hidden = false;
    } else {
      docNote.hidden = true;
    }

    if (ep.methods.length > 1) {
      methodSwitch.replaceChildren();
      methodSwitch.hidden = false;
      for (const m of ep.methods) {
        const btn = el('button', `seg-btn${m === activeMethod ? ' active' : ''}`, m);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(m === activeMethod));
        btn.onclick = () => {
          activeMethod = m;
          customBodyText = null;
          renderEndpointDoc();
        };
        methodSwitch.appendChild(btn);
      }
    } else {
      methodSwitch.hidden = true;
    }

    docParams.replaceChildren();
    if (!ep.params.length) {
      docParams.appendChild(el('p', 'api-empty-note', '该接口无需请求参数，直接发起 GET 请求即可。'));
    } else {
      docParams.appendChild(
        buildTable(
          ['参数名', '类型', '必填', '默认值', '说明'],
          ep.params.map((p) => [
            (td) => td.appendChild(el('code', '', p.name)),
            (td) => td.appendChild(el('code', 'api-type-code', p.type)),
            (td) => {
              const badge = el('span', `status-badge ${p.required ? 'tone-danger' : 'tone-neutral'}`, p.required ? '必填' : '可选');
              td.appendChild(badge);
            },
            (td) => td.appendChild(el('code', 'api-default-code', p.defaultValue)),
            p.desc,
          ])
        )
      );
    }

    docResponseFields.replaceChildren(
      buildTable(
        ['字段', '类型', '说明'],
        ep.responseFields.map((f) => [
          (td) => td.appendChild(el('code', '', f.name)),
          (td) => td.appendChild(el('code', 'api-type-code', f.type)),
          f.desc,
        ])
      )
    );

    docSample.textContent = JSON.stringify(ep.responseSample, null, 2);
    docSampleWrap.open = false;
    renderRequestPreview();
  }

  async function runTryIt() {
    const spec = currentSpec();
    const init = { method: spec.method };
    if (spec.method === 'POST') {
      const rawText = payload.value.trim() || '{}';
      try {
        JSON.parse(rawText);
      } catch (err) {
        liveBox.hidden = false;
        liveStatus.className = 'status-badge tone-danger';
        liveStatus.textContent = 'JSON 格式错误';
        liveMeta.textContent = '';
        liveOutput.textContent = err.message;
        lastResponseText = err.message;
        return;
      }
      init.headers = { 'content-type': 'application/json' };
      init.body = rawText;
    }

    tryBtn.disabled = true;
    tryBtn.textContent = '请求中…';
    const t0 = performance.now();

    try {
      const res = await fetch(spec.url, init);
      const elapsed = Math.round(performance.now() - t0);
      const raw = await res.text();
      let formatted = raw;
      let cacheInfo = '';
      try {
        const parsed = JSON.parse(raw);
        formatted = JSON.stringify(parsed, null, 2);
        const layer = parsed?.meta?.cache?.layer;
        if (parsed?.meta?.cache?.hit) cacheInfo = ` · 缓存命中 (${layer})`;
        else if (layer) cacheInfo = ` · 实时计算 (${layer})`;
      } catch {
        // Keep raw text if not JSON
      }

      lastResponseText = formatted;
      const truncated = formatted.length > MAX_PREVIEW_CHARS;
      liveOutput.textContent = truncated
        ? `${formatted.slice(0, MAX_PREVIEW_CHARS)}\n\n…（响应共 ${formatted.length.toLocaleString('zh-CN')} 字符，已截断预览，点击「复制响应」获取完整内容）`
        : formatted;

      liveStatus.className = `status-badge ${res.ok ? 'tone-success' : 'tone-danger'}`;
      liveStatus.textContent = `${res.status} ${res.statusText || (res.ok ? 'OK' : 'Error')}`;
      const kb = (new Blob([raw]).size / 1024).toFixed(1);
      liveMeta.textContent = `${elapsed} ms · ${kb} KB${cacheInfo}`;
      liveBox.hidden = false;
    } catch (err) {
      lastResponseText = err.message;
      liveStatus.className = 'status-badge tone-danger';
      liveStatus.textContent = '请求失败';
      liveMeta.textContent = '';
      liveOutput.textContent = err.message;
      liveBox.hidden = false;
    } finally {
      tryBtn.disabled = false;
      tryBtn.textContent = '发起试调';
    }
  }

  function renderDictSelection() {
    dictSelection.replaceChildren();
    const label = el('span', 'api-dict-label', '当前示例参数：');
    const fromTag = el('span', 'chip', `from: ${state.route.from}`);
    const toTag = el('span', 'chip', `to: ${state.route.to}`);
    const avoidText = state.route.avoid.length ? state.route.avoid.join(', ') : '无';
    const avoidTag = el('span', 'chip', `avoid: ${avoidText}`);
    dictSelection.append(label, fromTag, toTag, avoidTag);

    if (state.route.avoid.length) {
      const clearBtn = el('button', 'link-btn', '清空 avoid');
      clearBtn.type = 'button';
      clearBtn.onclick = () => {
        state.route.avoid = [];
        customBodyText = null;
        renderDictSelection();
        renderValues();
        renderRequestPreview();
      };
      dictSelection.appendChild(clearBtn);
    }

    const backBtn = el('button', 'map-btn map-btn-wide api-dict-back', '返回接口文档');
    backBtn.type = 'button';
    backBtn.onclick = () => setTab('docs');
    dictSelection.appendChild(backBtn);
  }

  function renderValues() {
    const catalog = catalogs.get(dictionary.value);
    rows.replaceChildren();
    prev.disabled = true;
    next.disabled = true;
    if (!catalog?.items) {
      count.textContent = catalog?.error ? '加载失败，请稍后重试' : '加载词表中…';
      return;
    }

    const terms = normalize(search.value).split(/\s+/).filter(Boolean);
    const matches = catalog.items.filter(({ searchText }) => terms.every((term) => searchText.includes(term)));
    const pageSize = Number(pageSizeSelect.value);
    const start = page * pageSize;
    const end = Math.min(start + pageSize, matches.length);

    for (const { item, detail } of matches.slice(start, end)) {
      const row = rows.insertRow();
      const nameCell = row.insertCell();
      nameCell.textContent = item.name_zh || item.name_en || item.id;
      const subtitle = el('small', '', detail);
      nameCell.appendChild(subtitle);

      const codeCell = row.insertCell();
      const codeBtn = el('button', 'api-code-copy', '');
      codeBtn.type = 'button';
      codeBtn.title = `点击复制 ${item.id}`;
      codeBtn.appendChild(el('code', '', item.id));
      codeBtn.onclick = () => copy(item.id, `已复制 ${item.id}`);
      codeCell.appendChild(codeBtn);

      const actions = row.insertCell();
      const fields = dictionary.value === 'nodes' ? ['from', 'to', 'avoid'] : ['avoid'];
      for (const field of fields) {
        const button = el('button', 'map-btn', field);
        button.type = 'button';
        button.setAttribute('aria-label', `将 ${item.id} 填入 ${field}`);
        if (field === 'avoid') {
          button.setAttribute('aria-pressed', String(state.route.avoid.includes(item.id)));
        } else {
          button.setAttribute('aria-pressed', String(state.route[field] === item.id));
        }
        button.onclick = () => {
          if (field === 'avoid') {
            const added = !state.route.avoid.includes(item.id);
            state.route.avoid = added
              ? [...state.route.avoid, item.id]
              : state.route.avoid.filter((id) => id !== item.id);
          } else {
            state.route[field] = item.id;
          }
          customBodyText = null;
          renderDictSelection();
          renderValues();
          renderRequestPreview();
          showStatus(`已填入 ${field}: ${item.id}`);
        };
        actions.appendChild(button);
      }
    }

    count.textContent = matches.length
      ? `第 ${start + 1}–${end} 项，共 ${matches.length.toLocaleString('zh-CN')} 项`
      : '没有匹配的词条';
    prev.disabled = page === 0;
    next.disabled = end >= matches.length;
    rows.closest('.api-table-wrap').scrollTop = 0;
  }

  async function loadCatalog() {
    const key = dictionary.value;
    if (catalogs.has(key)) {
      renderValues();
      return;
    }
    const catalog = {};
    catalogs.set(key, catalog);
    renderValues();
    try {
      const isNodes = key === 'nodes';
      const data = await fetchJson(isNodes ? '/v1/graph/nodes' : '/v1/chokepoints');
      const entries = isNodes
        ? data.nodes.filter((node) => !nodeGroups(node).includes('passage'))
        : data.chokepoints;
      catalog.items = entries.map((item) => {
        const groups = isNodes ? nodeGroups(item).map((group) => groupLabels[group].label) : [];
        const detail = [item.name_en, ...groups, item.country || item.region].filter(Boolean).join(' · ');
        return {
          item,
          detail,
          searchText: normalize([item.name_zh, item.id, item.code, detail, ...(item.aliases ?? [])].join(' ')),
        };
      }).sort((a, b) =>
        Number(Boolean(b.item.featured ?? b.item.major)) - Number(Boolean(a.item.featured ?? a.item.major))
        || (a.item.name_zh || a.item.id).localeCompare(b.item.name_zh || b.item.id, 'zh-CN')
      );
    } catch {
      catalog.error = true;
    }
    if (dictionary.value === key) renderValues();
  }

  function renderGuide() {
    const grid = get('api-guide-grid');
    grid.replaceChildren();

    API_CONVENTIONS.forEach((section, index) => {
      const card = el('article', 'api-guide-card');
      card.appendChild(el('h3', '', `${index + 1}. ${section.title}`));
      const list = el('ul');
      for (const item of section.items) {
        const li = el('li');
        li.appendChild(el('strong', '', item.label));
        li.appendChild(document.createTextNode('：'));
        appendInlineCode(li, item.text);
        list.appendChild(li);
      }
      card.appendChild(list);
      grid.appendChild(card);
    });

    const statusCard = el('article', 'api-guide-card api-guide-card-wide');
    statusCard.appendChild(el('h3', '', `${API_CONVENTIONS.length + 1}. HTTP 状态码与错误格式`));
    const desc = el('p', 'api-guide-desc');
    appendInlineCode(desc, `所有错误响应统一返回 \`${API_ERROR_FORMAT}\`。`);
    statusCard.appendChild(desc);

    const statusTableWrap = el('div');
    statusTableWrap.id = 'api-status-table';
    statusTableWrap.appendChild(
      buildTable(
        ['状态码', '含义', '说明'],
        API_STATUS_CODES.map((row) => [
          (td) => td.appendChild(el('code', '', row.code)),
          row.meaning,
          row.detail,
        ])
      )
    );
    statusCard.appendChild(statusTableWrap);
    grid.appendChild(statusCard);
  }

  function syncRouteFromPage() {
    const pagePayload = getRoutePayload();
    state.route = {
      ...pagePayload,
      from: pagePayload.from || 'CNSZX',
      to: pagePayload.to || 'NLAMS',
      avoid: Array.isArray(pagePayload.avoid) ? pagePayload.avoid : [],
    };
    customBodyText = null;
  }

  get('open-api-catalog').onclick = () => {
    baseUrlEl.textContent = location.origin;
    syncRouteFromPage();
    activeEndpointId = state.route.avoid.length ? 'compare' : 'routes';
    activeMethod = currentEndpoint().method;
    liveBox.hidden = true;
    lastResponseText = '';
    for (const [key, catalog] of catalogs) {
      if (catalog.error) catalogs.delete(key);
    }
    renderNav();
    renderEndpointDoc();
    setTab('docs');
    dialog.showModal();
  };

  for (const btn of dialog.querySelectorAll('[data-api-tab]')) {
    btn.onclick = () => setTab(btn.dataset.apiTab);
  }

  get('api-copy-base').onclick = () => copy(location.origin, '已复制 Base URL');
  get('api-jump-dict').onclick = () => {
    const ep = currentEndpoint();
    dictionary.value = ep.id === 'chokepoints' ? 'avoid' : 'nodes';
    page = 0;
    setTab('dict');
  };
  get('api-reset-example').onclick = () => {
    syncRouteFromPage();
    renderRequestPreview();
    renderDictSelection();
    showStatus('已同步当前页面参数');
  };

  payload.oninput = () => {
    customBodyText = payload.value;
  };

  const updateNodeSearch = () => {
    state.nodeSearch = {
      q: nsQ.value.trim(),
      type: nsType.value,
      endpoint: nsEndpoint.checked ? '1' : '',
      limit: nsLimit.value.trim(),
    };
    renderRequestPreview();
  };
  nsQ.oninput = updateNodeSearch;
  nsType.onchange = updateNodeSearch;
  nsEndpoint.onchange = updateNodeSearch;
  nsLimit.oninput = updateNodeSearch;

  tryBtn.onclick = runTryIt;
  copyJsonBtn.onclick = () => copy(currentSpec().bodyText, '已复制 JSON');
  copyCurlBtn.onclick = () => copy(currentSpec().curl, '已复制 cURL');
  get('api-copy-response').onclick = () => copy(lastResponseText, '已复制响应');
  get('api-clear-response').onclick = () => {
    liveBox.hidden = true;
    lastResponseText = '';
  };

  dictionary.onchange = () => {
    page = 0;
    search.value = '';
    loadCatalog();
  };
  search.oninput = () => {
    page = 0;
    renderValues();
  };
  pageSizeSelect.onchange = () => {
    page = 0;
    renderValues();
  };
  prev.onclick = () => {
    page--;
    renderValues();
  };
  next.onclick = () => {
    page++;
    renderValues();
  };

  renderGuide();
}
