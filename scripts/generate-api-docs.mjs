import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  API_CONVENTIONS,
  API_ENDPOINTS,
  API_ERROR_FORMAT,
  API_GROUPS,
  API_STATUS_CODES,
  buildRequestSpec,
} from '../public/api-docs-data.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_PATH = join(ROOT_DIR, 'docs', 'API.md');

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

function renderMarkdownTable(headers, rows) {
  const head = `| ${headers.map(escapeCell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

export function renderApiMarkdown() {
  const lines = [];
  const sampleState = {
    route: {
      from: 'CNSZX',
      to: 'NLAMS',
      modes: ['sea', 'air', 'rail', 'road'],
      avoid: ['CP_SUEZ'],
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
  const baseRouteState = {
    ...sampleState,
    route: { ...sampleState.route, avoid: [] },
  };

  lines.push('<!-- AUTO-GENERATED from public/api-docs-data.js via `npm run docs:api`. Do not edit manually. -->');
  lines.push('');
  lines.push('# Multimodal Router HTTP API 文档');
  lines.push('');
  lines.push('> 本文档与前端「API 说明」弹窗共用同一数据源 [`public/api-docs-data.js`](../public/api-docs-data.js)，修改接口定义后请运行 `npm run docs:api` 同步更新。');
  lines.push('> 默认服务地址：`http://127.0.0.1:4180`（后台服务默认监听 `0.0.0.0:4180`）。');
  lines.push('');

  lines.push('## 接口总览');
  lines.push('');
  lines.push(
    renderMarkdownTable(
      ['分组', '方法', '路径', '名称', '说明'],
      API_ENDPOINTS.map((ep) => {
        const groupLabel = API_GROUPS.find((g) => g.id === ep.group)?.label ?? ep.group;
        return [groupLabel, `\`${ep.methods.join(' / ')}\``, `\`${ep.path}\``, ep.title, ep.summary];
      })
    )
  );
  lines.push('');

  lines.push('## 接入规范与通用约定');
  lines.push('');
  API_CONVENTIONS.forEach((section, idx) => {
    lines.push(`### ${idx + 1}. ${section.title}`);
    lines.push('');
    for (const item of section.items) {
      lines.push(`- **${item.label}**：${item.text}`);
    }
    lines.push('');
  });

  lines.push(`### ${API_CONVENTIONS.length + 1}. HTTP 状态码与错误格式`);
  lines.push('');
  lines.push(`所有错误响应统一返回 \`${API_ERROR_FORMAT}\`。`);
  lines.push('');
  lines.push(
    renderMarkdownTable(
      ['状态码', '含义', '说明'],
      API_STATUS_CODES.map((s) => [`\`${s.code}\``, s.meaning, s.detail])
    )
  );
  lines.push('');

  lines.push('## 接口明细');
  lines.push('');
  for (const group of API_GROUPS) {
    lines.push(`### ${group.label}`);
    lines.push('');
    const endpoints = API_ENDPOINTS.filter((ep) => ep.group === group.id);
    for (const ep of endpoints) {
      lines.push(`#### \`${ep.methods.join(' / ')} ${ep.path}\` · ${ep.title}`);
      lines.push('');
      lines.push(ep.summary);
      lines.push('');
      if (ep.note) {
        lines.push(`> **说明**：${ep.note}`);
        lines.push('');
      }

      lines.push('**请求参数**');
      lines.push('');
      if (!ep.params.length) {
        lines.push('无需请求参数。');
      } else {
        lines.push(
          renderMarkdownTable(
            ['参数名', '类型', '必填', '默认值', '说明'],
            ep.params.map((p) => [
              `\`${p.name}\``,
              `\`${p.type}\``,
              p.required ? '必填' : '可选',
              `\`${p.defaultValue}\``,
              p.desc,
            ])
          )
        );
      }
      lines.push('');

      lines.push('**请求示例**');
      lines.push('');
      const stateForEp = ep.id === 'routes' ? baseRouteState : sampleState;
      const primarySpec = buildRequestSpec(ep, stateForEp, 'http://127.0.0.1:4180', ep.method);
      if (primarySpec.bodyText) {
        lines.push('```json');
        lines.push(primarySpec.bodyText);
        lines.push('```');
        lines.push('');
      }
      lines.push('```bash');
      lines.push(primarySpec.curl);
      if (ep.methods.includes('GET') && ep.method !== 'GET') {
        const getSpec = buildRequestSpec(ep, stateForEp, 'http://127.0.0.1:4180', 'GET');
        lines.push('');
        lines.push(`# GET 等价调用`);
        lines.push(getSpec.curl);
      }
      lines.push('```');
      lines.push('');

      lines.push('**响应字段**');
      lines.push('');
      lines.push(
        renderMarkdownTable(
          ['字段', '类型', '说明'],
          ep.responseFields.map((f) => [`\`${f.name}\``, `\`${f.type}\``, f.desc])
        )
      );
      lines.push('');

      lines.push('**返回示例**');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(ep.responseSample, null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const markdown = renderApiMarkdown();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, markdown, 'utf8');
  console.log(`Generated ${OUTPUT_PATH} (${markdown.length} bytes)`);
}
