const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function initApiCatalog({ fetchJson, getRoutePayload, nodeGroups, groupLabels }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('api-catalog');
  const dictionary = get('api-dictionary');
  const search = get('api-search');
  const rows = get('api-values');
  const count = get('api-result-count');
  const pageSizeSelect = get('api-page-size');
  const prev = get('api-prev');
  const next = get('api-next');
  const endpoint = get('api-endpoint');
  const payload = get('api-payload');
  const copyStatus = get('api-copy-status');
  const catalogs = new Map();
  let page = 0;
  let example;

  function renderExample() {
    const { from, to, avoid, ...options } = example;
    const precompute = endpoint.value === '/v1/precompute';
    const body = precompute
      ? { pairs: [{ from, to }], avoidScenarios: avoid.length ? [[], avoid] : [[]], ...options }
      : { from, to, ...options, avoid };
    payload.value = JSON.stringify(body, null, 2);
    payload.scrollTop = 0;
    copyStatus.textContent = '';
    for (const field of dialog.querySelectorAll('[data-api-route]')) field.hidden = precompute;
    for (const field of dialog.querySelectorAll('[data-api-precompute]')) field.hidden = !precompute;
  }

  function renderValues() {
    const catalog = catalogs.get(dictionary.value);
    rows.replaceChildren();
    prev.disabled = true;
    next.disabled = true;
    if (!catalog?.items) {
      count.textContent = catalog?.error ? '加载失败，请关闭词表后重试' : '加载词表中…';
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
      const subtitle = document.createElement('small');
      subtitle.textContent = detail;
      nameCell.appendChild(subtitle);
      const code = document.createElement('code');
      code.textContent = item.id;
      row.insertCell().appendChild(code);
      const actions = row.insertCell();
      const fields = dictionary.value === 'nodes' ? ['from', 'to'] : ['avoid'];
      for (const field of fields) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'map-btn';
        button.textContent = field;
        button.setAttribute('aria-label', `将 ${item.id} 填入 ${field}`);
        if (field === 'avoid') {
          button.setAttribute('aria-pressed', String(example.avoid.includes(item.id)));
        }
        button.onclick = () => {
          if (field === 'avoid') {
            const added = !example.avoid.includes(item.id);
            example.avoid = added ? [...example.avoid, item.id] : example.avoid.filter((id) => id !== item.id);
            button.setAttribute('aria-pressed', String(added));
          } else {
            example[field] = item.id;
          }
          renderExample();
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

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      copyStatus.textContent = '已复制';
    } catch {
      const original = payload.value;
      payload.value = value;
      payload.focus();
      payload.select();
      if (document.execCommand('copy')) {
        payload.value = original;
        copyStatus.textContent = '已复制';
      } else {
        copyStatus.textContent = '内容已选中，请手动复制';
      }
    }
  }

  get('open-api-catalog').onclick = () => {
    example = getRoutePayload();
    example.from ||= 'CNSZX';
    example.to ||= 'NLAMS';
    endpoint.selectedIndex = example.avoid.length ? 1 : 0;
    for (const [key, catalog] of catalogs) {
      if (catalog.error) catalogs.delete(key);
    }
    renderExample();
    dialog.showModal();
    loadCatalog();
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
  endpoint.onchange = renderExample;
  get('api-copy-json').onclick = () => {
    renderExample();
    copy(payload.value);
  };
  get('api-copy-curl').onclick = () => {
    renderExample();
    const url = new URL(endpoint.value, location.origin);
    copy(`curl -X POST ${shellQuote(url.href)} -H 'Content-Type: application/json' --data-raw ${shellQuote(payload.value)}`);
  };
}
