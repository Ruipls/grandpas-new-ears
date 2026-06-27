# 部署与可达性说明

版本：0.1  
日期：2026-06-27

## 当前线上入口

GitHub Pages：

```text
https://ruipls.github.io/grandpas-new-ears/
```

健康检查页：

```text
https://ruipls.github.io/grandpas-new-ears/health.html
```

如果 Android 打不开主页面，先打开健康检查页：

- 健康检查页也打不开：更可能是当前网络、DNS、浏览器或 GitHub Pages 域名可达性问题。
- 健康检查页能打开、主页面打不开：更可能是应用缓存、service worker 或浏览器兼容问题。

## Android 兼容补丁

已完成：

- 增加 `192x192` 和 `512x512` PNG PWA 图标。
- 明确 manifest 的 `scope` 和 `start_url`。
- 增加移动端 Web App meta。
- service worker 改为导航请求优先走网络，降低旧缓存卡住的概率。
- 增加健康检查页。
- 增加静态发布包构建脚本。

## 多入口策略

单一 GitHub Pages 入口无法保证所有地区、运营商、公司网络、校园网和 Android 浏览器环境都稳定可达。更稳的方案是：

- GitHub Pages：当前已启用。
- Cloudflare Pages：作为第二入口，待 Cloudflare 账号邮箱验证后部署。
- 自有域名：后续建议绑定，例如 `ears.example.com`。
- 需要覆盖中国大陆网络时，应评估合规云厂商、ICP备案和大陆 CDN。

## Cloudflare Pages 当前状态

Wrangler 登录已完成，但创建 Pages 项目时 Cloudflare API 返回：

```text
Your user email must been verified [code: 8000077]
```

需要先完成 Cloudflare 账号邮箱验证。验证后可继续执行：

```bash
npm run build
npx wrangler pages deploy dist --project-name grandpas-new-ears --branch main
```

