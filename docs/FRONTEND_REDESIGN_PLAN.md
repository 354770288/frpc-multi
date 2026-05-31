# frpc-multi 前端页面改造方案书

日期：2026-05-31

## 1. 背景与目标

当前项目已经完成 Console + Agent 前后端/执行端分离：浏览器只访问 Console，Console 通过 Agent 的反向 WebSocket 连接管理各节点上的 `frpc` 实例。后端能力已经覆盖节点、实例、配置、日志、审计和系统信息，但前端页面仍偏向“功能模块堆叠”，用户在日常运维时需要在总览、详情、配置、节点之间反复跳转。

本次方案目标不是马上改代码，而是先形成一份可用于生成前端页面草稿的设计说明。后续根据页面草稿再回到代码实现。

## 2. 当前功能汇总

### 2.1 登录与账号
- 登录后保存 token，后续请求通过 `Authorization: Bearer <token>` 访问 API。
- 401 时自动清除登录态并回到登录页。
- 系统页可修改管理员用户名和密码，保存后刷新登录态。
- 系统页展示 token 有效期、本次会话到期时间。

### 2.2 总览与实例列表
- 聚合展示所有节点下的实例数量：总数、运行中、已停止、异常。
- 汇总实例 CPU、内存使用数据。
- 展示 Console 角色、节点数。
- 实例表支持按实例名、显示名、描述、节点名搜索。
- 每行展示实例名、节点、状态、启用开关、CPU、内存、重启次数、配置路径。
- 支持启动、停止、重启、启用/停用、查看日志、编辑配置、删除实例。

### 2.3 实例详情与日志
- 展示单个实例的状态、启用状态、描述、CPU、内存、重启次数、配置路径。
- 支持启动、停止、重启、重新创建容器。
- 日志支持最近 100/300/1000 行、关键字过滤、实时跟随。
- 展示配置摘要：frps 地址、端口、认证方式、代理数量、代理类型、远端端口。

### 2.4 创建实例
- 选择目标节点。
- 自动生成 `client-001` 这类默认实例名，并校验唯一性。
- 设置显示名称、备注、启用状态、创建后立即启动。
- 结构化填写 frps 地址、端口、认证 token。
- 结构化添加代理：代理名、类型、本地 IP、本地端口、远端端口、子域名、自定义域名。
- 支持切换到原始 TOML 模式直接编辑。
- 右侧展示校验结果和创建后会执行的动作。

### 2.5 配置编辑
- 当前实例配置可在结构化代理编辑和原始 TOML 之间切换。
- 自动校验配置，展示错误、警告和配置摘要。
- 保存时可选择保存后重启容器。
- 支持重置为默认配置。
- 结构化代理编辑只处理常用字段；高级字段必须在原始 TOML 模式编辑。

### 2.6 节点管理
- 展示节点列表：名称、状态、UUID、最近在线时间。
- 创建节点后生成一键安装命令。
- 安装命令支持复制，并展示主控地址、UUID、TLS、镜像信息。
- 支持查看安装命令、轮换密钥、升级 Agent、删除节点。
- 删除节点会级联删除该节点实例和 Agent 容器。
- 节点页定时刷新在线状态。

### 2.7 审计日志
- 展示最近操作记录。
- 包含时间、操作人、动作、节点、实例、结果、消息。
- 记录创建、更新、修改配置、删除、启动、停止、重启、重建等动作。

### 2.8 系统信息
- 展示 Console 版本、角色、项目目录、面板地址、当前登录用户、节点数。
- 展示每个节点的 Docker 版本、frpc 镜像、frpc 版本、项目目录、磁盘占用。
- 节点不可达时展示错误状态。

## 3. 现有页面主要使用痛点

1. 导航按技术模块组织，不按运维任务组织。用户想处理一个实例时，需要在“总览 -> 详情 -> 配置 -> 总览”之间跳。
2. “配置”是顶级导航，但它实际依赖已选中的实例；如果用户直接点配置，会出现“请选择实例”的断层。
3. 实例详情页有日志和操作，但编辑配置入口不够自然，配置页也缺少实例上下文和返回路径。
4. 总览页承担了实例列表、资源汇总、创建入口、操作入口，信息密度高但缺少状态过滤、节点过滤和批量判断。
5. 节点页只管理节点本身，没有把“这个节点上有哪些实例、是否健康”直接呈现出来。
6. 高风险动作使用浏览器确认框，信息表达弱，也不能和页面风格统一。
7. 创建实例流程技术细节多，对新用户来说“节点、frps、代理、启动选项”的先后关系不够清楚。
8. 结构化配置和原始 TOML 的边界有风险：切换结构化编辑会重写代理段，自定义字段可能丢失，但视觉警示不够强。
9. 表格在移动端和窄屏上不友好，长配置路径、UUID、日志过滤控件容易挤压。
10. 空状态、加载状态、离线状态、Docker/Agent 错误分散在各页，没有统一的运维风险表达。

## 4. 改造原则

- 面向运维控制台，不做营销页。首屏必须直接可操作。
- 以“节点 -> 实例 -> 日志/配置/操作”的工作流组织信息。
- 保持当前 API 能力优先，不为第一版页面草稿假设新的后端能力。
- 高风险操作必须有明确对象、影响范围和二次确认。
- 结构化表单服务新手，原始 TOML 服务高级用户，二者边界必须清楚。
- 桌面端优先保证密集操作效率，移动端保证能查看状态和执行关键动作。
- 色彩克制：白/浅灰背景、深色文字、蓝色主操作、绿色正常、橙色警告、红色危险。

## 5. 推荐信息架构

建议将导航改为：

1. `仪表盘`：整体健康、异常入口、最近操作。
2. `实例`：全局实例工作台，替代当前总览里的实例表。
3. `节点`：节点生命周期和节点内实例状态。
4. `审计`：操作记录。
5. `系统`：账号、安全、Console/节点系统信息。

建议移除顶级 `配置` 导航。配置应成为实例详情里的 `配置` tab，或从实例行操作打开的右侧抽屉。

建议保留全局 `创建实例` 主按钮，但它不作为常驻导航项，而是放在顶部栏或实例页右上角。

## 6. 推荐页面方案

### 6.1 全局框架

布局：
- 左侧深色窄侧边栏，包含图标 + 文本导航，支持收起。
- 顶部栏显示当前页面标题、全局搜索/快捷定位、创建实例按钮、用户菜单。
- 主内容区最大宽度 1600px，使用紧凑的 8px 圆角面板和表格。
- 右侧可出现上下文抽屉，用于安装命令、危险确认、快速配置、节点详情。

视觉关键词：
- operations console, dense admin UI, light workspace, dark sidebar, compact status chips, no hero section, no decorative gradients.

### 6.2 仪表盘

首屏目标：一眼看到系统是否可用，快速进入异常实例或离线节点。

主要区域：
- 顶部健康条：在线节点 / 总节点、运行实例 / 总实例、异常实例、离线节点、最近失败操作。
- 中部两列：
  - 左侧“需要处理”：异常实例、离线节点、配置校验失败、最近失败操作。
  - 右侧“资源概览”：CPU、内存、节点磁盘占用排行。
- 下方“最近操作”：审计日志摘要，失败记录高亮。

交互：
- 点击异常实例进入实例详情。
- 点击离线节点进入节点详情/安装命令。
- 点击最近失败操作进入对应实例或节点。

生图提示词：
```text
Light operations dashboard for frpc multi-instance console, dark compact sidebar, top command bar with create instance button, health summary strip, issue queue table, node resource cards, recent audit table, Chinese UI labels, dense SaaS admin layout, 8px radius, blue primary actions, green/orange/red status chips, no marketing hero, no decorative blobs.
```

### 6.3 实例工作台

目标：成为日常使用最多的页面，用户可以查找、筛选、操作、进入详情。

主要区域：
- 顶部工具栏：
  - 搜索框：实例名、显示名、节点、远端端口。
  - 筛选：节点、状态、启用状态、代理类型。
  - 主按钮：创建实例。
- 状态分组 tab：全部、运行中、异常、已停止、已停用。
- 主表格：
  - 实例 / 节点 / 状态 / 启用 / frps / 代理数 / 远端端口 / CPU / 内存 / 重启 / 最近更新 / 操作。
  - 状态必须显示文字 + 色点，不只用色点。
  - 操作区固定：启动/停止、重启、日志、配置、更多。
- 右侧可选详情抽屉：
  - 点击行后不一定跳页，可先打开快速详情：状态、日志摘要、配置摘要、快捷操作。

移动端：
- 表格转为实例卡片列表。
- 每张卡片展示状态、节点、CPU/内存、主要端口，操作收进底部动作菜单。

生图提示词：
```text
Chinese instance management workspace for frpc console, compact data table, filters for node/status/enabled/proxy type, search by instance and port, status tabs, create instance primary button, rows with instance name, node, status label, enabled switch, frps endpoint, proxy count, remote ports, CPU memory restart count, icon action buttons, optional right detail drawer, utilitarian light admin UI.
```

### 6.4 实例详情页

目标：围绕一个实例完成“诊断 -> 看日志 -> 改配置 -> 重启”的闭环。

页面结构：
- 顶部对象头：
  - 返回实例列表。
  - 实例显示名、真实实例名、节点名、状态、启用状态。
  - 右侧主操作：启动/停止、重启、更多。
- 概览卡片：
  - CPU、内存、重启次数、容器状态、配置路径、frps 地址、代理数量、远端端口。
- tab：
  1. `日志`：实时跟随、行数、关键字、暂停/继续、清空视图。
  2. `配置`：结构化代理编辑 + 原始 TOML。
  3. `代理`：以表格方式列出代理，突出本地地址 -> 远端端口/域名。
  4. `操作记录`：过滤该实例相关审计。

建议：
- 日志区域保持深色代码块，但顶部控制条要更清晰。
- 配置 tab 中要强提示：结构化编辑只覆盖常用代理字段，高级字段请使用 TOML。
- 保存配置后重启容器使用开关，不要藏在按钮旁的小复选框里。

生图提示词：
```text
Instance detail page for frpc operations console, object header with instance name node status and action buttons, compact metric cards, tabbed content logs config proxies activity, dark terminal log viewer with follow toggle tail selector and keyword search, configuration validation side panel, structured proxy editor and raw TOML tab, Chinese labels, clean light admin design.
```

### 6.5 创建/编辑实例流程

目标：把技术表单改成可理解的配置流程，同时保留高级 TOML 能力。

推荐做成单页分段表单，不做多页向导：
- 左侧主表单，右侧固定“校验与将要执行”面板。
- 分段顺序：
  1. 基本信息：节点、实例名、显示名、描述。
  2. frps 连接：服务器地址、端口、认证 token。
  3. 代理配置：代理列表，每条代理可展开编辑。
  4. 启动选项：启用实例、创建后立即启动。
- 顶部模式切换：`表单模式` / `TOML 模式`。
- 右侧固定面板：
  - 校验状态。
  - 创建后动作：写入配置、生成 compose、启动容器。
  - 当前目标节点状态。
  - 预计代理数量和远端端口。

关键视觉要求：
- 节点选择要放在第一项，并显示节点在线/离线状态。
- 代理列表要像“规则列表”，每条代理显示 `tcp 127.0.0.1:22 -> :6001`。
- TOML 模式要有明显高级提示。

生图提示词：
```text
Create frpc instance page, single page segmented form, node selector with online status, instance name display name description, frps connection section, proxy rules list with expandable rows, start options toggles, right sticky validation and execution summary panel, form mode and raw TOML mode segmented control, Chinese labels, compact professional admin UI.
```

### 6.6 节点页

目标：节点不只是安装对象，也要体现它承载的实例健康。

主要区域：
- 顶部工具栏：创建节点、刷新。
- 节点表/卡片：
  - 名称、状态、实例总数、运行中、异常、最近在线、Agent 镜像/版本、磁盘占用。
  - 操作：安装命令、轮换密钥、升级 Agent、删除。
- 右侧抽屉或下方面板：
  - 安装命令详情。
  - 节点系统信息。
  - 该节点下实例列表摘要。

删除节点确认：
- 不使用浏览器确认框作为最终形态。
- 改成危险确认弹窗，展示会删除的实例数量和影响范围，要求输入节点名确认。

生图提示词：
```text
Node management page for Console Agent architecture, nodes table with online offline status, instance counts running stopped error, last seen, agent image version, disk usage, actions install command rotate secret upgrade agent delete, right drawer showing install command with copy button and node system info, Chinese admin UI, clear danger confirmation modal.
```

### 6.7 审计页

目标：让用户能追踪“谁对哪个节点/实例做了什么，是否成功”。

改造点：
- 增加筛选：时间范围、节点、实例、动作、成功/失败。
- 失败记录默认更醒目。
- 消息列支持展开查看完整错误。
- 从审计记录可以跳到对应实例或节点。

生图提示词：
```text
Audit log page for frpc console, dense filterable table, filters for date node instance action result, success and failure badges, expandable message column, links to node and instance, recent operations in Chinese, clean SaaS operations admin style.
```

### 6.8 系统页

目标：把系统信息和安全设置分区，减少当前单页混杂感。

结构：
- tab 或分区：
  1. `Console 信息`：版本、角色、地址、项目目录、节点数。
  2. `节点系统`：每个节点的 Docker/frpc/磁盘信息。
  3. `账号安全`：修改用户名和密码、会话有效期。
- 节点系统信息建议用表格或紧凑卡片，离线节点单独高亮。

生图提示词：
```text
System settings page for frpc multi instance console, tabs for Console info node systems account security, compact info lists, node system cards with docker version frpc image disk usage offline error states, password change form in right panel, Chinese labels, restrained admin UI.
```

## 7. 关键组件规范

- 状态徽标：必须同时有颜色和文字，例如“运行中”“异常”“离线”“已停用”。
- 开关：用于启用/停用实例、保存后重启、实时跟随。
- 分段控件：用于表单模式/TOML 模式、详情 tab。
- 图标按钮：启动、停止、重启、日志、配置、复制、刷新、删除使用 lucide 风格图标。
- 危险按钮：红色文字或红色描边，只有确认弹窗中的最终删除按钮才用强红色。
- 表格：行高紧凑，表头固定风格，数字使用等宽字体。
- 右侧抽屉：用于快速详情、安装命令、高风险确认前的信息查看。
- Toast：成功 3.5 秒，错误 6 秒，错误信息要保留可读细节。

## 8. 状态与空页面

需要在草稿中体现这些状态：
- 未创建节点：引导创建节点，并解释“Agent 主动连回主控”。
- 节点离线：实例状态不可用，提示检查 Agent 容器和主控地址。
- 没有实例：引导创建第一个实例。
- 配置校验失败：保存按钮禁用，右侧列出错误。
- 实时日志连接失败：日志区域内展示连接状态和重试入口。
- 远端端口/代理列表为空：展示空态，不要显示空白表格。

## 9. 首批草稿建议生成的画面

建议先生成 6 张桌面稿和 2 张移动稿：
1. 桌面 - 仪表盘。
2. 桌面 - 实例工作台。
3. 桌面 - 实例详情：日志 tab。
4. 桌面 - 实例详情：配置 tab。
5. 桌面 - 创建实例。
6. 桌面 - 节点页 + 安装命令抽屉。
7. 移动 - 实例工作台卡片列表。
8. 移动 - 实例详情日志页。

## 10. 后续实现边界

第一版前端升级建议不改后端 API，优先用现有接口重组页面：
- `/api/summary`
- `/api/nodes`
- `/api/nodes/{id}/instances/*`
- `/api/instances/*` 旧本机兼容路径
- `/api/audit-logs`
- `/api/console-info`
- `/api/auth/*`

需要后端扩展的能力可以放到第二批：
- 审计日志服务端筛选。
- 实例列表服务端分页。
- 按节点聚合系统资源缓存。
- 批量实例操作。
- 配置备份/恢复 UI。
- 告警设置 UI。
