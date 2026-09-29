# Beta 依赖安全审计评估

评估日期：2026-09-29。执行 `npm audit --json` 与 `npm audit --omit=dev --json`，未执行 `npm audit fix` 或 `npm audit fix --force`。生产依赖审计结果不是零漏洞：212 个生产依赖中共有 3 个条目，严重级别为 1 个 high、2 个 moderate、0 个 critical。

## 已知条目与处置

| 依赖链 | 公告 | 评估与现有控制 | 发布处置 |
|---|---|---|---|
| 直接依赖 `extract-zip@2.0.1` | GHSA-jmr9-qjv8-65gv、GHSA-7pqw-9j4j-h8q3；high；npm 当前无修复版本 | 仅用于用户主动选择的备份恢复。在调用 `extract()` 前，`restore-service.ts` 独立读取中央目录，拒绝绝对路径、`..`、盘符、ADS、空段、保留名、大小写/Unicode 冲突、目录、符号链接、特殊文件、加密项，并执行数量、单项/总大小、压缩比边界。解压只进入新建随机 staging，随后按清单白名单、真实路径、大小和 SHA-256 再验证；失败会删除 staging。`tampered-backup.test.ts` 覆盖穿越、符号链接、特殊项、碰撞、额外项和边界。 | 接受为有明确补偿控制的残余 high 风险；上游出现兼容修复后优先升级，并保留恶意归档回归。不能把此项描述为“已修复”或“审计干净”。 |
| `exceljs@4.4.0 > uuid@8.3.2` | GHSA-w5hq-g745-h8pq；moderate | 公告影响调用者向 UUID v3/v5/v6 传入自定义 buffer 时的边界检查。应用只通过 ExcelJS 解析/生成导入模板，没有直接导入或调用 `uuid`，也没有把外部 buffer 传给这些 UUID API。 | npm 建议的自动方案是把 ExcelJS 降到 3.4.0（标记为 SemVer-major），可能破坏已验证的导入安全边界，因此不自动应用。跟踪 ExcelJS 的兼容升级。 |

## 判定

自动安全门禁、恶意备份测试和实际安装包 SQLite 烟测通过，且没有 critical 公告；但上述 high 残余风险仍需在发布批准中显式接受。此评估不替代后续依赖升级，也不把“存在补偿控制”表述成漏洞消失。
