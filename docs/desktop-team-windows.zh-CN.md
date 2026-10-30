# Windows 11 桌面 Agent 协作：中文安装与使用说明

[English](desktop-team-windows.md) · **简体中文** · [项目仓库](https://github.com/wind-rich/codex-mcp-bridge)

本扩展让 **Codex 桌面端**或 **Claude 桌面端的 Code 页签**担任主脑，向另一个桌面端和 **WorkBuddy 已打开的桌面会话**派发任务，并收集结果、独立验收。

各个执行端使用自己的原生桌面会话、上下文、模型和工具权限。安装时会使用命令行做配置注册，任务不会因此改由独立的 CLI Agent 执行。

**当前是开发版：自动化测试已通过，新增 WorkBuddy 适配和主脑选择仍待真实 Windows 11 桌面环境联调。** 看到工具列表不等于已经确认桌面投递成功，正式使用前请完成下文的首次验收。

## 1. 选择谁当主脑

| 安装选项 | 主脑 | 可以调度的执行端 |
| --- | --- | --- |
| `--manager codex` | Codex 桌面端 | Claude Desktop Code、WorkBuddy |
| `--manager claude` | Claude Desktop Code | Codex 桌面端、WorkBuddy |
| `--manager both` | 从哪个桌面端发起任务，就由哪个负责 | 另一个桌面端、WorkBuddy |

默认模式是 `codex`。日常希望自由选择，建议安装为 `both`：想让 Claude 负责，就在 Claude 的 Code 页签提出任务；想让 Codex 负责，就在 Codex 桌面端提出任务。

主脑负责理解需求、分工、收集证据和最终验收。这个选项配置的是桌面工具入口，不是在另一个客户端里替换底层模型，也不是操作系统级的角色隔离。

**切换只影响后续任务。** 正在执行的任务仍归原主脑和原会话所有，不会自动迁移或被另一边接管。两边共用任务回执和会话锁，防止同时向同一个 WorkBuddy 会话派发冲突任务。

## 2. 准备条件

- 原生 Windows 11。
- 已安装并登录 Codex Desktop、Claude Desktop 和 WorkBuddy。
- Claude 使用本机 **Code 页签**；普通 Chat 和 Cowork 不在本扩展的支持范围内。
- Node.js **22.13 或更新版本**，Windows 上建议使用 **24.19 或更新版本**。
- 上游安装脚本需要的厂商管理 CLI 可在 `PATH` 中找到。这些命令用于注册 MCP，不作为执行任务的替代 Agent。
- 参与协作的桌面会话打开同一个现有项目目录。
- 本机允许使用 Windows PowerShell 查询进程和 `Get-NetTCPConnection`。
- WorkBuddy 的目标会话已打开，并且已完成一轮普通对话，原生记录能够确认其处于空闲状态。

WorkBuddy 默认配置目录是用户目录下的 `.workbuddy`。使用其他配置目录时，需要显式设置绝对路径，见下文。

WorkBuddy 使用的是实测过的本机私有 ACP 接口，接口可能随版本变化。当前不承诺所有版本均兼容。适配器不会从认证文件提取登录 Token；连接时由原生本地接口提供临时凭证，该凭证仅保存在传输客户端内存中。

## 3. 下载这个 fork

有 Git 时，在 PowerShell 中执行：

```powershell
git clone https://github.com/wind-rich/codex-mcp-bridge.git
cd codex-mcp-bridge
```

也可以在[仓库页面](https://github.com/wind-rich/codex-mcp-bridge)点击 **Code → Download ZIP**，完整解压到一个长期保留的目录，再在该目录打开 PowerShell。

**请使用这个 fork 的源码安装。** 上游 npm 包不能据此认为已经包含新增的 WorkBuddy 和主脑选择功能。

## 4. 安装双入口模式

先结束正在进行的桌面任务。在包含 `package.json` 的仓库根目录执行：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
node scripts/install-desktop-team.mjs --manager both --dry-run
node scripts/install-desktop-team.mjs --manager both
```

- `--dry-run` 只显示计划，不修改应用配置。
- 最后一条命令才执行注册和安装。
- 安装完成后，在现有工作结束的前提下，完整退出并重启 Codex Desktop 和 Claude Desktop，让会话加载新的 MCP 工具。

安装器会配置：

| 配置项 | 用途 |
| --- | --- |
| Codex 原生 relay | 向真实 Codex 桌面任务投递消息 |
| Codex 侧 `claude-bridge` | Codex 调度 Claude，按主脑选项启用 WorkBuddy 工具 |
| Claude 用户配置 `~/.claude.json` 中的 `codex-bridge` | Claude Code 页签调度 Codex，按主脑选项启用 WorkBuddy 工具 |
| `~/.agents/skills/desktop-team/` | Codex 主脑协作指引 |
| `~/.claude/skills/desktop-team/` | Claude 主脑协作指引 |

`~` 表示当前 Windows 用户的主目录。安装器保留已有无关配置和权限，并为已有 Claude 配置创建备份。它不会安装或修改厂商应用包、调整工具审批模式、自动调用模型、创建定时任务，或注册开机启动。管理桥接注册会关闭其用量遥测。原生 relay 安装使用 `--no-bootstrap`，不为安装而启动独立 app-server。

如果安装中途失败，之前完成的注册步骤可能仍然存在。先处理报错，再重复执行同一安装命令；不要为了消除错误而清空全部应用配置。

### 只让一个客户端当主脑

下面两条按需选择一条，不需要全部执行：

```powershell
# 仅启用 Claude 主脑入口
node scripts/install-desktop-team.mjs --manager claude

# 仅启用 Codex 主脑入口
node scripts/install-desktop-team.mjs --manager codex
```

需要恢复双入口时，重新执行 `--manager both`。切换前先结束当前协作任务，切换后重启两个桌面客户端。

### 自定义 WorkBuddy 配置目录

把下面的示例路径替换为你的实际配置目录，再执行安装：

```powershell
$env:WORKBUDDY_PROFILE_DIR = 'C:\Path\To\WorkBuddyProfile'
node scripts/install-desktop-team.mjs --manager both --dry-run
node scripts/install-desktop-team.mjs --manager both
```

这里填写的是 WorkBuddy 配置目录，不是应用安装目录，也不是项目代码目录。

## 5. 首次验收：先确认三个窗口确实连通

1. 在三个桌面客户端中打开同一个项目，打开希望参与协作的目标会话。
2. 在 WorkBuddy 的目标会话完成一轮普通对话，再等待它空闲。
3. 从选定的主脑检查连接：

   | 检查内容 | Codex 主脑 | Claude 主脑 |
   | --- | --- | --- |
   | 另一个桌面端的桥接状态 | `claude_bridge_status` | `codex_bridge_status` |
   | 另一个桌面端的任务列表 | `list_claude_sessions` | `list_codex_threads` |
   | WorkBuddy 适配状态 | `workbuddy_bridge_status` | `workbuddy_bridge_status` |
   | WorkBuddy 会话列表 | `list_workbuddy_sessions` | `list_workbuddy_sessions` |

4. 检查返回的主脑类型、原生任务或会话 ID、项目目录是否与预期窗口一致，确认桥接运行于 Desktop-only 模式。
5. 给 WorkBuddy 分配一次范围很小的只读测试，例如要求它回复一个唯一测试词和当前项目目录。只派发一次，保留同一个 `requestId`。
6. 用 `read_workbuddy_delivery` 读取该任务，等待终态；同时确认消息和回复出现在指定 WorkBuddy 窗口中。
7. 对另一个桌面端做同样的只读验证：Codex 主脑使用 Claude 投递工具；Claude 主脑使用 Codex 投递和回复读取工具。
8. 两条通路都确认后，再开始文件修改或较长任务。

这些真实测试会使用各自账号的正常模型额度；安装器没有替你运行这些测试。

如果 Claude 的原生身份识别失败，已有的共享 Desktop MCP 配置可能遮住用户级 Code 配置，可参考[上游 Windows 配置说明](new-windows-setup.md)。不要把普通 Chat 中能看到 MCP 当作 Code 页签身份已验证。

## 6. 日常使用示例

在 Codex 中使用 `$desktop-team`；在 Claude 的 Code 页签中使用 `/desktop-team`。也可以直接说明分工要求，让当前客户端按协作指引工作。

例如，安装双入口后，在任一主脑客户端提出：

> 你作为这次任务的主脑。先确认另外两个桌面会话都属于当前项目，再拆分任务：让另一个桌面 Agent 做代码审查，让 WorkBuddy 做资料核对。先只读，不修改文件。收集两边的证据后由你独立复查，最后汇总结果。遇到结果未知时不要重复派发。

需要写代码时，应说明允许修改的文件、验收标准和要运行的检查。独立的只读调查可以并行；修改同一份工作目录应串行进行，或者提前准备不同的 worktree，避免互相覆盖。

## 7. WorkBuddy 工具与任务状态

| 工具 | 用途 |
| --- | --- |
| `workbuddy_bridge_status` | 查看实验性适配状态、当前主脑和配置目录就绪情况 |
| `list_workbuddy_sessions` | 列出当前主脑项目中的现有原生交互会话 |
| `send_to_workbuddy_session` | 使用 `{ requestId, sessionId, prompt }` 派发一次任务 |
| `read_workbuddy_delivery` | 使用原始 `{ requestId }` 读取回执和结果，不重发任务 |

| 状态 | 含义 |
| --- | --- |
| `pending` | 已建立回执，仍在预检或准备发送 |
| `submitted` | 已进入投递阶段，不能据此认定执行结束 |
| `completed` | 收到可识别的原生终态；仍需主脑独立验收 |
| `failed` | 预检失败或原生接口明确报告失败 |
| `unknown` | 无法可靠确认结果，应检查原会话，禁止直接重发 |

一次有意派发的任务使用一个稳定 UUID 作为 `requestId`。查看或重试检查时沿用原 ID，不要通过更换 UUID 让同一任务再次执行。空回复、窗口打开或收到传输回执，都不能单独证明任务完成。

## 8. 回执、断线和常见问题

默认回执目录是 `~/.codex/desktop-team/workbuddy/`；配置了 `CODEX_HOME` 时按该安装使用的路径保存。`WORKBUDDY_BRIDGE_STATE_DIR` 可以指定绝对路径，安装器会将同一目录传给两种主脑。所有使用同一个 WorkBuddy 配置的主脑必须共用这份回执和会话锁。

回执保存任务 ID、主脑类型和会话 ID、目录、摘要哈希、时间和有长度限制的回复，不保存临时 ACP 凭证或原始任务正文。WorkBuddy 自身的原生历史仍会包含任务正文。

| 现象 | 处理方式 |
| --- | --- |
| 看不到新增工具 | 确认使用这个 fork 安装，并在现有任务结束后完整退出、重启对应桌面客户端 |
| WorkBuddy 会话列表为空 | 打开预期会话，确认项目目录一致，并完成一轮普通对话；核对配置目录 |
| 会话显示 `busy` 或 `unknown` | 等待原生会话空闲；未知格式不能视作空闲，不要强行换入口派发 |
| WorkBuddy 要求批准工具操作 | 在 WorkBuddy 自己的界面处理，桥接器不会自动批准 |
| 超时或断线后结果未知 | 查看原生会话和原始回执，不重复发送，也不创建替代任务 |
| 提示上一任务仍占用会话 | 先核对那次任务和回执，不能直接删除全部锁文件 |

确认未知任务已经结束后，如确有需要，由使用者保留原始回执，仅将对应会话的 `.lock` 文件移到回执目录外归档，再有意分配新的工作。没有供模型调用的强制解锁接口。

观察 HTTP 消息流的总时限为 30 分钟。超时不等于取消 WorkBuddy 原生任务。主脑 MCP 进程关闭或重启后，不能自动续接原观察任务，可能留下 `unknown` 回执。

## 9. 当前支持边界与测试结果

目前没有实现：向空闲主脑会话自动推送完成通知、WorkBuddy 任务取消、崩溃后恢复结果观察、跨账号会话身份核对、截图验证、自动激活已关闭的会话，以及正在执行任务的主脑迁移。

WorkBuddy 发现依赖私有协议、进程归属和本地会话记录；需要确认原生 Desktop 进程祖先，且目标工作进程只有一个可识别的本地监听端口。归属不清、端口有歧义或状态未知时会停止派发。它不会自行换成另一个会话、隐藏运行时或 CLI Agent。

截至 2026-10-30，在 Linux / Node.js 24.19.0 开发环境中完成：

- 新增扩展测试 **32 项通过**，包含两侧实际 stdio MCP 入口、主脑选择、跨主脑回执隔离、共享会话锁和旧 Codex 回执兼容。
- 完整回归 **1,764 项：1,731 通过，0 失败，33 项因平台条件跳过**。
- 安装预览、源码语法和打包内容检查通过。

测试使用临时目录和本机 ACP 模拟服务，没有启动你的厂商桌面应用，也没有调用你的模型账号。上游已有的 Windows 验证记录不能代替这次新增功能的实机验收；当前没有宣称已验证任意 WorkBuddy 版本或真实 GUI 投递。

## 10. 更新

使用 Git 克隆的用户，在当前协作任务结束后执行：

```powershell
git pull --ff-only
npm.cmd ci --ignore-scripts --no-audit --no-fund
node scripts/install-desktop-team.mjs --manager both --dry-run
node scripts/install-desktop-team.mjs --manager both
```

如果你使用单一主脑，将上面的 `both` 换成原来选择的 `claude` 或 `codex`。更新后重启两个桌面客户端，并重新核对工具和原生会话。ZIP 用户可重新下载源码，解压到长期保留的目录后再安装；不要在不核对路径的情况下删除旧回执。
