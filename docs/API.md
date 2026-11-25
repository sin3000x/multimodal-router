<!-- AUTO-GENERATED from public/api-docs-data.js via `npm run docs:api`. Do not edit manually. -->

# Multimodal Router HTTP API 文档

> 本文档与前端「API 说明」弹窗共用同一数据源 [`public/api-docs-data.js`](../public/api-docs-data.js)，修改接口定义后请运行 `npm run docs:api` 同步更新。
> 默认服务地址：`http://127.0.0.1:4180`（后台服务默认监听 `0.0.0.0:4180`）。

## 接口总览

| 分组 | 方法 | 路径 | 名称 | 说明 |
| --- | --- | --- | --- | --- |
| 核心计算 | `POST / GET` | `/v1/routes` | 路径计算 | 根据起终点、运输方式和避让条件，计算多式联运候选路径与时效/里程/成本指标。 |
| 核心计算 | `POST / GET` | `/v1/routes/compare` | 绕行对比 | 对比无阻断基线路径与指定咽喉/空域受阻后的绕行及陆路替代方案，量化时效与成本影响。 |
| 核心计算 | `POST` | `/v1/precompute` | 批量预热 | 批量计算指定 OD 对与避让场景组合并写入双层缓存（内存 LRU + SQLite）。 |
| 词表与图谱 | `GET` | `/v1/nodes` | 节点搜索 | 按中英文名称、UN/LOCODE、IATA 三字码、别名或港群前缀检索可路由节点。 |
| 词表与图谱 | `GET` | `/v1/chokepoints` | 咽喉与空域 | 获取全部规范海运咽喉与受控空域列表，以及预计算队列中的受影响线路统计。 |
| 词表与图谱 | `GET` | `/v1/graph/nodes` | 全量图谱节点 | 一次性返回图谱内所有带有效坐标的非国家节点及其枢纽/接入元数据，供节点图谱视图与本地词表检索使用。 |
| 词表与图谱 | `GET` | `/v1/graph/links` | 多式联运路网连线 | 返回图谱中的 MARNET 海运航段、陆铁走廊、全球公路网及航空航线连线数据，支持按 layers 参数按需拉取。 |
| 快照与运维 | `GET` | `/v1/snapshots/risk-radar` | Risk Radar 快照 | 导出与 supply-chain-risk-radar/network.mjs 兼容的静态风险雷达网络快照。 |
| 快照与运维 | `GET` | `/health` | 健康检查 | 返回服务存活状态、当前图谱版本、构建节点边统计、预计算快照信息与缓存命中率。 |

## 接入规范与通用约定

### 1. 基础接入约定

- **编码与格式**：所有接口请求与响应均使用 `UTF-8` 编码的 `application/json`。
- **跨域支持**：内置 `Access-Control-Allow-Origin: *`，支持 `GET`、`POST` 与 `OPTIONS` 预检。
- **请求体上限**：`POST` JSON Body 最大允许 `256 KB`，超出将返回 `413`。
- **双协议传参**：`/v1/routes` 与 `/v1/routes/compare` 同时支持 `POST JSON` 与 `GET Query`（数组参数以英文逗号拼接，如 `modes=sea,air`）。

### 2. 节点编码规范与解析优先级

- **标准编码**：城市与港口复用 5 位 `UN/LOCODE`（如 `CNSZX`、`NLRTM`），机场复用 3 位 `IATA`（如 `PVG`、`AMS`），咽喉/空域使用语义编码（如 `CP_SUEZ`、`AS_RUSSIA`）。
- **解析顺序**：精确 `id` → 历史旧 ID（`legacyIds`，如 `CITY_SZ` → `CNSZX`）→ 经纬度字符串（`"114.05,22.54"`）或对象（`{"lon":114.05,"lat":22.54}`）→ `code` → 中英文别名。
- **等价归一化**：不同别名（如 `"深圳"`、`"CITY_SZ"`、`"CNSZX"`）在服务端会被规范化为同一标准 ID 并共享同一缓存键。

### 3. 咽喉耦合与空域绕行规则

- **海运咽喉联动**：避让 `CP_SUEZ`（苏伊士运河）或 `CP_BAB`（曼德海峡）时，系统会自动联动阻断耦合航段，模拟经好望角（`CP_CAPE`）或港口陆桥接驳的真实绕行。
- **空域穿行与真实航网**：基于全球真实航线网（`airnet`）与全货机干线生成 0/1/2 次中转方案，默认常态避开乌克兰冲突空域；传入 `AS_RUSSIA` 或 `AS_MIDEAST` 时，优先尝试不落地空中走廊绕飞（如哈萨克—里海—黑海走廊、阿拉伯海—红海走廊）并保留经中东/东南亚/安克雷奇（`ANC`）技术经停或中转备选。
- **陆路连通、港口分级与跨国清关**：海运选港按 `portTier`（1/2/3 级）排序并用 `land-mask` + `roadnet` 过滤隔海短驳；跨国公路/短驳自动叠加边境清关耗时与成本（`borderPenalty`）；手工走廊未覆盖的同大陆 OD 由全球干线公路网 A* 自动绕行。
- **北极航线**：默认不启用北极通道，仅在显式允许时参与寻路。

### 4. 双层缓存与图谱版本

- **三级命中链**：L1 内存 LRU（默认上限 2,000 条）→ L2 SQLite 持久化（`var/route-cache.sqlite`）→ Single-Flight 并发去重。
- **响应元信息**：`meta.cache` 返回 `hit`、`layer`（`memory` / `sqlite` / `inflight` / `miss`）与 `key`。
- **版本隔离**：所有缓存键绑定编译指纹 `graphVersion`，图谱重新构建后自动失效旧缓存，无需手动清理。

### 5. HTTP 状态码与错误格式

所有错误响应统一返回 `{"error": "错误说明"}`。

| 状态码 | 含义 | 说明 |
| --- | --- | --- |
| `200 OK` | 请求成功 | 返回 JSON 响应体。 |
| `204 No Content` | CORS 预检通过 | OPTIONS 预检请求响应，允许跨域调用。 |
| `400 Bad Request` | 参数无效或 JSON 解析失败 | 例如缺少 from / to、未知节点 ID 或请求体非合法 JSON。 |
| `403 Forbidden` | 静态路径越权 | 静态资源请求路径超出 public 目录范围。 |
| `404 Not Found` | 接口或快照不存在 | 未知路由，或未运行 npm run precompute 时访问 /v1/snapshots/risk-radar。 |
| `413 Payload Too Large` | 请求体过大 | POST JSON 请求体超过 256 KB 上限。 |
| `500 Internal Error` | 服务端异常 | 未捕获的内部计算或读写错误。 |

## 接口明细

### 核心计算

#### `POST / GET /v1/routes` · 路径计算

根据起终点、运输方式和避让条件，计算多式联运候选路径与时效/里程/成本指标。

> **说明**：同时支持 POST（JSON Body）与 GET（Query 参数，数组使用英文逗号分隔，如 modes=sea,air&avoid=CP_SUEZ）。

**请求参数**

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `from` | `string \| object` | 必填 | `—` | 起运地节点。优先使用词表标准 ID（如 CNSZX、PVG），也支持中英文别名、旧 ID（如 CITY_SZ）或坐标（"114.05,22.54" / {"lon":114.05,"lat":22.54}）。 |
| `to` | `string \| object` | 必填 | `—` | 目的地节点，解析规则同 from（如 NLAMS、AEDXB）。 |
| `modes` | `string[] \| string` | 可选 | `["sea","air","rail","road"]` | 启用的运输方式。可选值：sea（海运）、air（空运）、rail（铁路）、road（公路）；GET 请求可用英文逗号分隔。 |
| `avoid` | `string[] \| string` | 可选 | `[]` | 需避让的咽喉或空域 ID 列表（如 ["CP_SUEZ"]、["AS_RUSSIA"]）；GET 请求可用英文逗号分隔。 |
| `maxRoutes` | `number` | 可选 | `8` | 返回路径数量上限，有效范围 1–24（各运输方式轮询交叉选取以保留多样性）。 |
| `includeGeometry` | `boolean` | 可选 | `false` | 是否在分段 legs 中返回完整经纬度折线坐标数组 geometry（用于地图渲染，开启会增加响应体积）。 |

**请求示例**

```json
{
  "from": "CNSZX",
  "to": "NLAMS",
  "modes": [
    "sea",
    "air",
    "rail",
    "road"
  ],
  "avoid": [],
  "maxRoutes": 8,
  "includeGeometry": false
}
```

```bash
curl -X POST 'http://127.0.0.1:4180/v1/routes' -H 'Content-Type: application/json' --data-raw '{
  "from": "CNSZX",
  "to": "NLAMS",
  "modes": [
    "sea",
    "air",
    "rail",
    "road"
  ],
  "avoid": [],
  "maxRoutes": 8,
  "includeGeometry": false
}'

# GET 等价调用
curl 'http://127.0.0.1:4180/v1/routes?from=CNSZX&to=NLAMS&modes=sea%2Cair%2Crail%2Croad&maxRoutes=8&includeGeometry=false'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `graphVersion` | `string` | 当前编译图谱的确定性 SHA-256 指纹版本。 |
| `origin / destination` | `object` | 归一化后的起终点信息（含 id、type、code、codeStandard、name_zh、name_en、lon、lat）。 |
| `straightLineKm` | `number` | 起终点间大圆直线距离（公里）。 |
| `avoid` | `string[]` | 本次生效的避让咽喉/空域 ID 列表。 |
| `countsByMode` | `object` | 各运输方式（sea、air、rail、road、local）命中的候选路径总数。 |
| `routes[]` | `object[]` | 候选路径列表，每条含 routeId、mode、modeLabel、likelihood、originGateway、destGateway、可选 viaHub / detourReason、chokepoints[]、nodeSequence[]、waypoints[]、legs[]（各分段含独立 leg.mode 供地图按分段着色）、metrics、signature。 |
| `meta.cache` | `object` | 缓存命中信息：hit（布尔）、layer（memory / sqlite / inflight / miss）、key（SHA-256 缓存键）。 |

**返回示例**

```json
{
  "graphVersion": "9f3c...",
  "origin": {
    "id": "CNSZX",
    "type": "city",
    "code": "CNSZX",
    "codeStandard": "UN/LOCODE",
    "name_zh": "深圳",
    "name_en": "Shenzhen",
    "lon": 114.0579,
    "lat": 22.5431
  },
  "destination": {
    "id": "NLAMS",
    "type": "city",
    "code": "NLAMS",
    "codeStandard": "UN/LOCODE",
    "name_zh": "阿姆斯特丹",
    "name_en": "Amsterdam",
    "lon": 4.9041,
    "lat": 52.3676
  },
  "straightLineKm": 9162.4,
  "avoid": [],
  "countsByMode": {
    "sea": 2,
    "air": 2,
    "rail": 2,
    "road": 0,
    "local": 0
  },
  "routes": [
    {
      "routeId": "CNSZX>NLAMS|sea|1",
      "mode": "sea",
      "modeLabel": "海运",
      "likelihood": "primary",
      "originGateway": {
        "id": "CNYTN",
        "name": "盐田港",
        "code": "CNYTN"
      },
      "destGateway": {
        "id": "NLRTM",
        "name": "鹿特丹港",
        "code": "NLRTM"
      },
      "chokepoints": [
        {
          "id": "CP_MALACCA",
          "name_zh": "马六甲海峡",
          "name_en": "Malacca Strait",
          "major": true
        }
      ],
      "metrics": {
        "distanceKm": 18520.4,
        "transitDays": 31.2,
        "costIndex": 1
      }
    }
  ],
  "meta": {
    "cache": {
      "hit": true,
      "layer": "memory",
      "key": "e7a1..."
    }
  }
}
```

#### `POST / GET /v1/routes/compare` · 绕行对比

对比无阻断基线路径与指定咽喉/空域受阻后的绕行及陆路替代方案，量化时效与成本影响。

> **说明**：避让 CP_SUEZ / CP_BAB 会自动联动耦合通道；避让 AS_RUSSIA / AS_MIDEAST 会触发空运绕飞检测。基线与绕行组内部各自计算最多 12 条路径后再按 maxRoutes 截断。

**请求参数**

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `from` | `string \| object` | 必填 | `—` | 起运地节点。优先使用词表标准 ID（如 CNSZX、PVG），也支持中英文别名、旧 ID（如 CITY_SZ）或坐标（"114.05,22.54" / {"lon":114.05,"lat":22.54}）。 |
| `to` | `string \| object` | 必填 | `—` | 目的地节点，解析规则同 from（如 NLAMS、AEDXB）。 |
| `modes` | `string[] \| string` | 可选 | `["sea","air","rail","road"]` | 启用的运输方式。可选值：sea（海运）、air（空运）、rail（铁路）、road（公路）；GET 请求可用英文逗号分隔。 |
| `avoid` | `string[] \| string` | 可选 | `[]` | 受阻或需避让的咽喉/空域 ID 列表（如 ["CP_SUEZ"]）。基线组固定按空列表计算，绕行组按此列表计算。 |
| `maxRoutes` | `number` | 可选 | `8` | 返回路径数量上限，有效范围 1–24（各运输方式轮询交叉选取以保留多样性）。 |
| `includeGeometry` | `boolean` | 可选 | `false` | 是否在分段 legs 中返回完整经纬度折线坐标数组 geometry（用于地图渲染，开启会增加响应体积）。 |

**请求示例**

```json
{
  "from": "CNSZX",
  "to": "NLAMS",
  "modes": [
    "sea",
    "air",
    "rail",
    "road"
  ],
  "avoid": [
    "CP_SUEZ"
  ],
  "maxRoutes": 8,
  "includeGeometry": false
}
```

```bash
curl -X POST 'http://127.0.0.1:4180/v1/routes/compare' -H 'Content-Type: application/json' --data-raw '{
  "from": "CNSZX",
  "to": "NLAMS",
  "modes": [
    "sea",
    "air",
    "rail",
    "road"
  ],
  "avoid": [
    "CP_SUEZ"
  ],
  "maxRoutes": 8,
  "includeGeometry": false
}'

# GET 等价调用
curl 'http://127.0.0.1:4180/v1/routes/compare?from=CNSZX&to=NLAMS&modes=sea%2Cair%2Crail%2Croad&avoid=CP_SUEZ&maxRoutes=8&includeGeometry=false'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `graphVersion` | `string` | 当前图谱版本。 |
| `origin / destination` | `object` | 归一化后的起终点对象。 |
| `avoid` | `string[]` | 去重后的受阻咽喉/空域 ID 列表。 |
| `baseline[]` | `object[]` | 无阻断情况下的基线路径列表（按 maxRoutes 截断）。 |
| `affected[]` | `object[]` | 基线路径中经由受阻咽喉/空域（含耦合通道）的受影响路径。 |
| `alternatives[]` | `object[]` | 绕行后的海运/空运备选方案，附加 deltaDays（天数变化）与 costMultiplier（成本倍率）。 |
| `landSubstitutions[]` | `object[]` | 铁路/公路等陆路替代方案，同样附加 deltaDays 与 costMultiplier。 |
| `impactSummary` | `object` | 影响汇总：affectedBaselineRoutes、totalBaselineRoutes、seaCutOff、seaDetoured、survivingSeaCount、bestAlternativeDays、bestLandDays。 |
| `meta.cache` | `object` | 缓存命中信息。 |

**返回示例**

```json
{
  "graphVersion": "9f3c...",
  "avoid": [
    "CP_SUEZ"
  ],
  "baseline": [
    {
      "routeId": "CNSZX>NLAMS|sea|1",
      "mode": "sea",
      "metrics": {
        "distanceKm": 18520.4,
        "transitDays": 31.2,
        "costIndex": 1
      }
    }
  ],
  "affected": [
    {
      "routeId": "CNSZX>NLAMS|sea|1",
      "mode": "sea"
    }
  ],
  "alternatives": [
    {
      "routeId": "CNSZX>NLAMS|sea|1",
      "mode": "sea",
      "deltaDays": 7.4,
      "costMultiplier": 1.24
    }
  ],
  "landSubstitutions": [
    {
      "routeId": "CNSZX>NLAMS|rail|2",
      "mode": "rail",
      "deltaDays": -11.2,
      "costMultiplier": 2.35
    }
  ],
  "impactSummary": {
    "affectedBaselineRoutes": 1,
    "totalBaselineRoutes": 6,
    "seaCutOff": false,
    "seaDetoured": true,
    "survivingSeaCount": 1,
    "bestAlternativeDays": 38.6,
    "bestLandDays": 20
  },
  "meta": {
    "cache": {
      "hit": false,
      "layer": "miss",
      "key": "a41d..."
    }
  }
}
```

#### `POST /v1/precompute` · 批量预热

批量计算指定 OD 对与避让场景组合并写入双层缓存（内存 LRU + SQLite）。

> **说明**：pairs 省略或为空数组时会触发全部 87 条预置 OD 队列预热；在线试调建议仅传入单组 pairs 以免耗时过长。

**请求参数**

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `pairs` | `Array<{from, to, modes?, avoid?}>` | 可选 | `预置 87 条 OD` | 起终点对数组。每项可单独覆盖全局的 modes 与 avoid。 |
| `avoidScenarios` | `string[][]` | 可选 | `[[]]` | 避让场景列表，每项为一组咽喉/空域 ID，将与 pairs 做笛卡尔积预热。 |
| `modes` | `string[]` | 可选 | `["sea","air","rail","road"]` | 默认启用的运输方式数组（当单条 pair 未指定 modes 时生效）。 |
| `maxRoutes` | `number` | 可选 | `8` | 每组场景计算的路径上限，范围 1–24。 |
| `includeGeometry` | `boolean` | 可选 | `true` | 预热缓存时是否一并保存几何坐标（此接口默认 true）。 |

**请求示例**

```json
{
  "pairs": [
    {
      "from": "CNSZX",
      "to": "NLAMS"
    }
  ],
  "avoidScenarios": [
    [],
    [
      "CP_SUEZ"
    ]
  ],
  "modes": [
    "sea",
    "air",
    "rail",
    "road"
  ],
  "maxRoutes": 8,
  "includeGeometry": false
}
```

```bash
curl -X POST 'http://127.0.0.1:4180/v1/precompute' -H 'Content-Type: application/json' --data-raw '{
  "pairs": [
    {
      "from": "CNSZX",
      "to": "NLAMS"
    }
  ],
  "avoidScenarios": [
    [],
    [
      "CP_SUEZ"
    ]
  ],
  "modes": [
    "sea",
    "air",
    "rail",
    "road"
  ],
  "maxRoutes": 8,
  "includeGeometry": false
}'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | `boolean` | 是否执行成功。 |
| `graphVersion` | `string` | 当前图谱版本。 |
| `warmed` | `number` | 本次新计算并写入缓存的组合数。 |
| `cacheHits` | `number` | 本次直接命中已有缓存的组合数。 |
| `cache` | `object` | 当前缓存统计信息（含 memorySize、sqliteEntries、hits/misses 等）。 |

**返回示例**

```json
{
  "ok": true,
  "graphVersion": "9f3c...",
  "warmed": 2,
  "cacheHits": 0,
  "cache": {
    "memorySize": 12,
    "sqliteEntries": 440,
    "memoryHits": 5,
    "sqliteHits": 2,
    "misses": 2
  }
}
```

### 词表与图谱

#### `GET /v1/nodes` · 节点搜索

按中英文名称、UN/LOCODE、IATA 三字码、别名或港群前缀检索可路由节点。

> **说明**：传入 endpoint=1 时会自动排除咽喉/空域等通道节点，并优先返回起终点友好的中文展示名。

**请求参数**

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `q` | `string` | 可选 | `""` | 搜索关键词（如 深圳、Rotterdam、CNSZX、PVG）。留空则返回精选节点。 |
| `type` | `string` | 可选 | `""` | 节点类型过滤：city、port、airport、rail_hub、rail_border、chokepoint、airspace、sea_area。 |
| `endpoint` | `string` | 可选 | `""` | 传 "1" 时仅返回适合作为起终点的节点（过滤咽喉/空域并启用港群匹配）。 |
| `limit` | `number` | 可选 | `20` | 返回条数上限，范围 1–100。 |

**请求示例**

```bash
curl 'http://127.0.0.1:4180/v1/nodes?q=%E6%B7%B1%E5%9C%B3&endpoint=1&limit=10'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `graphVersion` | `string` | 当前图谱版本。 |
| `nodes[]` | `object[]` | 匹配节点数组，含 id、type、functions[]、code、codeStandard、name_zh、name_en、country、lon、lat、curated。 |

**返回示例**

```json
{
  "graphVersion": "9f3c...",
  "nodes": [
    {
      "id": "CNSZX",
      "type": "city",
      "functions": [
        "city"
      ],
      "code": "CNSZX",
      "codeStandard": "UN/LOCODE",
      "name_zh": "深圳",
      "name_en": "Shenzhen",
      "country": "CN",
      "lon": 114.0579,
      "lat": 22.5431,
      "curated": true
    }
  ]
}
```

#### `GET /v1/chokepoints` · 咽喉与空域

获取全部规范海运咽喉与受控空域列表，以及预计算队列中的受影响线路统计。

**请求参数**

无需请求参数。

**请求示例**

```bash
curl 'http://127.0.0.1:4180/v1/chokepoints'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `graphVersion` | `string` | 当前图谱版本。 |
| `chokepoints[]` | `object[]` | 咽喉/空域列表，含 id、type、name_zh、name_en、lon、lat、major、region、affectedLaneCount、mustExposeLaneCount、totalPaths。 |

**返回示例**

```json
{
  "graphVersion": "9f3c...",
  "chokepoints": [
    {
      "id": "CP_SUEZ",
      "type": "chokepoint",
      "name_zh": "苏伊士运河",
      "name_en": "Suez Canal",
      "lon": 32.34,
      "lat": 30.58,
      "major": true,
      "region": "Red Sea / Egypt",
      "affectedLaneCount": 28,
      "mustExposeLaneCount": 19,
      "totalPaths": 32
    }
  ]
}
```

#### `GET /v1/graph/nodes` · 全量图谱节点

一次性返回图谱内所有带有效坐标的非国家节点及其枢纽/接入元数据，供节点图谱视图与本地词表检索使用。

**请求参数**

无需请求参数。

**请求示例**

```bash
curl 'http://127.0.0.1:4180/v1/graph/nodes'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `graphVersion` | `string` | 当前图谱版本。 |
| `nodes[]` | `object[]` | 节点数组，含 id、code、codeStandard、type、functions[]、name_zh、name_en、country、region、lon、lat、aliases[]、featured、portTier、airportSize、routeCount、isHub、major、hasMarnet、hasRoadnet、landDegree、affectedLaneCount、boxes 等字段。 |

**返回示例**

```json
{
  "graphVersion": "9f3c...",
  "nodes": [
    {
      "id": "NLRTM",
      "code": "NLRTM",
      "codeStandard": "UN/LOCODE",
      "type": "port",
      "functions": [
        "port",
        "city"
      ],
      "name_zh": "鹿特丹港",
      "name_en": "Rotterdam",
      "country": "NL",
      "region": "europe",
      "lon": 4.4777,
      "lat": 51.9244,
      "aliases": [
        "Rotterdam"
      ],
      "featured": true,
      "portTier": 1,
      "hasMarnet": true,
      "hasRoadnet": true,
      "landDegree": 0
    }
  ]
}
```

#### `GET /v1/graph/links` · 多式联运路网连线

返回图谱中的 MARNET 海运航段、陆铁走廊、全球公路网及航空航线连线数据，支持按 layers 参数按需拉取。

> **说明**：不传 layers 时默认返回 sea 与 land；全量路网体积较大，建议按图层按需请求并按 graphVersion 做本地缓存。

**请求参数**

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `layers` | `string` | 可选 | `undefined` | 逗号分隔的图层列表，支持 sea、land、road、air。 |

**请求示例**

```bash
curl 'http://127.0.0.1:4180/v1/graph/links'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `graphVersion` | `string` | 当前图谱版本。 |
| `counts` | `object` | 各图层总边数：{ sea, land, road, air }。 |
| `sea[]` | `object[]` | 海运航段数组，每项为 { mode: "sea", coords: [[lon, lat], ...] }。 |
| `land[]` | `object[]` | 陆铁连线数组，每项为 { mode, from, to, corridor, distanceKm, coords: [[lon, lat], ...] }。 |
| `road[]` | `object[]` | 全球公路网边数组，每项为 { mode: "road", coords: [[lon, lat], ...] }。 |
| `air[]` | `array[]` | 航空航线紧凑元组数组，每项为 [fromIata, toIata, freq, crossesRussia]。 |

**返回示例**

```json
{
  "graphVersion": "9f3c...",
  "counts": {
    "sea": 12954,
    "land": 83,
    "road": 27368,
    "air": 28323
  },
  "sea": [
    {
      "mode": "sea",
      "coords": [
        [
          114.27,
          22.57
        ],
        [
          114.4,
          22.1
        ]
      ]
    }
  ],
  "land": [
    {
      "mode": "rail",
      "from": "RAIL_SOUTHCHINA",
      "to": "CNALA",
      "corridor": "中欧班列西通道",
      "distanceKm": 4120,
      "coords": [
        [
          114.05,
          22.54
        ],
        [
          82.58,
          45.18
        ]
      ]
    }
  ]
}
```

### 快照与运维

#### `GET /v1/snapshots/risk-radar` · Risk Radar 快照

导出与 supply-chain-risk-radar/network.mjs 兼容的静态风险雷达网络快照。

> **说明**：需先执行 npm run precompute 生成 data/compiled/precomputed.json，否则返回 404。

**请求参数**

无需请求参数。

**请求示例**

```bash
curl 'http://127.0.0.1:4180/v1/snapshots/risk-radar'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `nodes[]` | `object[]` | 风险雷达兼容节点清单。 |
| `lanes[]` | `object[]` | 87 条重点线路 OD 的多方式备选路径及经由咽喉信息。 |
| `meta` | `object` | 快照生成时间、图谱版本与统计元数据。 |

**返回示例**

```json
{
  "nodes": [
    {
      "id": "CNSZX",
      "name_zh": "深圳",
      "type": "city"
    }
  ],
  "lanes": [
    {
      "lane_id": "CNSZX-NLAMS",
      "origin": "CNSZX",
      "destination": "NLAMS",
      "modes": {}
    }
  ],
  "meta": {
    "graphVersion": "9f3c...",
    "laneCount": 87
  }
}
```

#### `GET /health` · 健康检查

返回服务存活状态、当前图谱版本、构建节点边统计、预计算快照信息与缓存命中率。

**请求参数**

无需请求参数。

**请求示例**

```bash
curl 'http://127.0.0.1:4180/health'
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | `boolean` | 服务是否正常就绪。 |
| `service` | `string` | 服务标识（"multimodal-router"）。 |
| `graphVersion` | `string` | 当前加载的图谱 SHA-256 版本。 |
| `builtAt` | `string \| null` | 图谱最近编译时间（ISO 8601）。 |
| `counts` | `object \| null` | 节点、海运边、全球干线公路边（roadnetEdges）、航线边（airnetEdges）、陆铁走廊边（landEdges）等图谱规模统计。 |
| `precomputed` | `object \| null` | 预计算快照概览（laneCount、generatedAt）。 |
| `cache` | `object` | L1 内存与 L2 SQLite 缓存条目数及命中计数。 |

**返回示例**

```json
{
  "ok": true,
  "service": "multimodal-router",
  "graphVersion": "2b415c91c971",
  "builtAt": "2026-11-25T06:45:48.747Z",
  "counts": {
    "nodesTotal": 6801,
    "marnetVertices": 6704,
    "marnetEdges": 12954,
    "roadnetVertices": 20045,
    "roadnetEdges": 27368,
    "airnetEdges": 28323,
    "landEdges": 83
  },
  "precomputed": {
    "laneCount": 87,
    "generatedAt": "2026-11-25T06:45:55.029Z"
  },
  "cache": {
    "memorySize": 0,
    "sqliteEntries": 1218,
    "memoryHits": 0,
    "sqliteHits": 0,
    "misses": 0
  }
}
```
