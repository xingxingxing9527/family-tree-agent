# Beta 发布边界与证据

本文件定义 Task 15 的可审计发布边界。机器生成的哈希、性能和安装烟测结果写入 `release/reports/`，不纳入源码提交；人工易用性结论只记录在 `user-acceptance-checklist.md` 的真实测试副本中。

## 明确不在 Beta 范围内

- 账号、登录、权限角色或多人协作服务
- 云同步、云备份或跨设备自动复制
- 收养、继亲等尚未建模的亲属事实
- 方言称谓包或普通话以外的规则包
- 历史时点（as-of）关系查询
- 本地大模型、模型权重或离线模型安装器
- 应用自定义密码、加密备份或“备份已加密”的声明

构建扫描不得发现上述能力的实现载荷，也不得包含测试、fixture、source map、`.env`、本地工作区数据库、缓存、日志、覆盖率目录或用户数据。

原生 SQLite 依赖仍由 `postinstall` 中的 `electron-builder install-app-deps` 负责开发安装期重建，并从 ASAR 解包。当前发布主机没有系统级 MSVC Build Tools，且不允许为发布任务安装它；因此打包阶段关闭重复 rebuild，封装已在 Electron 44 E2E 中验证可加载的二进制。实际安装包烟测必须再用安装后的 EXE 完成 SQLite 建库、写入、关闭和重开，方可接受该包。

NSIS 身份锁定为当前 `appId` 已派生并经实际注册信息复核的 GUID `d1a51a1d-1566-5e0e-9cfa-31a4c775b234`。发布包不创建桌面或开始菜单快捷方式。安装烟测在执行前和卸载后都检查 HKCU/HKLM 的 32/64 位 install/uninstall 注册键；发现已有同身份安装即停止，禁止覆盖真实安装。

## 发布证据与判定

| 证据 | 生成位置 | 自动门禁 |
|---|---|---|
| NSIS x64 安装包及 SHA-256 | `release/`、`release/reports/artifact-sha256.txt` | 是 |
| 单元/集成测试与覆盖率 | 命令输出、`coverage/coverage-summary.json` | 是 |
| Electron 安全边界 E2E | Playwright 命令输出 | 是 |
| 1000 人性能报告 | `release/reports/performance-report.json` | 是 |
| 实际安装/重开/卸载报告 | `release/reports/packaged-smoke-report.json` | 是 |
| 依赖漏洞及补偿控制评估 | `docs/security-audit-assessment.md` | 人工风险接受 |
| 中文易用性验收 | `docs/user-acceptance-checklist.md` 的测试副本 | **人工，当前待完成** |

范围核查以应用源码、`out/` 生产 bundle、ASAR 条目和 DesktopApi 可达能力为准。OpenAI 官方 SDK 依赖自身包含未被应用接线的 admin/service-account 客户端文件；它们不构成本应用的账号功能，预加载 API 也不暴露这些入口。应用代码与生产 bundle 不包含账号/登录、云同步、收养/继亲事实、方言包、历史时点查询、本地模型权重、应用密码或“备份已加密”功能/声明。

只有自动门禁全部通过、已知依赖风险得到发布负责人接受，且独立测试者真实完成 10 分钟易用性门禁后，才可宣称 Beta 发布验收完成。
