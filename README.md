# Multimodal Router

独立的多式联运路径计算引擎与 HTTP 服务（零第三方运行时依赖，基于 Node.js 24 ESM + 内置 `node:sqlite`）。

给定任意两个节点（城市、港口、机场、UN/LOCODE、IATA 三字码、或 `lon,lat` 经纬度），自动生成并评估多条海运、空运、铁路、公路及咽喉绕行备选方案，同时支持导出兼容 `supply-chain-risk-radar` 的静态快照。

## 数据来源

- **MARNET 全球海运航道网** (`eurostat/searoute` / `genthalili/searoute-py` `marnet_searoute.geojson`)：4,109 条全球海上航段及 13 个咽喉标识（苏伊士、曼德、霍尔木兹、马六甲、巽他、好望角、直布罗陀、巴拿马等），编译时自动处理跨 180° 经线拼接与 T 型节点切分，形成全联通单连通分量（6,704 顶点 / 12,954 边）。
- **全球港口位置表** (`ports.geojson`，含 UN/LOCODE)：与业务精选节点合并，按 `portTier`（Tier 1 远洋母港 / Tier 2 区域及绕行枢纽 / Tier 3 普通支线港）分级，并通过空间网格与陆地掩膜（`land-mask.mjs`）自动吸附至 MARNET 海运顶点，过滤隔海相望的无效短驳港口。
- **OurAirports 全球机场库** (`airports.csv`，Public Domain) 与 **全球定期航线/全货机网** (`Jonty/airline-route-data` `airline_routes.json` + 全货机干线补充)：筛选具备定期航班的 `large_airport` / `medium_airport` 及主要货运枢纽，编译为 **28,323 条**航线边（`airnet`），支持真实 0/1/2 次中转、常态乌克兰禁飞区避让、空中走廊绕飞与安克雷奇（`ANC`）技术经停。
- **Natural Earth 1:10m 全球干线公路网** (`ne_10m_roads.geojson`)：过滤轮渡与在建路段，经微断头焊接（`<= 3.5 km`）与二度节点拓扑缩并后形成紧凑陆路图 `roadnet`（20,045 顶点 / 27,368 边），支持同大陆任意节点 A* 沿陆路自动绕行（如威海→大连环渤海公路）。
- **精选多式联运走廊** (`data/curated/`)：
  - `chokepoints.json`：规范咽喉与空域映射（含 `CP_SUEZ` / `CP_BAB` 耦合、`AS_RUSSIA` 及精缩后的 `AS_MIDEAST` 冲突区检测盒）。
  - `rail-land-corridors.json`：中欧班列北线（`CNALA` 阿拉山口 / `RB_KHORGOS` 霍尔果斯）、西伯利亚线（`CNMZH` 满洲里）、跨里海中间走廊（`KZAAU` 阿克套 - `AZBAK` 巴库渡运 - `GETBS` 第比利斯）、**中东非海陆联运骨架走廊**（海湾 GCC 红海↔波斯湾陆桥、阿曼/阿联酋绕霍尔木兹山区/沿海走廊、东非蒙内/坦赞铁路及内陆口岸）等共 83 条走廊边（支持 `viaCoords` 折线轨迹）。
  - `seed-nodes.json` & `cohort-od.json`：兼容 `supply-chain-risk-radar` 的业务节点与 87 条重点线路 OD 队列。
  - `public-node-names-zh.json`：按 UN/LOCODE 或 IATA 代码维护公开港口和机场的中文译名。更新公开数据后，构建会列出仍需补充中文名的节点。

## 节点编号规范（复用国际标准代码）

- **国家/地区 (`country`)**：直接使用 **ISO 3166-1 alpha-2**（如 `CN`、`NL`、`AE`、`SA`、`MX`）。
- **机场 (`airport`)**：直接使用 **IATA 三字码**（如 `SZX`、`HKG`、`AMS`、`DXB`、`IST`、`ICN`、`LAX`）。
- **港口与城市 (`port` / `city`)**：直接使用 **UN/LOCODE 五位码**（如 `CNSZX`、`CNYTN`、`CNSHK`、`HKHKG`、`NLRTM`、`NLAMS`、`AEJEA`、`SADMM`、`SAJED`、`MXLZC`、`MXVER`）；同址城市与港口（如 `HKHKG`、`TRIST`、`OMMCT`）统一合并为多职能节点（`functions: ['city', 'port']`）。
- **陆铁枢纽与口岸**：有 UN/LOCODE 者复用标准码（`CNALA`、`PLMLW`、`CNMZH`、`RUZAB`、`DEDUI`、`KZAAU`、`AZBAK`、`GETBS`、`KENBO`、`UGKLA`、`ZMLUN`、`SDKRT`），无通用编码的咽喉/空域/边界走廊保留规范语义编码（`CP_*`、`AS_*`、`BORDER_*`、`RB_KHORGOS`、`SEA_CASPIAN`）。
- **向后兼容**：保留旧编号（`CITY_SZ`、`PORT_YANTIAN`、`AP_SZX`、`CTY_CN` 等）在 `legacyIds` 与 `aliases` 中，传入旧编号会自动归一化至标准编码并共享同一缓存键。

## 避免冗余重算（参考 WorldMonitor 模式）

1. **版本化不可变图产物 (`graphVersion`)**：`build-graph.mjs` 为编译后的拓扑计算确定性 SHA-256 指纹，图谱不变则所有缓存永久有效；图谱升级自动清理旧版本缓存。
2. **双层持久化缓存 (`src/cache/route-cache.mjs`)**：
   - **L1 内存 LRU** + **L2 SQLite (`var/route-cache.sqlite`)** + **并发 Single-Flight 去重**。
   - 查询前将中英文名/代码统一规范化为节点 ID 并排序参数，不同别名的等价查询直接共享同一缓存键。
3. **批量预计算与咽喉倒排索引 (`scripts/precompute.mjs`)**：
   - 一次批处理预热全部 87 条业务 OD × 5 个咽喉受阻场景（基线、红海苏伊士、霍尔木兹、马六甲、巴拿马）写入 SQLite，并原子产出 `data/compiled/precomputed.json`（含咽喉倒排索引 `chokepointIndex` 与 `riskRadarSnapshot`）。

## 快速开始

```bash
# 1. 下载公开数据集到 data/raw/
npm run fetch:data

# 2. 编译版本化多式联运图谱到 data/compiled/
npm run build:graph

# 3. 批量预计算业务队列并生成咽喉倒排与兼容快照
npm run precompute

# 4. 启动 HTTP 服务与可视化评估台 (默认 http://127.0.0.1:4180)
npm start

# 5. 运行单元测试与接口集成测试
npm test
```

## 后台服务与内网更新

通过 [scripts/service.sh](scripts/service.sh) 管理后台服务（默认监听 `0.0.0.0:4180`）：

```bash
npm run service:start    # 启动后台服务
npm run service:stop     # 停止后台服务
npm run service:restart  # 普通重启（保留已有 SQLite 缓存，适合前端或非算法调整）
npm run service:rebuild  # 停服 -> 清空 SQLite 缓存 -> 重新 precompute -> 启动（适合路由/成本算法更新）
npm run service:status   # 查看进程与 /health 状态
npm run service:logs     # 查看最近日志
```

## 文档索引

- **算法与架构设计**：[docs/ALGORITHM.md](docs/ALGORITHM.md)（分模态寻路算法、成本/时效评分公式、WorldMonitor 缓存模式与维护指南）
- **HTTP API 文档**：[docs/API.md](docs/API.md)（由 [public/api-docs-data.js](public/api-docs-data.js) 通过 `npm run docs:api` 自动生成，与前端「API 说明」弹窗共用同一数据源并保持同步）

## HTTP API

首页顶部的「API 说明」提供全部 HTTP 接口的请求/响应字段文档、在线试调（Try-it-out）、JSON/cURL 复制、可搜索参数词表以及编码/缓存/状态码接入规范。

- `GET /health` — 服务健康状态、图谱版本、构建统计与缓存命中率
- `GET /v1/nodes?q=...&type=...&limit=...` — 节点搜索与自动补全
- `GET /v1/graph/nodes` — 全量带坐标图谱节点列表
- `GET /v1/graph/links` — 全量海运航段与陆铁走廊坐标连线
- `GET /v1/chokepoints` — 规范咽喉与空域列表（附带预计算受影响线路数）
- `GET / POST /v1/routes` — 多式联运多路径计算（参数：`from`, `to`, `modes`, `avoid`, `maxRoutes`, `includeGeometry`）
- `GET / POST /v1/routes/compare` — 基线 vs 咽喉受阻对比分析（返回 `affected`, `alternatives`, `landSubstitutions`, `impactSummary` 及 `deltaDays` / `costMultiplier`）
- `POST /v1/precompute` — 触发指定 OD 与场景批量预热
- `GET /v1/snapshots/risk-radar` — 导出与 `supply-chain-risk-radar/network.mjs` 兼容的 `{ nodes, lanes, meta }` 快照
