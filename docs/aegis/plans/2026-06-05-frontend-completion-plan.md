# 前端补齐计划与验收矩阵

日期：2026-06-05

## 目标
把当前“节点优先”的前端草稿补齐成可验收的 Console UI 第一版，同时不扩大后端范围，也不让 Agent 职责泄漏到浏览器端。

## 架构
- Console 仍然是唯一面向浏览器的运行时 owner。
- Agent 仍然只负责执行侧；前端不得直接调用 Agent 端点。
- `Console.tsx` 负责页面路由、选中实例身份、摘要加载和动作处理函数。
- 各页面组件负责自己的视图状态、筛选、布局和用户可见文案。
- `webui/frontend/src/lib/api.ts` 里的现有 API client wrapper 仍然是前端唯一 API 边界。
- 第一轮补齐只使用当前 `/api/*` 契约；只属于后端的想法记录为延期项，不在 UI 里假装已经存在。

## 技术栈
- React 19 + TypeScript + Vite。
- Tailwind CSS v4 工具类，以及 `webui/frontend/src/styles/tailwind.css` 里的现有 CSS 变量。
- 继续使用现有 lucide 图标依赖。
- 不新增前端框架、路由库、状态管理器、图表库或后端 API client。

## 基线/权威参考
- `docs/FRONTEND_REDESIGN_PLAN.md`
- `docs/aegis/specs/2026-05-31-frontend-redesign-brief.md`
- `docs/aegis/plans/2026-05-31-node-first-frontend-workspace.md`
- `docs/mockups/node-first-dense-workspace.html`
- `webui/frontend/src/Console.tsx`
- `webui/frontend/src/pages/Overview.tsx`
- `webui/frontend/src/pages/Detail.tsx`
- `webui/frontend/src/pages/CreateInstance.tsx`
- `webui/frontend/src/pages/ConfigEditor.tsx`
- `webui/frontend/src/pages/NodesPage.tsx`
- `webui/frontend/src/pages/AuditLogsPage.tsx`
- `webui/frontend/src/pages/SystemPage.tsx`
- `webui/frontend/src/lib/api.ts`
- `webui/frontend/src/lib/types.ts`

## 兼容边界
- 本轮补齐不改后端 API。
- 浏览器不直接调用 Agent。
- 实例身份仍然是 `nodeId:name`。
- 原始 TOML 必须保留，不能被结构化 UI 隐藏掉。
- 破坏性操作必须在执行前明确展示对象和影响范围。
- 当前 API 不提供的数据必须标成不可用，或放入延期的后端/API 跟进项，不能在前端编造。

## 验证
- 在 `webui/frontend` 下运行 `npm run build`。
- 运行 `git diff --check`。
- 启动 `npm run dev` 后，在 `http://127.0.0.1:5173/` 做本地人工验证。
- 按本文档里的验收矩阵做浏览器验收扫查。

## 当前问题分析

### 跨页面问题
- 视觉语言分裂：新的节点优先工作台和旧的详情/创建/节点/审计/系统页面在外壳和信息密度上不统一。
- 旧的 `Sidebar` 组件仍然存在，但当前 shell 已转向顶部栏/头像菜单导航；遗留路由入口因此不一致。
- 工作台已经是节点优先，但下游页面仍在使用较旧的“总览/配置”语义。
- 破坏性或中断性操作仍依赖 `window.confirm`。
- 多个页面缺少强对象头，不能稳定展示节点、实例、状态、启用状态和动作范围。
- 空状态、加载状态、离线状态、不可达状态表达不统一，有些过于安静。
- 移动端/窄屏主要依赖 grid 自动换行，还没有按卡片和动作菜单认真设计。

### 工作台 / Overview 缺口
- 已经有第一版基础，但整体仍偏信息展示，还没有成为完整的操作工作台。
- “在此范围创建实例”没有把当前选中的节点传给 `CreateInstance`。
- 顶部栏全局搜索目前只是视觉输入，真正生效的是页面内部筛选。
- 实例表缺少 proxy/frps 列，因为 `/api/summary` 不包含配置摘要。
- 节点卡片只展示摘要计数，没有安装命令或系统详情。
- 节点生命周期动作正确地留在 `NodesPage`，但工作台里这个边界还不够明显。

### 详情 / 日志 / 配置缺口
- `Detail.tsx` 基本还是“日志页 + 操作面板”，不是方案书里的完整实例 cockpit。
- 没有 `日志`、`配置`、`代理`、`操作记录` tabs。
- 配置编辑仍是单独顶级路由 `config`，还没有作为实例内 tab 或嵌入面板出现。
- 代理列表只是摘要，没有以“本地目标 -> 远端端口/域名”的一等表格展示。
- 没有展示实例相关审计记录。
- 对象头缺少节点名、启用开关、配置路径重点展示和更清晰的高风险操作分组。

### 创建实例缺口
- `CreateInstance.tsx` 已经有核心表单字段，但仍像技术表单，不像引导式创建流程。
- 节点选择没有展示在线/离线状态，也没有解释选择离线节点的影响。
- 右侧执行摘要在桌面长表单滚动时不是 sticky。
- 工作台当前选中的节点没有作为默认值传入。
- TOML 模式已有提示，但偏弱；结构化/原始模式边界需要更醒目。
- 右侧 checklist 描述了动作，但没有清楚展示目标节点状态、代理数量、预计远端端口。

### 配置编辑缺口
- 当前是 route-level 页面，实例上下文偏弱，也缺少自然返回路径。
- “保存后重启容器”是 header 里的 checkbox，不是影响明显的一等开关。
- 结构化编辑警示只是文字，很容易被忽略；但它确实可能丢弃高级 proxy 字段。
- 重置默认配置调用的是旧的 `/api/config/default`，没有 node scoping；对节点实例存在风险，在强化入口前需要重新评估。

### 节点页缺口
- `NodesPage.tsx` 已经有真实节点生命周期动作，但轮换/升级/删除仍使用浏览器 confirm。
- 没有展示每个节点的实例健康计数，虽然工作台已经能从 summary 计算这些数据。
- 安装命令以内联面板出现在表格下方，而不是更聚焦的 drawer/modal 式上下文。
- 删除确认不要求输入节点名，但这个动作会级联实例和 Agent。
- 节点系统详情在 `SystemPage`，没有和节点操作放在一起。

### 审计页缺口
- `AuditLogsPage.tsx` 只是简单的最近操作表。
- 没有节点、实例、动作、成功/失败的客户端筛选。
- 失败记录不够突出。
- 长消息不能展开/收起。
- 行不能跳回相关节点或实例页面。
- 服务端筛选延期，因为当前 API 只支持 `limit`。

### 系统页缺口
- `SystemPage.tsx` 把 Console 信息、节点系统、账号安全混在一个长页面里。
- 没有按方案书拆成 tab 或分区。
- 节点系统卡片独立加载，但没有统一刷新入口。
- 离线/错误状态只是文字，作为运维风险时视觉上偏弱。

## 计划依据
- 事实：当前后端已经提供本轮 UI 补齐需要的主要 CRUD、动作、日志、配置、审计、系统 API。
- 事实：`/api/summary` 不提供每个实例的配置摘要或 proxy/frps 详情。
- 事实：审计日志 API 当前只支持按 `limit` 列表读取。
- 假设：本轮补齐应优先追求可用的运维工作流，而不是完全照搬 mockup 像素。
- 假设：节点优先的密集工作台仍是已接受的 shell 方向。
- 未知：顶部栏 shell 稳定后，用户是否希望删除旧的 `Sidebar` 组件。

## 架构完整性检查
- 不变量：Console 拥有浏览器 API 调用和路由级状态；Agent 只在 Console 后方执行。
- 规范 owner / 契约：`Console.tsx` 负责选中实例和页面切换；页面组件负责自己的 UI 状态。
- 职责重叠：`ConfigEditor` 和预期的实例详情 `配置` tab 有重叠。
- 更高层简化路径：把配置、代理、审计视图折入 `Detail.tsx` 的 tabs；`ConfigEditor` 可作为可复用配置面板或过渡路由保留。
- 退休条件 / 证伪点：详情 tabs 覆盖配置能力后，移除顶级 `config` 路由入口，只保留实例内访问。
- 结论：按切片推进；不要一次性重写所有页面。

## 计划压力测试
- Owner / contract / retirement：只要共享 UI 抽到页面局部 helper，且 `Console.tsx` 继续做页面协调，边界稳定。
- 架构完整性 / 更高层路径：详情页应该成为实例 cockpit，避免继续扩散多个顶级 route。
- 验证范围：本轮是前端-only，当前没有测试框架；build + 人工验收矩阵足够作为第一轮证据。
- 任务可执行性：按页面/工作流切片，而不是按视觉小零件切片。
- 压力测试结果：按五个实现切片推进。

## 计划时复杂度检查
- 目标文件：
  - `webui/frontend/src/Console.tsx` 当前 315 行。
  - `webui/frontend/src/pages/Overview.tsx` 当前 544 行。
  - `webui/frontend/src/pages/overview/WorkspaceParts.tsx` 当前 497 行。
  - `webui/frontend/src/pages/Detail.tsx` 当前 468 行。
  - `webui/frontend/src/pages/CreateInstance.tsx` 当前 459 行。
  - `webui/frontend/src/pages/NodesPage.tsx` 当前 462 行。
  - `webui/frontend/src/pages/SystemPage.tsx` 当前 311 行。
  - `webui/frontend/src/pages/AuditLogsPage.tsx` 当前 159 行。
- 现有规模/形状信号：没有页面超过 800 行，但 `Detail`、`CreateInstance`、`NodesPage` 已经接近需要拆分的规模；添加大布局时应抽出页面局部组件。
- Owner 匹配：优先在页面 owner 内编辑；只有至少两个页面确实需要同一个组件时，才移动到 `webui/frontend/src/components/ui/`。
- 直接堆代码风险：如果把日志、配置、代理、审计都直接塞进 `Detail.tsx`，风险很高。
- 更好的文件边界：当页面接近 650 行时，增加 `pages/detail/`、`pages/create/`、`pages/nodes/` 这类页面局部子目录。
- 建议：小布局改动可就地编辑；Detail 和 Nodes 在跨过 800 行前先抽 helper 组件。

## 实现切片

### 切片 1 - 工作台闭环
文件：
- 修改 `webui/frontend/src/Console.tsx`
- 修改 `webui/frontend/src/pages/Overview.tsx`
- 修改 `webui/frontend/src/pages/overview/WorkspaceParts.tsx`
- 修改 `webui/frontend/src/pages/CreateInstance.tsx`
- 可能修改 `webui/frontend/src/lib/types.ts`

目的：
- 让首屏从“部分 mockup”变成真正可操作的工作台。

影响/兼容：
- 不改后端。
- 选中节点默认值只通过前端状态传递。
- 缺失的 frps/proxy 摘要必须明确不可用，除非后续通过现有 detail/config 端点按需加载。

任务：
- 增加工作台到创建页的 selected-node handoff。
- 把用户可见的“返回总览”改成“返回节点工作台”。
- 让工作台的节点边界更清楚：节点生命周期动作属于节点管理，实例动作属于实例详情。
- 增加无节点、无实例的空状态路径。
- 顶部栏全局搜索要么作为快捷键聚焦工作台搜索，要么明确不是假输入；不要留一个误导性输入框。

验证：
- `npm run build`
- 人工：选择一个节点，点击创建，确认该节点被预选。
- 人工：无节点和无实例状态可读，并有下一步。
- 人工：顶部栏搜索行为要么有效，要么不再像一个空承诺。

验收：
- 工作台对“无节点”“已选节点”“已选实例”都有清晰第一动作。
- 从选中节点创建实例时，用户不需要重新选择节点。
- 用户能判断哪些动作属于节点生命周期，哪些属于实例生命周期。

### 切片 2 - 实例详情 Cockpit
文件：
- 修改 `webui/frontend/src/pages/Detail.tsx`
- 需要时创建 `webui/frontend/src/pages/detail/DetailParts.tsx`
- 复用或重构 `webui/frontend/src/pages/ConfigEditor.tsx`
- 仅当复用现有端点需要小 wrapper 时，才可能修改 `webui/frontend/src/lib/api.ts`

目的：
- 补齐主运维闭环：诊断 -> 看日志 -> 查代理/配置 -> 安全重启。

影响/兼容：
- 不改后端。
- 日志继续使用现有 REST/SSE 端点。
- 配置继续使用现有 node-scoped 和旧本机兼容配置端点。
- 审计 tab 第一版可使用现有 `/api/audit-logs?limit=...`，再做客户端过滤。

任务：
- 增加对象头，展示节点、实例名、显示名、状态、启用状态和主操作。
- 增加 tabs：`日志`、`配置`、`代理`、`操作记录`。
- 把当前日志 viewer 移入 `日志` tab，并让暂停/跟随/筛选控制更清晰。
- 用现有 `detail.summary.proxyTypes` 和 `remotePorts` 做 `代理` tab；缺失字段要诚实展示不可用。
- 通过嵌入/重构现有配置编辑行为增加 `配置` tab。
- 用客户端过滤审计记录增加 `操作记录` tab。
- 把高风险动作（`recreate`，以及未来如果暴露删除）和 start/stop/restart 分组。

验证：
- `npm run build`
- 人工：从工作台打开实例，切换所有 tabs。
- 人工：日志 tail 和 follow 仍可用。
- 人工：配置保存时选择重启/不重启仍走当前端点。
- 人工：代理 tab 能处理空代理列表。
- 人工：实例审计 tab 有匹配记录时展示，没有时显示清晰空态。

验收：
- 用户能在实例详情页内完成诊断、日志查看、配置修改和重启，不需要跳出页面。
- 每个 tab 都展示同一个实例上下文。
- 前端代码不调用 Agent 端点。

### 切片 3 - 引导式创建/编辑流程
文件：
- 修改 `webui/frontend/src/pages/CreateInstance.tsx`
- 需要时创建 `webui/frontend/src/pages/create/CreateParts.tsx`
- 只有 proxy 规则行展示需要可复用打磨时，才修改 `webui/frontend/src/components/ProxyList.tsx`

目的：
- 创建实例是最容易误配节点、frps、proxy、启动行为的地方，需要从技术表单变成引导流程。

影响/兼容：
- 不改后端。
- 继续使用现有 `nodesApi.instances.create` 和旧 `/api/instances` fallback。
- TOML 模式继续保留。

任务：
- 把创建页整理为清晰分区：基本信息、frps 连接、代理规则、启动选项。
- 在节点选择器中展示在线/离线状态。
- 桌面端右侧 summary 设为 sticky。
- 增加目标节点、校验状态、代理数量、远端端口、将要执行动作的摘要。
- 强化 TOML 模式提示和结构化/原始边界。
- 接收切片 1 的 selected-node 默认值。

验证：
- `npm run build`
- 人工：全局打开创建页时，有第一个有效节点默认值或明确要求选择节点。
- 人工：从选中节点打开创建页时，该节点被预选。
- 人工：非法实例名、缺失 frps server、非法 proxy 都有清晰校验。
- 人工：编辑原始 TOML 后，校验摘要仍更新。

验收：
- 用户在点击创建前能理解“创建到哪里”“连接哪个 frps”“有哪些代理”“会执行什么”。
- 离线节点选择是可见的，不会静默发生。
- 高级 TOML 模式有明确标识。

### 切片 4 - 节点生命周期与风险控制
文件：
- 修改 `webui/frontend/src/pages/NodesPage.tsx`
- 需要时创建 `webui/frontend/src/pages/nodes/NodeParts.tsx`
- 只有需要把 summary 计数传入 `NodesPage` 时，才修改 `webui/frontend/src/Console.tsx`

目的：
- 节点页拥有安装、轮换密钥、Agent 升级和删除。这些都是高影响操作，当前却依赖浏览器 confirm。

影响/兼容：
- 不改后端。
- 现有节点生命周期 API 调用保持不变。
- 如果 `Console.tsx` 已有 summary 数据，可以传入节点实例计数；否则只展示已知节点列表数据。

任务：
- 用样式统一的确认弹窗替换 rotate/upgrade/delete 的 `window.confirm`。
- 删除节点确认必须展示级联影响，并要求输入节点名。
- 安装命令用聚焦 drawer/panel 展示，包含复制动作和 host/TLS/image 元数据。
- 用现有可用数据增加节点健康/实例计数摘要。
- 为未连接节点增加清晰离线指引。

验证：
- `npm run build`
- 人工：安装命令能打开并复制。
- 人工：轮换密钥需要确认，并更新安装命令。
- 人工：离线节点升级被禁用或有警告。
- 人工：删除必须输入节点名匹配后才调用现有删除端点。

验收：
- 高风险节点动作不再使用浏览器 confirm。
- 用户能在破坏性操作前看到准确节点和影响范围。
- 节点页清楚表达 Agent 主动连回主控的模型。

### 切片 5 - 审计和系统页打磨
文件：
- 修改 `webui/frontend/src/pages/AuditLogsPage.tsx`
- 修改 `webui/frontend/src/pages/SystemPage.tsx`
- 如果任一文件接近 650 行，再创建页面局部 parts 文件。

目的：
- 这些是次要页面，但主工作流升级后，它们不能继续像旧后台残留。

影响/兼容：
- 本轮审计筛选只做客户端筛选。
- 节点系统数据继续使用现有 `nodesApi.system`。
- 不新增服务端筛选、分页或缓存。

任务：
- 增加客户端审计筛选：节点、实例文本、动作、结果。
- 突出失败记录，并支持长消息展开。
- 在身份信息足够时增加行跳转动作，跳到相关节点或实例。
- 把系统页重组为 tabs/分区：Console 信息、节点系统、账号安全。
- 增加统一节点系统刷新和更明显的离线/错误状态。

验证：
- `npm run build`
- 人工：审计筛选组合生效。
- 人工：长审计消息可展开/收起。
- 人工：系统 tabs 不破坏账号表单状态。
- 人工：离线节点系统卡片视觉上足够明显。

验收：
- 不改后端的前提下，审计页能支持常见排查。
- 系统页清晰分离 Console、节点系统和账号安全。

## 延期的后端/API 跟进项
- 服务端审计筛选和分页。
- 实例列表服务端分页。
- `/api/summary` 增加每个实例的配置摘要，例如 frps endpoint、proxy count、proxy types、remote ports。
- 节点系统资源缓存，用于工作台级 Docker/frpc/disk 展示。
- 批量实例操作。
- 配置备份/恢复 UI。
- 告警/监控设置。

## 验收矩阵

| 区域 | 验收检查 | 证据 |
| --- | --- | --- |
| 边界 | 前端只通过 `api` / `nodesApi` 调用 Console `/api/*` 路由 | 代码搜索和 build |
| 工作台 | 选择节点会筛选实例列表，从节点创建实例会预选该节点 | 浏览器人工检查 |
| 工作台 | 无节点、无实例状态有下一步动作 | 浏览器人工检查 |
| 详情 | 实例详情有对象头，并有 logs/config/proxies/audit tabs | 浏览器人工检查 |
| 详情 | 日志 follow、tail、keyword filter 仍可用 | 浏览器人工检查 |
| 详情 | 配置保存可选择重启或不重启 | 浏览器人工检查 |
| 创建 | 用户能看到节点状态、frps 字段、proxy 规则、启动选项和 sticky 执行摘要 | 浏览器人工检查 |
| 创建 | 无效输入会阻止创建并给出可读提示 | 浏览器人工检查 |
| 节点 | 安装、轮换、升级、删除都使用样式化确认或聚焦面板 | 浏览器人工检查 |
| 节点 | 删除要求输入节点名 | 浏览器人工检查 |
| 审计 | 客户端筛选和失败高亮可用 | 浏览器人工检查 |
| 系统 | Console 信息、节点系统、账号安全分区清晰 | 浏览器人工检查 |
| 响应式 | 工作台、详情、创建、节点页在桌面和窄屏可用 | 浏览器人工检查 |
| 构建 | `npm run build` 通过 | 命令输出 |
| 卫生检查 | `git diff --check` 通过 | 命令输出 |

## 非目标
- 本计划不新增后端端点。
- 不实现告警、备份/恢复、批量操作或多租户权限。
- 不编造当前 API 没有的数据。
- 不移除原始 TOML 编辑。
- 不在前端代码里直接打开 Agent 运行职责。

## 回滚面
- 最安全的回滚方式是按页面回滚：`Overview`、`Detail`、`CreateInstance`、`NodesPage`、`AuditLogsPage`、`SystemPage` 可独立回滚。
- `Console.tsx` 改动应保持很小，只关注状态 handoff 和页面路由。
- 在实例详情完全接管配置前，保留过渡性的 `config` 路由兼容。

## 执行顺序
1. 切片 1：工作台闭环。
2. 切片 2：实例详情 Cockpit。
3. 切片 3：引导式创建/编辑流程。
4. 切片 4：节点生命周期与风险控制。
5. 切片 5：审计和系统页打磨。

每完成一个切片就停下来做 build 验证和用户/浏览器验收。如果某个切片发现缺少后端数据，把它记录到“延期的后端/API 跟进项”，不要在前端假装字段存在。
