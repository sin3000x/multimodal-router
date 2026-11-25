export const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

export const API_GROUPS = [
  { id: 'core', label: '核心计算' },
  { id: 'catalog', label: '词表与图谱' },
  { id: 'ops', label: '快照与运维' },
];

const ROUTE_COMMON_PARAMS = [
  {
    name: 'from',
    type: 'string | object',
    required: true,
    defaultValue: '—',
    desc: '起运地节点。优先使用词表标准 ID（如 CNSZX、PVG），也支持中英文别名、旧 ID（如 CITY_SZ）或坐标（"114.05,22.54" / {"lon":114.05,"lat":22.54}）。',
  },
  {
    name: 'to',
    type: 'string | object',
    required: true,
    defaultValue: '—',
    desc: '目的地节点，解析规则同 from（如 NLAMS、AEDXB）。',
  },
  {
    name: 'modes',
    type: 'string[] | string',
    required: false,
    defaultValue: '["sea","air","rail","road"]',
    desc: '启用的运输方式。可选值：sea（海运）、air（空运）、rail（铁路）、road（公路）；GET 请求可用英文逗号分隔。',
  },
  {
    name: 'avoid',
    type: 'string[] | string',
    required: false,
    defaultValue: '[]',
    desc: '需避让的咽喉或空域 ID 列表（如 ["CP_SUEZ"]、["AS_RUSSIA"]）；GET 请求可用英文逗号分隔。',
  },
  {
    name: 'maxRoutes',
    type: 'number',
    required: false,
    defaultValue: '8',
    desc: '返回路径数量上限，有效范围 1–24（各运输方式轮询交叉选取以保留多样性）。',
  },
  {
    name: 'includeGeometry',
    type: 'boolean',
    required: false,
    defaultValue: 'false',
    desc: '是否在分段 legs 中返回完整经纬度折线坐标数组 geometry（用于地图渲染，开启会增加响应体积）。',
  },
];

export const API_ENDPOINTS = [
  {
    id: 'routes',
    group: 'core',
    method: 'POST',
    methods: ['POST', 'GET'],
    path: '/v1/routes',
    title: '路径计算',
    summary: '根据起终点、运输方式和避让条件，计算多式联运候选路径与时效/里程/成本指标。',
    note: '同时支持 POST（JSON Body）与 GET（Query 参数，数组使用英文逗号分隔，如 modes=sea,air&avoid=CP_SUEZ）。',
    params: ROUTE_COMMON_PARAMS,
    responseFields: [
      { name: 'graphVersion', type: 'string', desc: '当前编译图谱的确定性 SHA-256 指纹版本。' },
      { name: 'origin / destination', type: 'object', desc: '归一化后的起终点信息（含 id、type、code、codeStandard、name_zh、name_en、lon、lat）。' },
      { name: 'straightLineKm', type: 'number', desc: '起终点间大圆直线距离（公里）。' },
      { name: 'avoid', type: 'string[]', desc: '本次生效的避让咽喉/空域 ID 列表。' },
      { name: 'countsByMode', type: 'object', desc: '各运输方式（sea、air、rail、road、local）命中的候选路径总数。' },
      { name: 'routes[]', type: 'object[]', desc: '候选路径列表，每条含 routeId、mode、modeLabel、likelihood、originGateway、destGateway、可选 viaHub / detourReason、chokepoints[]、nodeSequence[]、waypoints[]、legs[]（各分段含独立 leg.mode 供地图按分段着色）、metrics、signature。' },
      { name: 'meta.cache', type: 'object', desc: '缓存命中信息：hit（布尔）、layer（memory / sqlite / inflight / miss）、key（SHA-256 缓存键）。' },
    ],
    responseSample: {
      graphVersion: '9f3c...',
      origin: { id: 'CNSZX', type: 'city', code: 'CNSZX', codeStandard: 'UN/LOCODE', name_zh: '深圳', name_en: 'Shenzhen', lon: 114.0579, lat: 22.5431 },
      destination: { id: 'NLAMS', type: 'city', code: 'NLAMS', codeStandard: 'UN/LOCODE', name_zh: '阿姆斯特丹', name_en: 'Amsterdam', lon: 4.9041, lat: 52.3676 },
      straightLineKm: 9162.4,
      avoid: [],
      countsByMode: { sea: 2, air: 2, rail: 2, road: 0, local: 0 },
      routes: [
        {
          routeId: 'CNSZX>NLAMS|sea|1',
          mode: 'sea',
          modeLabel: '海运',
          likelihood: 'primary',
          originGateway: { id: 'CNYTN', name: '盐田港', code: 'CNYTN' },
          destGateway: { id: 'NLRTM', name: '鹿特丹港', code: 'NLRTM' },
          chokepoints: [{ id: 'CP_MALACCA', name_zh: '马六甲海峡', name_en: 'Malacca Strait', major: true }],
          metrics: { distanceKm: 18520.4, transitDays: 31.2, costIndex: 1.0 },
        },
      ],
      meta: { cache: { hit: true, layer: 'memory', key: 'e7a1...' } },
    },
  },
  {
    id: 'compare',
    group: 'core',
    method: 'POST',
    methods: ['POST', 'GET'],
    path: '/v1/routes/compare',
    title: '绕行对比',
    summary: '对比无阻断基线路径与指定咽喉/空域受阻后的绕行及陆路替代方案，量化时效与成本影响。',
    note: '避让 CP_SUEZ / CP_BAB 会自动联动耦合通道；避让 AS_RUSSIA / AS_MIDEAST 会触发空运绕飞检测。基线与绕行组内部各自计算最多 12 条路径后再按 maxRoutes 截断。',
    params: [
      ...ROUTE_COMMON_PARAMS.slice(0, 3),
      {
        name: 'avoid',
        type: 'string[] | string',
        required: false,
        defaultValue: '[]',
        desc: '受阻或需避让的咽喉/空域 ID 列表（如 ["CP_SUEZ"]）。基线组固定按空列表计算，绕行组按此列表计算。',
      },
      ...ROUTE_COMMON_PARAMS.slice(4),
    ],
    responseFields: [
      { name: 'graphVersion', type: 'string', desc: '当前图谱版本。' },
      { name: 'origin / destination', type: 'object', desc: '归一化后的起终点对象。' },
      { name: 'avoid', type: 'string[]', desc: '去重后的受阻咽喉/空域 ID 列表。' },
      { name: 'baseline[]', type: 'object[]', desc: '无阻断情况下的基线路径列表（按 maxRoutes 截断）。' },
      { name: 'affected[]', type: 'object[]', desc: '基线路径中经由受阻咽喉/空域（含耦合通道）的受影响路径。' },
      { name: 'alternatives[]', type: 'object[]', desc: '绕行后的海运/空运备选方案，附加 deltaDays（天数变化）与 costMultiplier（成本倍率）。' },
      { name: 'landSubstitutions[]', type: 'object[]', desc: '铁路/公路等陆路替代方案，同样附加 deltaDays 与 costMultiplier。' },
      { name: 'impactSummary', type: 'object', desc: '影响汇总：affectedBaselineRoutes、totalBaselineRoutes、seaCutOff、seaDetoured、survivingSeaCount、bestAlternativeDays、bestLandDays。' },
      { name: 'meta.cache', type: 'object', desc: '缓存命中信息。' },
    ],
    responseSample: {
      graphVersion: '9f3c...',
      avoid: ['CP_SUEZ'],
      baseline: [{ routeId: 'CNSZX>NLAMS|sea|1', mode: 'sea', metrics: { distanceKm: 18520.4, transitDays: 31.2, costIndex: 1.0 } }],
      affected: [{ routeId: 'CNSZX>NLAMS|sea|1', mode: 'sea' }],
      alternatives: [{ routeId: 'CNSZX>NLAMS|sea|1', mode: 'sea', deltaDays: 7.4, costMultiplier: 1.24 }],
      landSubstitutions: [{ routeId: 'CNSZX>NLAMS|rail|2', mode: 'rail', deltaDays: -11.2, costMultiplier: 2.35 }],
      impactSummary: {
        affectedBaselineRoutes: 1,
        totalBaselineRoutes: 6,
        seaCutOff: false,
        seaDetoured: true,
        survivingSeaCount: 1,
        bestAlternativeDays: 38.6,
        bestLandDays: 20.0,
      },
      meta: { cache: { hit: false, layer: 'miss', key: 'a41d...' } },
    },
  },
  {
    id: 'precompute',
    group: 'core',
    method: 'POST',
    methods: ['POST'],
    path: '/v1/precompute',
    title: '批量预热',
    summary: '批量计算指定 OD 对与避让场景组合并写入双层缓存（内存 LRU + SQLite）。',
    note: 'pairs 省略或为空数组时会触发全部 87 条预置 OD 队列预热；在线试调建议仅传入单组 pairs 以免耗时过长。',
    params: [
      {
        name: 'pairs',
        type: 'Array<{from, to, modes?, avoid?}>',
        required: false,
        defaultValue: '预置 87 条 OD',
        desc: '起终点对数组。每项可单独覆盖全局的 modes 与 avoid。',
      },
      {
        name: 'avoidScenarios',
        type: 'string[][]',
        required: false,
        defaultValue: '[[]]',
        desc: '避让场景列表，每项为一组咽喉/空域 ID，将与 pairs 做笛卡尔积预热。',
      },
      {
        name: 'modes',
        type: 'string[]',
        required: false,
        defaultValue: '["sea","air","rail","road"]',
        desc: '默认启用的运输方式数组（当单条 pair 未指定 modes 时生效）。',
      },
      {
        name: 'maxRoutes',
        type: 'number',
        required: false,
        defaultValue: '8',
        desc: '每组场景计算的路径上限，范围 1–24。',
      },
      {
        name: 'includeGeometry',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        desc: '预热缓存时是否一并保存几何坐标（此接口默认 true）。',
      },
    ],
    responseFields: [
      { name: 'ok', type: 'boolean', desc: '是否执行成功。' },
      { name: 'graphVersion', type: 'string', desc: '当前图谱版本。' },
      { name: 'warmed', type: 'number', desc: '本次新计算并写入缓存的组合数。' },
      { name: 'cacheHits', type: 'number', desc: '本次直接命中已有缓存的组合数。' },
      { name: 'cache', type: 'object', desc: '当前缓存统计信息（含 memorySize、sqliteEntries、hits/misses 等）。' },
    ],
    responseSample: {
      ok: true,
      graphVersion: '9f3c...',
      warmed: 2,
      cacheHits: 0,
      cache: { memorySize: 12, sqliteEntries: 440, memoryHits: 5, sqliteHits: 2, misses: 2 },
    },
  },
  {
    id: 'nodes',
    group: 'catalog',
    method: 'GET',
    methods: ['GET'],
    path: '/v1/nodes',
    title: '节点搜索',
    summary: '按中英文名称、UN/LOCODE、IATA 三字码、别名或港群前缀检索可路由节点。',
    note: '传入 endpoint=1 时会自动排除咽喉/空域等通道节点，并优先返回起终点友好的中文展示名。',
    params: [
      { name: 'q', type: 'string', required: false, defaultValue: '""', desc: '搜索关键词（如 深圳、Rotterdam、CNSZX、PVG）。留空则返回精选节点。' },
      { name: 'type', type: 'string', required: false, defaultValue: '""', desc: '节点类型过滤：city、port、airport、rail_hub、rail_border、chokepoint、airspace、sea_area。' },
      { name: 'endpoint', type: 'string', required: false, defaultValue: '""', desc: '传 "1" 时仅返回适合作为起终点的节点（过滤咽喉/空域并启用港群匹配）。' },
      { name: 'limit', type: 'number', required: false, defaultValue: '20', desc: '返回条数上限，范围 1–100。' },
    ],
    responseFields: [
      { name: 'graphVersion', type: 'string', desc: '当前图谱版本。' },
      { name: 'nodes[]', type: 'object[]', desc: '匹配节点数组，含 id、type、functions[]、code、codeStandard、name_zh、name_en、country、lon、lat、curated。' },
    ],
    responseSample: {
      graphVersion: '9f3c...',
      nodes: [
        {
          id: 'CNSZX',
          type: 'city',
          functions: ['city'],
          code: 'CNSZX',
          codeStandard: 'UN/LOCODE',
          name_zh: '深圳',
          name_en: 'Shenzhen',
          country: 'CN',
          lon: 114.0579,
          lat: 22.5431,
          curated: true,
        },
      ],
    },
  },
  {
    id: 'chokepoints',
    group: 'catalog',
    method: 'GET',
    methods: ['GET'],
    path: '/v1/chokepoints',
    title: '咽喉与空域',
    summary: '获取全部规范海运咽喉与受控空域列表，以及预计算队列中的受影响线路统计。',
    params: [],
    responseFields: [
      { name: 'graphVersion', type: 'string', desc: '当前图谱版本。' },
      { name: 'chokepoints[]', type: 'object[]', desc: '咽喉/空域列表，含 id、type、name_zh、name_en、lon、lat、major、region、affectedLaneCount、mustExposeLaneCount、totalPaths。' },
    ],
    responseSample: {
      graphVersion: '9f3c...',
      chokepoints: [
        {
          id: 'CP_SUEZ',
          type: 'chokepoint',
          name_zh: '苏伊士运河',
          name_en: 'Suez Canal',
          lon: 32.34,
          lat: 30.58,
          major: true,
          region: 'Red Sea / Egypt',
          affectedLaneCount: 28,
          mustExposeLaneCount: 19,
          totalPaths: 32,
        },
      ],
    },
  },
  {
    id: 'graphNodes',
    group: 'catalog',
    method: 'GET',
    methods: ['GET'],
    path: '/v1/graph/nodes',
    title: '全量图谱节点',
    summary: '一次性返回图谱内所有带有效坐标的非国家节点及其枢纽/接入元数据，供节点图谱视图与本地词表检索使用。',
    params: [],
    responseFields: [
      { name: 'graphVersion', type: 'string', desc: '当前图谱版本。' },
      { name: 'nodes[]', type: 'object[]', desc: '节点数组，含 id、code、codeStandard、type、functions[]、name_zh、name_en、country、region、lon、lat、aliases[]、featured、portTier、airportSize、routeCount、isHub、major、hasMarnet、hasRoadnet、landDegree、affectedLaneCount、firs、polygons、boxes 等字段。' },
    ],
    responseSample: {
      graphVersion: '9f3c...',
      nodes: [
        {
          id: 'NLRTM',
          code: 'NLRTM',
          codeStandard: 'UN/LOCODE',
          type: 'port',
          functions: ['port', 'city'],
          name_zh: '鹿特丹港',
          name_en: 'Rotterdam',
          country: 'NL',
          region: 'europe',
          lon: 4.4777,
          lat: 51.9244,
          aliases: ['Rotterdam'],
          featured: true,
          portTier: 1,
          hasMarnet: true,
          hasRoadnet: true,
          landDegree: 0,
        },
      ],
    },
  },
  {
    id: 'graphLinks',
    group: 'catalog',
    method: 'GET',
    methods: ['GET'],
    path: '/v1/graph/links',
    title: '多式联运路网连线',
    summary: '返回图谱中的 MARNET 海运航段、陆铁走廊、全球公路网、航空航线及全球 ICAO FIR 空域边界数据，支持按 layers 参数按需拉取。',
    note: '不传 layers 时默认返回 sea 与 land；全量路网体积较大，建议按图层按需请求并按 graphVersion 做本地缓存。',
    params: [
      { name: 'layers', in: 'query', type: 'string', required: false, default: 'sea,land', desc: '逗号分隔的图层列表，支持 sea、land、road、air、fir。' },
    ],
    responseFields: [
      { name: 'graphVersion', type: 'string', desc: '当前图谱版本。' },
      { name: 'counts', type: 'object', desc: '各图层总数量：{ sea, land, road, air, fir }。' },
      { name: 'sea[]', type: 'object[]', desc: '海运航段数组，每项为 { mode: "sea", coords: [[lon, lat], ...] }。' },
      { name: 'land[]', type: 'object[]', desc: '陆铁连线数组，每项为 { mode, from, to, corridor, distanceKm, coords: [[lon, lat], ...] }。' },
      { name: 'road[]', type: 'object[]', desc: '全球公路网边数组，每项为 { mode: "road", coords: [[lon, lat], ...] }。' },
      { name: 'air[]', type: 'array[]', desc: '航空航线紧凑元组数组，每项为 [fromIata, toIata, freq, crossesRussia]。' },
      { name: 'fir[]', type: 'object[]', desc: '全球 ICAO FIR 空域边界数组，每项为 { id, oceanic, lon, lat, region, polygons }。' },
    ],
    responseSample: {
      graphVersion: '9f3c...',
      counts: { sea: 12954, land: 83, road: 27368, air: 28323 },
      sea: [{ mode: 'sea', coords: [[114.27, 22.57], [114.4, 22.1]] }],
      land: [{ mode: 'rail', from: 'RAIL_SOUTHCHINA', to: 'CNALA', corridor: '中欧班列西通道', distanceKm: 4120, coords: [[114.05, 22.54], [82.58, 45.18]] }],
    },
  },
  {
    id: 'riskRadar',
    group: 'ops',
    method: 'GET',
    methods: ['GET'],
    path: '/v1/snapshots/risk-radar',
    title: 'Risk Radar 快照',
    summary: '导出与 supply-chain-risk-radar/network.mjs 兼容的静态风险雷达网络快照。',
    note: '需先执行 npm run precompute 生成 data/compiled/precomputed.json，否则返回 404。',
    params: [],
    responseFields: [
      { name: 'nodes[]', type: 'object[]', desc: '风险雷达兼容节点清单。' },
      { name: 'lanes[]', type: 'object[]', desc: '87 条重点线路 OD 的多方式备选路径及经由咽喉信息。' },
      { name: 'meta', type: 'object', desc: '快照生成时间、图谱版本与统计元数据。' },
    ],
    responseSample: {
      nodes: [{ id: 'CNSZX', name_zh: '深圳', type: 'city' }],
      lanes: [{ lane_id: 'CNSZX-NLAMS', origin: 'CNSZX', destination: 'NLAMS', modes: {} }],
      meta: { graphVersion: '9f3c...', laneCount: 87 },
    },
  },
  {
    id: 'health',
    group: 'ops',
    method: 'GET',
    methods: ['GET'],
    path: '/health',
    title: '健康检查',
    summary: '返回服务存活状态、当前图谱版本、构建节点边统计、预计算快照信息与缓存命中率。',
    params: [],
    responseFields: [
      { name: 'ok', type: 'boolean', desc: '服务是否正常就绪。' },
      { name: 'service', type: 'string', desc: '服务标识（"multimodal-router"）。' },
      { name: 'graphVersion', type: 'string', desc: '当前加载的图谱 SHA-256 版本。' },
      { name: 'builtAt', type: 'string | null', desc: '图谱最近编译时间（ISO 8601）。' },
      { name: 'counts', type: 'object | null', desc: '节点、海运边、全球干线公路边（roadnetEdges）、航线边（airnetEdges）、陆铁走廊边（landEdges）等图谱规模统计。' },
      { name: 'precomputed', type: 'object | null', desc: '预计算快照概览（laneCount、generatedAt）。' },
      { name: 'cache', type: 'object', desc: 'L1 内存与 L2 SQLite 缓存条目数及命中计数。' },
    ],
    responseSample: {
      ok: true,
      service: 'multimodal-router',
      graphVersion: '2b415c91c971',
      builtAt: '2026-11-25T06:45:48.747Z',
      counts: {
        nodesTotal: 6801,
        marnetVertices: 6704,
        marnetEdges: 12954,
        roadnetVertices: 20045,
        roadnetEdges: 27368,
        airnetEdges: 28323,
        landEdges: 83,
      },
      precomputed: { laneCount: 87, generatedAt: '2026-11-25T06:45:55.029Z' },
      cache: { memorySize: 0, sqliteEntries: 1218, memoryHits: 0, sqliteHits: 0, misses: 0 },
    },
  },
];

export const API_ERROR_FORMAT = '{"error": "错误说明"}';

export const API_CONVENTIONS = [
  {
    id: 'protocol',
    title: '基础接入约定',
    items: [
      { label: '编码与格式', text: '所有接口请求与响应均使用 `UTF-8` 编码的 `application/json`。' },
      { label: '跨域支持', text: '内置 `Access-Control-Allow-Origin: *`，支持 `GET`、`POST` 与 `OPTIONS` 预检。' },
      { label: '请求体上限', text: '`POST` JSON Body 最大允许 `256 KB`，超出将返回 `413`。' },
      { label: '双协议传参', text: '`/v1/routes` 与 `/v1/routes/compare` 同时支持 `POST JSON` 与 `GET Query`（数组参数以英文逗号拼接，如 `modes=sea,air`）。' },
    ],
  },
  {
    id: 'node-resolution',
    title: '节点编码规范与解析优先级',
    items: [
      { label: '标准编码', text: '城市与港口复用 5 位 `UN/LOCODE`（如 `CNSZX`、`NLRTM`），机场复用 3 位 `IATA`（如 `PVG`、`AMS`），咽喉/空域使用语义编码（如 `CP_SUEZ`、`AS_RUSSIA`）。' },
      { label: '解析顺序', text: '精确 `id` → 历史旧 ID（`legacyIds`，如 `CITY_SZ` → `CNSZX`）→ 经纬度字符串（`"114.05,22.54"`）或对象（`{"lon":114.05,"lat":22.54}`）→ `code` → 中英文别名。' },
      { label: '等价归一化', text: '不同别名（如 `"深圳"`、`"CITY_SZ"`、`"CNSZX"`）在服务端会被规范化为同一标准 ID 并共享同一缓存键。' },
    ],
  },
  {
    id: 'avoid-rules',
    title: '咽喉耦合与空域绕行规则',
    items: [
      { label: '海运咽喉联动', text: '避让 `CP_SUEZ`（苏伊士运河）或 `CP_BAB`（曼德海峡）时，系统会自动联动阻断耦合航段，模拟经好望角（`CP_CAPE`）或港口陆桥接驳的真实绕行。' },
      { label: '空域穿行与真实航网', text: '基于全球真实航线网（`airnet`）与全货机干线生成 0/1/2 次中转方案，默认常态避开乌克兰冲突空域；传入 `AS_RUSSIA` 或 `AS_MIDEAST` 时，优先尝试不落地空中走廊绕飞（如哈萨克—里海—黑海走廊、阿拉伯海—红海走廊）并保留经中东/东南亚/安克雷奇（`ANC`）技术经停或中转备选。' },
      { label: '陆路连通、港口分级与跨国清关', text: '海运选港按 `portTier`（1/2/3 级）排序并用 `land-mask` + `roadnet` 过滤隔海短驳；跨国公路/短驳自动叠加边境清关耗时与成本（`borderPenalty`）；手工走廊未覆盖的同大陆 OD 由全球干线公路网 A* 自动绕行。' },
      { label: '北极航线', text: '默认不启用北极通道，仅在显式允许时参与寻路。' },
    ],
  },
  {
    id: 'cache',
    title: '双层缓存与图谱版本',
    items: [
      { label: '三级命中链', text: 'L1 内存 LRU（默认上限 2,000 条）→ L2 SQLite 持久化（`var/route-cache.sqlite`）→ Single-Flight 并发去重。' },
      { label: '响应元信息', text: '`meta.cache` 返回 `hit`、`layer`（`memory` / `sqlite` / `inflight` / `miss`）与 `key`。' },
      { label: '版本隔离', text: '所有缓存键绑定编译指纹 `graphVersion`，图谱重新构建后自动失效旧缓存，无需手动清理。' },
    ],
  },
];

export const API_STATUS_CODES = [
  { code: '200 OK', meaning: '请求成功', detail: '返回 JSON 响应体。' },
  { code: '204 No Content', meaning: 'CORS 预检通过', detail: 'OPTIONS 预检请求响应，允许跨域调用。' },
  { code: '400 Bad Request', meaning: '参数无效或 JSON 解析失败', detail: '例如缺少 from / to、未知节点 ID 或请求体非合法 JSON。' },
  { code: '403 Forbidden', meaning: '静态路径越权', detail: '静态资源请求路径超出 public 目录范围。' },
  { code: '404 Not Found', meaning: '接口或快照不存在', detail: '未知路由，或未运行 npm run precompute 时访问 /v1/snapshots/risk-radar。' },
  { code: '413 Payload Too Large', meaning: '请求体过大', detail: 'POST JSON 请求体超过 256 KB 上限。' },
  { code: '500 Internal Error', meaning: '服务端异常', detail: '未捕获的内部计算或读写错误。' },
];

export function buildRequestSpec(endpoint, state = {}, origin = 'http://127.0.0.1:4180', methodOverride = null) {
  const method = endpoint.methods.includes(methodOverride) ? methodOverride : endpoint.method;
  const route = state.route ?? {};
  const from = route.from || 'CNSZX';
  const to = route.to || 'NLAMS';
  const modes = Array.isArray(route.modes) && route.modes.length ? route.modes : ['sea', 'air', 'rail', 'road'];
  const avoid = Array.isArray(route.avoid) ? route.avoid : [];
  const maxRoutes = Number(route.maxRoutes ?? 8) || 8;
  const includeGeometry = Boolean(route.includeGeometry);

  const url = new URL(endpoint.path, origin);
  let body = null;

  if (endpoint.id === 'routes' || endpoint.id === 'compare') {
    if (method === 'POST') {
      body = { from, to, modes, avoid, maxRoutes, includeGeometry };
    } else {
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      url.searchParams.set('modes', modes.join(','));
      if (avoid.length) url.searchParams.set('avoid', avoid.join(','));
      url.searchParams.set('maxRoutes', String(maxRoutes));
      url.searchParams.set('includeGeometry', String(includeGeometry));
    }
  } else if (endpoint.id === 'precompute') {
    body = {
      pairs: [{ from, to }],
      avoidScenarios: avoid.length ? [[], avoid] : [[]],
      modes,
      maxRoutes,
      includeGeometry: route.includeGeometry ?? true,
    };
  } else if (endpoint.id === 'nodes') {
    const ns = state.nodeSearch ?? {};
    if (ns.q) url.searchParams.set('q', ns.q);
    if (ns.type) url.searchParams.set('type', ns.type);
    if (ns.endpoint) url.searchParams.set('endpoint', String(ns.endpoint));
    if (ns.limit) url.searchParams.set('limit', String(ns.limit));
  }

  const bodyText = body ? JSON.stringify(body, null, 2) : '';
  const pathWithQuery = `${url.pathname}${url.search}`;
  const curl = body
    ? `curl -X ${method} ${shellQuote(url.href)} -H 'Content-Type: application/json' --data-raw ${shellQuote(bodyText)}`
    : `curl ${shellQuote(url.href)}`;

  return {
    method,
    url: url.href,
    pathWithQuery,
    body,
    bodyText,
    curl,
  };
}
