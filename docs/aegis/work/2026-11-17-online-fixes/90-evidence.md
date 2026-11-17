# 验证记录

- 根因：线上使用 HTTP，5 处请求幂等键直接依赖 crypto.randomUUID；统一 createRequestId 在缺少该 API 时使用 getRandomValues 生成 UUID v4，不重建已经持久化的待提交/重试键。
- 用户确认：每台服务器只允许归属一个域名。候选增删和业务分组变更同事务；同步分组变化属于显式批量更新，独立候选集合仍是 DNS 候选事实来源。
- 事务验证：跨域名新增返回 409 且不改资产归属；成员新增移组、移除清组、后续人工改组保留；旧接口替换也校验归属并同步分组。存在旧重复成员时不静默删除，冲突路径有保护。低 SQLite 参数上限回归验证多项批次不会构造超限 IN 参数。
- 最终后端全量：424 项通过，70.184 秒。已同步安装项目原有 requirements.txt 中声明的 maxminddb；GeoIP 人工分组测试显式选择“生产”同步组，以保留原测试意图。
- 最终前端构建与 31 项 Vitest 通过；协调者 5 项浏览器回归通过，覆盖缺少 randomUUID 的冻结快照、批量更新、导入恢复，以及候选冲突与分组刷新。实现 Agent 另验证了 6 项 UUID 缺失/导入重试相关浏览器流程。
- 独立复审指出的旧接口约束绕过、分组删除竞争和 SQLite 批次参数问题均已修复并复测。发布前保留两份数据库备份及原运行镜像；连通性批次自然完成后才进入切换阶段。

## 线上发布

- [构建 44058244506](https://github.com/354770288/frpc-multi/actions/runs/44058244506) 成功；核对镜像 revision 为 b75b5587081e67c4815e9a62d7fe3f9a2a2f3247 后使用本地标签 frpc-multi:fixes-b75b558 切换 Console。容器 running，restart count 0，外网首页 HTTP 200。
- 保留旧镜像 frpc-multi:rollback-bugs-20261117（1f09b4e）和 /data/console-before-domain-group-final-20261117.db，权限 0600、integrity_check=ok。数据卷宿主目录 /var/lib/docker/volumes/frpc-multi-console_console-data/_data。回滚需要停止服务，先保存当前 DB，再恢复对应备份并启动旧镜像；本次未执行回滚。
- 网络禁用、数据卷只读的隔离预检验证资产 2,319、历史 3,179、发现 35,939、候选关系 18 条及 DNS 当前指向保持一致。自动审批拦截带临时清理选项的预检命令后，改用保留式容器完成验证；停止态 frpc-fixes-preflight-20261117 有意留作验证证据。
- 新服务启动后通过认证 API PATCH 将 us1.zmfrp.eu.org 的同步分组设为现有美国US1；实际候选归组结果按域名 ID 为：1/美国US1/9，2/香港1/2，3/欧洲EU1/2，4/国内CN/5。验证候选关系与当前 DNS 指向和发布备份一致，没有调用 DNS 同步或切换接口。
- 实库已安装 idx_lb_domain_servers_one_domain 唯一索引；候选分页、服务器游标和域名列表接口返回正常；部署静态资源 NodeControls-0SI7_hUq.js 包含 randomUUID/getRandomValues 兼容实现。浏览器中 API 缺失时的交互与重试由前述 Playwright 验证，本次生产验收检查 HTTP、认证 API、静态产物与数据库。
