# 算法与架构设计

本文档说明 Multimodal Router 的离线图谱编译、分模态寻路引擎、成本/时效评分模型及双层缓存机制。

## 1. 离线图谱编译 (`scripts/build-graph.mjs`)

构建期将多源公开数据与精选配置编译为版本化的单文件图谱 `data/compiled/graph.json`（含确定性 SHA-256 指纹 `graphVersion`）：

1. **海运航道图 (`marnet`)**：解析 `marnet_searoute.geojson`，切分交叉口并保留 13 个咽喉标识，形成全联通无向图（`6,704` 顶点 / `12,954` 边）。
2. **港口三级分层 (`portTier: 1 | 2 | 3`)**：
   - **Tier 1**：全球远洋干线母港（如 `CNYTN`、`CNSHK`、`AEJEA`、`SAJED`、`SADMM`、`EGPSD`、`DJJIB`、`NLRTM`、`ZADUR`）。
   - **Tier 2**：区域枢纽及战略绕行港（如 `AEKLF`、`AEFJR`、`OMSOH`、`OMSLL`、`QAHMD`、`KEMBA`、`TZDAR`）。
   - **Tier 3**：普通支线与散货港。
3. **全球干线公路图 (`roadnet`)**：
   - 基于 Natural Earth `ne_10m_roads.geojson`，过滤轮渡与在建路段，并对北美/欧洲做分级密度裁剪。
   - 对孤立端点做 `<= 3.5 km` 陆地微断头焊接（`!crossesOpenSea`），随后进行同国别二度节点拓扑缩并、折点抽稀与 BFS 连通分量编号（`comp`），压缩为 `20,045` 顶点 / `27,368` 边（约 3~4 MB）。
   - 为所有非国家/非通道节点预计算陆路吸附点 `roadVertexId` 与 `roadSnapKm`。
4. **全球航线与全货机网 (`airnet`)**：
   - 基于 `airline_routes.json`（按 IATA 三字码）并叠加欧亚/跨太平洋（经 `ANC`）/中东非全货机干线，生成 `28,323` 条航线边及各机场航线密度 `routeCount`。
5. **精选陆铁走廊 (`landEdges`)**：
   - 编译 `data/curated/rail-land-corridors.json` 中的 `83` 条战略铁路/公路/渡运走廊，支持 `viaCoords` 沿海与山区折线轨迹。

## 2. 分模态寻路引擎

### 2.1 海运路由 (`src/engine/sea-router.mjs`)
- **网关港口筛选 (`selectGatewayPorts`)**：综合 `isHomePort`（`portGroups.json`）、`portTier`、直连走廊及同国偏好打分排序；通过 `land-mask.mjs`（基于 `countries.geojson` 的 `crossesOpenSea`）与 `roadnet` 连通性/路径距离校验，剔除跨海/切湾的无效公路短驳（如基什岛→迪拜、苏哈尔→马斯喀特直线切湾）。
- **内陆无港城市多跳寻港 (`findCorridorPorts`)**：对坎帕拉、卢萨卡等内陆枢纽，在 `landConnectionsByNode` 上跑限距 Dijkstra（`<= 2,400 km`）自动衔接可达海港。
- **航线搜索与咽喉消融**：在 `marnet` 上跑堆优化 Dijkstra，并对经过的主要咽喉执行消融重算以自动生成绕行备选（如经好望角、东岸港口）。

### 2.2 空运路由 (`src/engine/air-router.mjs`)
- **真实网络约束**：直飞、1 次枢纽中转与 2 次枢纽中转（偏远目的地兜底）均基于 `airnet` 真实连通性生成，杜绝虚构洲际直飞。
- **空域避让与走廊绕飞 (`planAirSegment`)**：
  - 默认常态避开乌克兰冲突空域（`23°E–40°E, 45.2°N–52°N`）。
  - `AS_MIDEAST` 精缩为伊朗-伊拉克-黎凡特与也门-曼德海峡两个冲突区，保留埃及—红海—沙特中部走廊。
  - 当大圆航线穿过受阻空域时，优先尝试经**黑海/里海中间走廊**或**阿拉伯海—红海走廊**的不落地绕飞（`空中走廊绕飞`），同时保留枢纽落地中转备选。
- **技术经停 (`ANC`)**：对 `> 8,500 km` 跨太平洋航线自动评估安克雷奇加油技术经停（`isTechStop: true`）。

### 2.3 陆运与全球公路 (`src/engine/land-router.mjs` & `src/engine/road-router.mjs`)
- **手工走廊 K 最短路**：在 `83` 条精选陆铁走廊上通过迭代边惩罚生成中欧班列、跨里海中间走廊、海湾 GCC 陆桥与东非走廊等方案。
- **零分配 A\* 全球公路 (`road-router.mjs`)**：未命中手工走廊时，先用 `comp` 在 $O(1)$ 时间内跳过跨海/不同大陆起终点，再使用预分配 `TypedArray` 与 `MinHeap` 在 `roadnet` 上跑 A* 搜索（支持威海→大连环渤海绕行等长距离陆路），并自动累计途经国家的边境摩擦惩罚。

## 3. 成本、时效与清关模型 (`src/engine/cost-model.mjs`)

- **港口分级滞留**：Tier 2 非本港海运段增加 `+0.55 天 / +0.45 成本`，Tier 3 支线港增加 `+1.0 天 / +0.8 成本`。
- **异地集卡阶梯价**：超过 `60 km` 的异地备选港公路短驳提高后段单价并叠加 `+0.85 天` 调箱与山路缓冲。
- **跨国境清关摩擦 (`borderPenalty`)**：
  - 深港（`CN <-> HK`）：`+0.35 天 / +0.40 成本`
  - 海合会内部（`GCC`）：`+0.65 天 / +0.85 成本`
  - 常规跨国陆路口岸：`+1.15 天 / +1.45 成本`
- **空运细节**：安克雷奇技术经停仅计 `0.18 天 / 0.9 成本`（远低于商业拆板中转 `0.6 天 / 2.5 成本`）；独飞航线叠加 `+0.3 天` 班期等待；空中走廊绕飞叠加 `+0.25 天 / +1.6 成本`。

## 4. 双层缓存与预计算 (`src/cache/route-cache.mjs` & `scripts/precompute.mjs`)

- **版本绑定**：所有缓存键均由 `graphVersion + kind + 规范化参数` 生成 SHA-256，图谱重新编译后自动隔离旧缓存。
- **三级命中链**：L1 内存 LRU（默认 2,000 条）→ L2 SQLite 持久化（`var/route-cache.sqlite`）→ 并发 Single-Flight 去重。
- **预计算快照**：`npm run precompute` 预热 87 条重点 OD × 5 个咽喉场景（共 1,218 条缓存记录），并输出 `data/compiled/precomputed.json`。
