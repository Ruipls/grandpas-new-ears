# 当前工作状态

更新日期：2026-06-29

## 当前线上版本

- GitHub 仓库：`https://github.com/Ruipls/grandpas-new-ears`
- 当前开发分支：`UIimprove`
- GitHub Pages 发布源：`UIimprove` 分支，根目录 `/`
- 最新测试链接：`https://ruipls.github.io/grandpas-new-ears/?v=20260629-live1`
- 当前应用版本标记：`20260629-live1`
- 当前 service worker 缓存：`grandpas-new-ears-v7`

## 已完成进展

- 建立产品初步核心方案、PRD、路线图和第一版实现说明。
- 完成静态 PWA 原型，可通过 GitHub Pages 在手机浏览器访问。
- 接入浏览器内置 `SpeechRecognition` / `webkitSpeechRecognition` 做实时语音识别。
- 完成实时大字字幕主界面、开始/暂停/结束控制、讲话语言选择、字号切换和高对比度模式。
- 取消“小临时字幕框”和“最终大字字幕”的两态分离：说话过程中，实时识别文本直接显示为主字幕区最后一条大字字幕；停顿后只负责确认文本。
- 处理字幕区增长问题：字幕在主对话区域内部滚动，不再把整个页面向下撑开。
- 隐藏会遮挡字幕的常驻欢迎语：开始会话或已有字幕后，空状态不再显示。
- 增加设置区和已保存对话区的展开/收起指示 icon。
- 增加 PWA manifest、PNG 图标、service worker、健康检查页和构建脚本。
- GitHub Pages 已从 `main` 切换到 `UIimprove`，方便继续做 UI 迭代和手机测试。

## 当前边界

- 翻译功能仍是界面预留，真实翻译接口尚未接入。
- 语音识别依赖浏览器能力；不同 Android 浏览器、系统版本和网络环境可能表现不一致。
- 当前没有后端流式识别网关，无法保证跨浏览器稳定识别能力。
- 保存记录只存在用户本机浏览器的 `localStorage`，没有账号和云同步。
- Cloudflare Pages 第二入口尚未完成；之前阻塞点是 Cloudflare 账号邮箱需要先验证。

## 下次继续时优先事项

1. 在 Android Chrome、Android Edge、iPhone Safari 上实际测试 `20260629-live1` 版本的实时大字字幕。
2. 继续 UI 优化：主字幕阅读区层级、控制区压缩、按钮图标化、颜色和间距系统化。
3. 为移动端补一轮视觉回归检查，重点看小屏横竖屏、超大字号、高对比度和长句换行。
4. 完成第二发布入口，优先 Cloudflare Pages；若面向中国大陆网络，再评估合规云厂商和 CDN。
5. 设计后端流式识别/翻译方案，替代单纯依赖浏览器内置识别的当前实现。

## 恢复工作清单

```bash
git checkout UIimprove
git pull origin UIimprove
npm run check
npm run build
```

恢复后先阅读本文件，再阅读：

- `docs/PRD.md`
- `docs/ROADMAP.md`
- `docs/V1_IMPLEMENTATION.md`
- `docs/DEPLOYMENT.md`
