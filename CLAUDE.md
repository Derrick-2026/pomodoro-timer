# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                # 开发模式运行（Electron）
npm run package          # 打包为 macOS .app（输出到 dist/番茄钟-darwin-arm64/）
```

打包后更新 .app 内文件（无需重新打包）：
```bash
npx asar extract dist/番茄钟-darwin-arm64/番茄钟.app/Contents/Resources/app.asar /tmp/asar-out
# 修改 /tmp/asar-out/ 内的文件
npx asar pack /tmp/asar-out dist/番茄钟-darwin-arm64/番茄钟.app/Contents/Resources/app.asar
```

## Architecture

这是一个 Electron 桌面番茄钟，无构建工具，源文件直接运行。

**进程分工：**
- `main.js` — 主进程：创建 BrowserWindow（400×600，无边框），处理系统通知（`timer-complete`）和窗口控制（`window-close` / `window-minimize`）IPC 消息
- `renderer.js` — 渲染进程：全部计时逻辑、UI 状态、Web Audio API 音效
- `index.html` + `styles.css` — 界面结构与样式，无框架

**IPC 通信（renderer → main）：**
| 消息 | 触发时机 |
|------|---------|
| `timer-complete` | 倒计时归零，携带 mode 参数（work/short/long） |
| `window-close` | 用户点击自定义关闭按钮 |
| `window-minimize` | 用户点击自定义最小化按钮 |

**计时器状态机（renderer.js）：**
- 模式循环：work → short（每次）/ long（每 `CYCLE_LENGTH=4` 个番茄）→ work
- 进度圆环：SVG `stroke-dashoffset` 动画，`CIRCUMFERENCE = 2π×96 ≈ 603`
- 主题切换：`body.className = mode-{work|short|long}`，CSS 变量 `--accent` 随之切换
- 音效：Web Audio API 振荡器，work 结束上行音阶，休息结束下行音阶

**打包：**
- 使用 `@electron/packager`（非 `electron-packager` v17，后者有静默挂起 bug）
- 图标：`icon.icns`（macOS 专用），已内嵌到 .app bundle
