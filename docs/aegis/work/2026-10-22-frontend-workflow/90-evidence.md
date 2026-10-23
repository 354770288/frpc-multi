# 前端流程重组 - Evidence

本文件记录本地验证与生产部署的执行证据；判定边界和未覆盖项见末尾。

## EvidenceBundleDraft

- Artifact key: local-verification
- Type: test
- Source: frontend Vitest and Playwright; backend unittest; isolated production backup
- Summary: 250项后端回归、3项Vitest、11项Playwright、前端构建通过；真实备份2319资产2392连通历史19555审计；分页耗时14ms与小于1ms、integrity ok；副本已清理
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: production-rollout
- Type: deployment
- Source: GitHub Actions 39895272783; Console 23.19.228.204:8081; verified backup /var/lib/docker/volumes/frpc-multi-console_console-data/_data/console-before-frontend-workflow-20261023.db
- Summary: 提交88663b4的多架构镜像构建成功并部署。主控镜像revision与提交一致，DB备份integrity ok、权限0600，回滚标签指向旧da8603c镜像。实库迁移隔离容器验证2319资产、19555审计，page32ms/all-status39ms/dashboard31ms；验收后删除临时容器。生产API和前端返回正常，活跃任务0、资产2319、发现35939、域名4；测试节点2/2在线，管理Agent3/3在线，实例3/3运行。浏览器已核验任务历史分页、双节点8阶段结果、来源对比、域名观测和工作台；业务域名指向与备份一致。
- Verifier: coordinator
