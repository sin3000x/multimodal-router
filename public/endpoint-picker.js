export function createEndpointPicker(input, { fetchJson, describe, submit }) {
  const field = input.closest('.endpoint-field');
  const dropdown = field.querySelector('.endpoint-dropdown');
  const list = field.querySelector('[role="listbox"]');
  const message = field.querySelector('.endpoint-message');
  const status = field.querySelector('.endpoint-status');
  let selected = null;
  let active = -1;
  let composing = false;
  let timer;
  let request;

  function close() {
    clearTimeout(timer);
    request?.abort();
    request = null;
    active = -1;
    list.replaceChildren();
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    status.textContent = '';
  }

  function show(text, announcement = text) {
    message.textContent = text;
    message.hidden = !text;
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', String(list.childElementCount > 0));
    status.textContent = announcement;
  }

  function setNode(node) {
    close();
    const label = describe(node).title;
    selected = { id: node.id, label };
    input.value = label;
  }

  function highlight(index) {
    list.children[active]?.setAttribute('aria-selected', 'false');
    active = index;
    const option = list.children[index];
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }

  async function search(query) {
    const controller = new AbortController();
    request = controller;
    show('正在搜索地点…');
    try {
      const params = new URLSearchParams({ q: query, endpoint: '1', limit: '8' });
      const { nodes } = await fetchJson(`/v1/nodes?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      for (const node of nodes) {
        const { title, detail } = describe(node);
        const option = document.createElement('div');
        option.id = `${list.id}-${list.childElementCount}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        const name = document.createElement('strong');
        name.textContent = title;
        const metadata = document.createElement('small');
        metadata.textContent = detail;
        option.append(name, metadata);
        option.onmousedown = (event) => event.preventDefault();
        option.onclick = () => setNode(node);
        list.append(option);
      }
      if (nodes.length) show('', `找到 ${nodes.length} 个候选地点`);
      else show('未找到地点，试试英文名或地点代码');
    } catch {
      if (!controller.signal.aborted) show('地点搜索失败，请重新输入重试');
    } finally {
      if (request === controller) request = null;
    }
  }

  function queueSearch() {
    close();
    const query = input.value.trim();
    if (!query || /^[+\-\d.]+\s*[,，]/.test(query)) return;
    timer = setTimeout(() => search(query), 160);
  }

  input.addEventListener('compositionstart', () => {
    composing = true;
    close();
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    selected = null;
    queueSearch();
  });
  input.addEventListener('input', (event) => {
    selected = null;
    if (!composing && !event.isComposing) queueSearch();
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (!dropdown.hidden) event.preventDefault();
      close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0) list.children[active].click();
      else submit();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const count = list.childElementCount;
      if (count) {
        event.preventDefault();
        const index = event.key === 'ArrowDown' ? (active + 1) % count : (active <= 0 ? count - 1 : active - 1);
        highlight(index);
      } else if (!selected && dropdown.hidden) {
        event.preventDefault();
        queueSearch();
      }
    }
  });

  return {
    close,
    setNode,
    get value() {
      return selected?.label === input.value ? selected.id : input.value.trim().normalize('NFKC');
    },
  };
}
