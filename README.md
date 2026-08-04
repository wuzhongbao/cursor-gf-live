# Cursor GF Live

Cursor 侧栏「赛博女友」动态角色扩展。角色随 Agent Hooks 在  
`idle / listening / speaking / working / approval / done` 之间切换。

非官方第三方扩展，不修改 Cursor 安装包。

**最新版本：** [v0.3.15](https://github.com/wuzhongbao/cursor-gf-live/releases/latest)

## 功能

- 右侧 Activity Bar 常驻 **GF Live** 面板
- 两套角色包：`深色赛博` / `暖白女友`（每状态循环动画）
- 自动跟随 Cursor Agent Hooks
- 手动状态覆盖 + 一键恢复自动
- 本地 `127.0.0.1` 事件桥，fail-open（不影响 Agent）
- Edge 神经女声朗读 Agent 回复 + 卡拉 OK 字幕

## 安装（推荐）

1. 打开 [Releases](https://github.com/wuzhongbao/cursor-gf-live/releases/latest)，下载 `cursor-gf-live-*.vsix`
2. Cursor 命令面板：`Extensions: Install from VSIX…`，选中该文件  
   或：

```powershell
cursor --install-extension .\cursor-gf-live-0.3.15.vsix
```

3. 重新加载窗口后，左侧应出现 **GF Live** 图标
4. 打开面板，点击 **安装 / 修复 Hooks**
5. 新开一轮 Agent 对话，观察角色状态变化

## 从源码打包

```powershell
git clone https://github.com/wuzhongbao/cursor-gf-live.git
cd cursor-gf-live
npm install
npm run compile
npm run package
```

## 语音朗读

默认使用 **Edge 神经女声**（需联网）：

- 默认：晓晓 · 温柔甜妹
- 侧栏可切换：晓伊 / 晓辰 / 晓涵 / 晓梦 / 晓萱 / 晓柔 / 晓甄
- 点 **试听** 先听效果；失败时回退系统语音

设置项：`gfLive.voiceEnabled` / `gfLive.voiceId` / `gfLive.voiceRate` / `gfLive.voicePitch` / `gfLive.voiceMaxChars`

## 使用

| 操作 | 说明 |
|------|------|
| 点击状态 pills | 手动切换状态（进入手动模式） |
| 恢复自动 | 继续跟随 Hooks |
| 角色包下拉 | 切换深色赛博 / 暖白女友 |
| Open Character Folder | 打开素材目录，可替换同名媒体文件 |

### 状态映射

| Hook 事件 | 角色状态 |
|-----------|----------|
| `beforeSubmitPrompt` / `sessionStart` | listening |
| `afterAgentThought` / `afterAgentResponse` | speaking |
| `preToolUse` / `afterFileEdit` / shell / MCP | working |
| 含 permission/ask 线索的工具事件 | approval |
| `stop` / `sessionEnd` | done → idle |
| 空闲超时（默认 8s） | idle |

## 配置

```json
{
  "gfLive.port": 39217,
  "gfLive.idleTimeoutMs": 8000,
  "gfLive.doneHoldMs": 2500,
  "gfLive.defaultPack": "dark-cyber",
  "gfLive.autoFollowTheme": true
}
```

## 卸载 Hooks

命令：`GF Live: Uninstall Hooks`  
只会移除带 `cursor-gf-live` / `gf-live-bridge` 标记的条目，保留你其他 hooks。

## 排障

**面板没有图标**  
确认扩展已启用，执行 `GF Live: Show Panel`。

**Hooks 显示未安装**  
点面板里的「安装 / 修复 Hooks」。检查 `%USERPROFILE%\.cursor\hooks.json` 是否含 `gf-live-bridge`。

**已安装但不跳状态**  
1. 确认扩展已激活（事件服务在监听）。  
2. 看面板「最近事件」是否更新。  
3. 手动测通：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:39217/event -ContentType application/json -Body '{"hook_event_name":"preToolUse"}'
```

## 请我喝杯咖啡

如果这个扩展对你有帮助，欢迎支持继续维护：

- GitHub Sponsors：（开通后填链接）
- 爱发电：（开通后填链接）
- 微信 / 支付宝：把收款码放到 `media/donate/`，在此贴图即可

## 许可与声明

- 代码：MIT（见 [LICENSE](./LICENSE)）
- 角色动画素材可能来源于第三方演示资源，**请自行评估公开分发的版权风险**；可替换为自有素材
- 与 OpenAI CodexGF Live / Codex QQ Skin / Cursor 官方无隶属关系
