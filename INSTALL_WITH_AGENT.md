# 让 Agent 自动安装 GLB Label Editor

将下面整段 Prompt 发给具备本机终端权限的 Codex 或其他 Agent：

```text
请安装 GLB Label Editor Codex 插件。

安装来源：https://github.com/rendylong/label-editer

执行前请说明这次安装会：
1. 下载插件源码、锁定依赖和 Playwright Chromium；
2. 将可运行插件安装到 ~/.codex/glb-label-editor；
3. 添加 label-editer marketplace，并启用 glb-label-editor@label-editer。

在权限允许后，执行：
commit="$(node --input-type=module -e 'const response = await fetch("https://api.github.com/repos/rendylong/label-editer/commits/main"); if (!response.ok) throw new Error("GitHub returned " + response.status); process.stdout.write((await response.json()).sha)')" &&
npx --yes --package="https://github.com/rendylong/label-editer/archive/$commit.tar.gz" glb-label-editor-install

完成后运行 codex plugin list --json，确认 glb-label-editor@label-editer 的 installed 和 enabled 都为 true。
再运行 ~/.codex/glb-label-editor/plugin/bin/label-cli.mjs schema --json，确认纯本地 CLI 返回 ok: true，且安装目录没有生成 .mcp.json。
最后运行 codex mcp list --json，确认结果中不存在名为 glb-label-editor 的服务器；如果仍存在，安装必须视为失败。
如果当前会话还看不到 Skill，请明确告诉我新建一个 Codex 会话，不要把旧会话未刷新误判成安装失败。
如果任何命令失败，请保留原始错误并停止，不要改用 curl | sh，也不要静默忽略依赖、构建或 Chromium 安装失败。
```

Agent 必须具备网络访问、执行本地命令以及修改用户 Codex 配置的权限。安装器只管理 `~/.codex/glb-label-editor`，不会修改用户项目。
