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

NSIS 身份锁定为当前 `appId` 已派生并经实际注册信息复核的 GUID `d1a51a1d-1566-5e0e-9cfa-31a4c775b234`。发布包不创建桌面或开始菜单快捷方式。安装烟测在执行前和卸载后都检查 HKCU/HKLM 的 32/64 位 install/uninstall 注册键；安装后还必须实际观察预期 HKCU install/uninstall 键，并验证 `InstallLocation`、`UninstallString` 与 `QuietUninstallString` 精确指向受控临时安装根。发现已有同身份安装即停止，禁止覆盖真实安装。

安装烟测在隔离 APPDATA/LOCALAPPDATA/USERPROFILE 的同时，对隔离目录、真实用户桌面/开始菜单、公共桌面和机器开始菜单做安装前后只读差分；脚本不删除任何快捷方式。清理状态机只有在 exact uninstaller 成功、临时 install root 消失、全部预期注册键清零后才删除总临时目录。安装器、应用或卸载器超时/非零退出时保留可恢复现场，并把 exact uninstaller、注册键和恢复顺序写入 `packaged-smoke-recovery-report.json`。

安全 E2E 对备份 ZIP 的每个 entry 在 entry 数量、单项/总解压大小、压缩比、路径和加密状态边界内实际解压，再分别扫描 UTF-8/UTF-16 明文 sentinel；扫描压缩容器的原始字节不能替代此项。

性能发布证据必须在 Windows 上运行 `npm run performance:constrained`。该运行器把 Node 进程固定到 affinity mask `0x0000000f`（4 个逻辑核），用 `--max-old-space-size=6144` 将堆限制在 8GB 以下，并在报告中记录约束声明与 V8 实测堆上限。200 次关系样本必须走生产 `QueryToolRegistry`，且覆盖 direct 30、ancestor 25、collateral 30、cousin 25、affinity 30、multipath 25、conflict 15、missing 20；3 次导入样本分别对真实落盘的 1000 行 CSV、XLSX、CSV 执行生产解析器和计划预览。不得改小样本数或放宽既有阈值。

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
