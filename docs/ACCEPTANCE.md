# 验收矩阵

给独立验收用。这里的 PASS 只表示下面命令在 Node 里实际跑过，或实际读到了样式规则。真机和微信开发者工具都是 NOT RUN。不要把 PASS 读成手机上已经能听，也不要读成可以提交审核。

## 命令

在仓库根目录：

```bash
npm run check
npm run pack:miniprogram
```

`npm run check` 会先做语法检查，再跑 `scripts/check-miniprogram.mjs` 和 `scripts/check-contract.mjs`。成功时输出里有 `assertions passed`、`contract assertions passed`、`contract flows passed` 和 `contract flow ids`。下面的 ID 必须出现在 `contract flow ids` 里，才算该条模拟通过。

打包：

```bash
npm run pack:miniprogram -- --out build/grandpas-new-ears-miniprogram.zip
```

解压后导入 `grandpas-new-ears` 这一层。这一层有 `project.config.json`，并且 `miniprogramRoot` 是 `miniprogram/`。只打开 `miniprogram/` 也可以，那里另有一份 `project.config.json`。两份 `appid` 都必须仍是 `touristappid`。

## 矩阵

| ID | 要求 | 脚本 | 命令 | 本次范围 | 真机 |
| --- | --- | --- | --- | --- | --- |
| CODE-30001 … CODE-40001、CODE-UNKNOWN | 2026-08-24 插件文档里的 14 个错误码都有处理；文档没写的码不当成网络错误 | `scripts/check-contract.mjs` | `npm run check` | PASS（模拟） | NOT RUN |
| CAP-RULES | 空白不成字幕，相邻重复丢掉，更长的正式结果保留，长文本不截断 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-WATCHDOG | 没收到 `onStart` 时不报正在听，并给出 `start-timeout` | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-FINAL | `onStop.result` 是正式字幕；临时录音路径不进字幕 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-30011 | 已在识别时再次 `start` 不把当前这次听停掉 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-NETWORK | `-30004` 先重试一次，第二次才是网络异常 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-TIMEOUT | `-30006` 第二次仍是识别超时，不说成网络异常 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-TRANSMISSION | `-30003` 是没传完，不说成网络异常 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| ENG-30012 | 没有任务时 `stop` 不显示成识别失败，也不再开始 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-01 | 游客 AppID 不启动插件，不显示正在听 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-02、PAGE-03 | 插件缺失或不可用时明确提示，不显示正在听 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-04、PAGE-05、PAGE-24 | 需要隐私同意、点暂不同意、同意被撤回后，都不录音 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-06 | 错误码 112 显示指引未生效，不录音 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-07 | 授权或已知允许之后、`onStart` 之前只显示正在打开麦克风 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-09 | 临时字幕再换成正式字幕，暂停后不在听 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-10、PAGE-11、PAGE-12 | 空结果、相邻重复、长文本 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-13、PAGE-14、PAGE-15 | 暂停后的迟到 `onStart`、回到前台不自动听、页面销毁后的迟到回调 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-16 | 拒绝、设置里没打开、设置里打开后仍要再点开始 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-17 | 重复 `onLoad` 不加第二份隐藏监听，一句只记一次 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-18 | 结束时取消不保存；确认只保存文字，不保存临时音频 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-19 | 插件回报已在识别时，页面仍保持正在听 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-20、PAGE-21、PAGE-25 | 断网重试时显示正在重新连接；第二次网络失败或超时后不在听 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-22 | `-30001` 显示麦克风问题，不在听 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| PAGE-23 | 反复开始和暂停保留两句，听的时候不会再启动一次 | 同上 | 同上 | PASS（模拟） | NOT RUN |
| UI-01、UI-02、UI-03 | 主按钮样式最小高度 112rpx，字幕可换行，历史按钮最小高度 96rpx；代码不上传音频 | 同上，读的是 wxss 和源码 | 同上 | PASS（静态规则） | NOT RUN |

`scripts/check-miniprogram.mjs` 另外检查工程形状、30 秒续听、暂停不自动再开、授权门的同意/拒绝/设置返回。它的输出是 `assertions passed` 和 `access gate simulation ok (not a phone test)`。这些同样不是真机。

## 模拟边界

契约模拟按插件文档实现这些行为：`start` 只接收 `duration` 和 `lang`；已在录音时再次 `start` 回报 `-30011` 且当前任务还在；没有任务时 `stop` 回报 `-30012`；成功的 `stop` 走 `onStop`，字段有 `result`、`tempFilePath`、`duration`、`fileSize`。页面测试用的就是这个管理器，不是把回调写成和当前代码一样的形状来放过实现。

下面几条是假设，不是文档原句：

- `onRecognize` 的 `result` 是这一段正在说的文字。2026-08-24 的中文方法表没有这个回调。代码仍监听它；真机没有时，正式字幕仍来自 `onStop`。
- 网络、超时、传输出错各自动再试一次。文档只给了错误码，没有要求重试。
- `onStart` 超过 8 秒还不来，就停止并显示「没有开始听」。文档没有这个时限。官方的识别超时是 `-30006`。
- `touristappid` 是开发者工具和本仓库的占位。`wx.getAccountInfoSync` 文档只说 `appId` 是字符串，没有把它列为枚举。读不到账号信息时不单靠这一条拦截，插件不可用仍会拦截。
- 30 秒主动分段是为了避开社区里「大约 40 秒没有 `onStop`」的报告。官方单次上限仍是 60000 毫秒。

Node 页面测试没有渲染按钮，也没有麦克风。UI 三条只证明样式规则写在文件里。

## 已知缺口

- 没有微信开发者工具，没有真机。弹窗、隐私审核中的表现、领夹麦走哪一个输入，都还没看见。
- 插件版本仓库里写的是 `0.3.6`，官方示例仍是 `0.0.7`。哪一个能加，要看公众平台。
- GitHub Actions 工作流在 `.github/workflows/check.yml`。本环境没有等待那次 Actions 跑完，所以不能把 CI 写成通过。本地 `npm run check` 才是这次的结果。
- 不新增后端、不换识别供应商、不保存音频、不加遥测。

## 仍要平台核实的配置

现在不要去填。填完也不能当成一定能发布。

| 事项 | 这版代码 | 依据或不确定点 |
| --- | --- | --- |
| AppID | 仓库保持 `touristappid`，由人在开发者工具详情里手选 | 不把真实 AppID 写进仓库 |
| 同声传译插件 | `app.json` 里提供方 `wx069ba97219f66d99`，版本 `0.3.6` | 版本以后台可选为准，待核实 |
| 隐私指引 | 需要声明「访问你的麦克风」并等它生效 | 隐私文档：没声明的接口会直接失败，错误码 112 |
| 录音权限 | 用户同意 `scope.record` 之后才能听 | 拒绝后要去设置里打开，不会反复弹同一个窗 |
| 个人主体能否添加插件、类目、备案、体验版是否要先备案 | 代码不处理 | 待公众平台当时的页面为准。不能承诺只配置就能上线 |
| 自己的后端、收费识别、request 合法域名 | 不需要为自己的服务去配 | `miniprogram/` 里没有 `wx.request`，也没有支付。插件用的是微信自己的网络；若工具另提示域名，待平台核实，不要为此加后端 |
| 手机号、位置、摄像头、相册 | 不需要 | 这版不用这些接口 |
