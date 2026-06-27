# Grandpa's New Ears

中文工作名：爷爷的新耳朵

Grandpa's New Ears 是一款面向听障人士、听力下降老人及其家人的实时字幕应用。核心体验很简单：用户打开自己的手机或平板，对方开始说话，屏幕上立即出现清晰、足够大的文字。

## 核心方向

- 面对面谈话实时转文字。
- 大字号、高对比度、低干扰的字幕阅读体验。
- 可选翻译能力，支持跨语言沟通。
- 默认不保存对话，只有用户明确选择时才保存。
- 先用移动端网页或 PWA 快速验证，再根据反馈决定是否做原生 App。

## 当前项目状态

当前仓库先建立产品规划底稿，后续设计、研发、用户访谈和技术选型都围绕这些文档继续迭代。

## 第一版

当前第一版是一个静态 PWA 原型，已经包含：

- 实时字幕主界面。
- 浏览器内置语音识别接入。
- 讲话语言选择。
- 字号切换。
- 高对比度模式。
- 可选择保存的本地历史记录。
- PWA manifest 和离线缓存。

翻译界面已经预留，真实翻译接口将在后端服务接入后启用。

## 在线测试

GitHub Pages：

```text
https://ruipls.github.io/grandpas-new-ears/
```

健康检查页：

```text
https://ruipls.github.io/grandpas-new-ears/health.html
```

如果某台 Android 设备打不开主页面，先打开健康检查页判断是网络入口问题，还是应用脚本/缓存问题。

## 本地运行

在项目目录启动一个本地静态服务：

```bash
python3 -m http.server 4173
```

然后打开：

```text
http://localhost:4173
```

语音识别依赖浏览器支持，建议先用 Chrome 或 Edge 在 localhost / HTTPS 环境下测试。

## 构建发布包

```bash
npm run icons
npm run build
```

生成的 `dist/` 目录只包含网页应用运行所需文件，可部署到 GitHub Pages、Cloudflare Pages 或其他静态托管服务。

## 文档

- [初步核心方案](docs/CORE_PLAN.md)
- [产品需求文档 PRD](docs/PRD.md)
- [项目路线图](docs/ROADMAP.md)
- [第一版实现说明](docs/V1_IMPLEMENTATION.md)
