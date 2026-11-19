# 爷爷的新耳朵 · 微信小程序测试版

版本：0.2  
日期：2026-11-19

网页原型还在仓库根目录，这版没有改它。微信里打开的是 `miniprogram/`。

这是给真机试用的测试版：一页大字幕，开始、暂停、结束。识别用微信官方的同声传译插件，不需要自己的服务器，也不需要语音识别的密钥。

## 现在到哪一步

这三件事不是一回事：

1. **代码已经写了。** 有字幕页、30 秒自动续听、暂停、锁屏或离开后停止、结束时才问要不要保存在这台手机。隐私同意和麦克风授权按微信公开文档分成不同状态。仓库里的 AppID 仍是占位 `touristappid`，没有真实 AppID，也没有密钥。
2. **电脑上的模拟可以检查。** 运行 `npm run check`。它检查工程文件，并用假的录音回调走识别、同意、拒绝、重试和暂停。通过只说明这些分支没有写反，**不说明手机上已经能听，也不说明隐私指引已经审核通过**。
3. **真机还没在写代码的环境里验过。** 这里没有微信开发者工具，也没有手机。指引如果还在审核，弹窗出不出现，要以你的手机为准。必须你亲自看的几项在第 5 节。

## 1. 下载并在微信开发者工具里打开

不需要安装 git。

1. 打开这一轮的 Pull Request，或仓库里分支 `cursor/miniprogram-privacy-auth-8698`，点 Code → Download ZIP。不要下 `main`：主分支还没有这版小程序。也不要下旧的 Pull Request #1 的包，那一版的授权流程是旧的。
2. 解压。用含有 `project.config.json` 的那一层目录。压缩包文件名可能带一长串后缀，那是正常的。
3. 安装微信开发者工具稳定版：<https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html>
4. 选择「导入项目」。目录选解压后的仓库根目录（根目录的 `project.config.json` 指向 `miniprogram/`）。只导入 `miniprogram` 文件夹也可以。
5. AppID 在开发者工具右上角「详情 → 基本信息」里手选。不要把真实 AppID 写进仓库，也不要发给别人。工具可能会改本地的 `project.config.json`，或另存已忽略的 `project.private.config.json`。这两种本地改动都不要提交。仓库里应保持 `touristappid`。
6. 调试基础库选 3.x。隐私接口从基础库 2.32.3 才有。工程没有写死基础库版本，避免你电脑上没有那个版本时项目打不开。
7. 游客模式，或还没加上插件时，工具常会提示不能使用插件。字幕页面仍应能打开。真正听写要先有你的 AppID、已添加的插件，以及已经生效的隐私保护指引。
8. 如果模拟器因为插件直接起不来，先不要改页面代码。用「预览」看真机。

本地可以检查工程和模拟流程：

```bash
npm run check
```

没有安装 Node 也可以先用开发者工具看界面。`npm run check` 不是真机测试。

## 2. 注册小程序

1. 打开 <https://mp.weixin.qq.com> ，注册一个小程序。邮箱要能收信，管理员用微信扫码。
2. 个人主体可以先做真机测试。公开上架还要备案和类目，见第 6 节，里面有几项需要你在后台再确认。
3. 登录后进入「开发管理 → 开发设置」，可以看到 AppID（小程序 ID）。在开发者工具里手选它，见第 1 节。不要把 AppID 提交回这个仓库。

开发者工具有时会另存 `project.private.config.json`。那个文件已忽略。这个测试版没有密钥，不要把密钥放进去。

## 3. 添加同声传译插件

官方说明：<https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/extended/translator.html>  
插件怎么声明：<https://developers.weixin.qq.com/miniprogram/dev/framework/plugin/using.html>

已按文档核对过的事实：

- 插件 AppID 是 `wx069ba97219f66d99`。
- 代码里的引用名是 `WechatSI`，写在 `miniprogram/app.json` 的 `plugins` 里。
- 语音识别用 `requirePlugin("WechatSI").getRecordRecognitionManager()`。
- `start` 只接受 `duration` 和 `lang`。语言有 `zh_CN`、`en_US`、`zh_HK`、`sichuanhua`。
- `onStop` 里的 `result` 是这一段的正式结果。
- 2026-08-24 的中文和英文插件正文都只有 `start`、`stop`、`onStart`、`onStop`、`onError`，没有 `onRecognize`。`onStop.result` 才是正式字幕。这版如果收到 `onRecognize`，只用它显示「正在说」；没有这个回调时，正式字幕仍然完整。不要把旧文档里的 `onRecognize` 当成现在的必需接口。
- 语音输入配额，按中文文档是每个小程序每分钟 250 条、每天 3 万条。要提高配额，邮件 `wetranslate@tencent.com`，模板在同一页。

添加步骤：

1. 小程序后台打开「小程序信息设置页 → 第三方设置 → 插件管理」。这是 2026-08-10 的插件文档写的路径。
2. 搜索「微信同声传译」，或用 AppID `wx069ba97219f66d99` 查找。确认提供方是腾讯，避开同名的第三方插件。
3. 添加。若页面要求申请，等通过后再编译。
4. 把后台给出的版本号，填进 `miniprogram/app.json` 里 `plugins.WechatSI.version`。
5. 工程里现在写的是 `0.3.6`，因为 2025 年的社区示例在用它。官方示例代码仍是 `0.0.7`。这两个数字不要当成最新版本。以后台插件管理里能选到的版本为准，不一致就改 `app.json` 那一处。

待核实：2026-08-24 的中文和英文插件文档都还在说明用法、配额和错误码。英文页没有 “out of maintenance”。官方示例版本仍是 `0.0.7`，这不表示 `0.3.6` 不能用。现在还能不能把这个插件加进一个新的小程序，以及后台实际提供哪个版本，要在插件管理里看。若已经不能添加，就按第 8 节换云端识别，字幕页面不用改。

## 4. 用户隐私保护指引和麦克风

麦克风是隐私接口。手机系统里允许微信使用麦克风，不等于这个小程序获准录音。微信的授权管理里找不到这个小程序，通常是因为小程序自己的录音权限还没问成，不是系统开关没开。

2026-11-19 核对过的微信文档：

- 《小程序隐私协议开发指南》（页内写最后编辑于 2026-07-28）：<https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html>
- `wx.getPrivacySetting`：<https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.getPrivacySetting.html>
- 「访问你的麦克风」对应 `wx.authorize({ scope: "scope.record" })` 和 `RecorderManager.start`：<https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html>
- 用户拒绝过某个 scope 之后，不会再弹同一个授权窗，要到设置里打开：<https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/authorize.html>

文档写明了的行为，代码按这个分支，没有把它们合成一句「麦克风未授权」：

- 指引里已经声明了收集类型，而这个用户还没同意：`needAuthorization` 为 true。主按钮变成「同意并开始」。它是 `open-type="agreePrivacyAuthorization"`。只有微信回调了同意，才会接着调用 `wx.authorize` 申请麦克风。点「暂不同意」不会开始听。
- 用户拒绝官方隐私弹窗：10 秒内再次调用不再弹窗。错误码 103 是连同授权一起拒绝，104 是没同意隐私协议。页面写「还未同意」，并请你等约 10 秒再点。
- 当前生效的指引里没有这项：错误码 112，`api scope is not declared in the privacy agreement`。文档写补充进去的隐私类型大约 5 分钟后生效。页面写「指引未生效」，不会把它说成麦克风已拒绝，也不会只留「去打开设置」。
- 提审时选了「未采集隐私」，或没有声明协议，接口被收回：`appid privacy api banned`。页面写「暂不能听」。
- `scope.record` 已经是拒绝：不再弹授权窗。这时才显示「麦克风未授权」和「去打开设置」。从设置回来，只有读到允许，才显示「麦克风已允许」。这句话的意思是可以再点开始，不是已经在听。
- 基础库低于 2.32.3 没有这套隐私检查，也不会因此拦截。如果当前微信连 `wx.authorize` 都没有，页面写「需要升级微信」。
- 「正在听」只在插件回调已经开始录音之后出现。刚通过授权时显示「正在打开麦克风」。

`app.json` 里开着 `__usePrivacyCheck__: true`。这一版不再先调用 `wx.requirePrivacyAuthorize` 再调用 `wx.authorize`。官方说明里，`requirePrivacyAuthorize` 只是可选的模拟调用。上一版把它的失败和麦克风拒绝混成了同一种提示。

下面几件不能从文档定成事实，代码也没有当成已经发生：

- 整份隐私保护指引停在「审核中」时，真机会不会弹出同意窗。官方常见错误表没有单独的「审核中」错误码。112 只表示当前生效内容里没有这项。审核过没过，以公众平台和你的手机为准。
- 指引还没生效时，点「同意并开始」会不会完全没有回调。文档没有写死。没有回调就不会申请麦克风，也不会显示「正在听」。
- 文档里的「大约 5 分钟」指的是在已经生效的指引上补充一项之后。它不是整份指引的审核时长。

后台要填的内容：

1. 打开「设置 → 服务内容声明 → 用户隐私保护指引」。菜单以你登录后看到的为准。
2. 勾选「访问你的麦克风」。
3. 用途可以写成：

   > 用于把身边的人说的话实时转成字幕。只有你点击开始后才会使用麦克风。对话默认不保存，结束时会问你要不要保存在这台手机上。

4. 保存后等它生效，再重新编译、预览。已提交不等于已生效。

## 5. 在真机上怎么试

模拟器里的麦克风不能代表手机。请用「预览」，用管理员微信扫码。下面前 5 项是这一轮必须你亲自看的。电脑模拟没有覆盖它们。

必须在真机确认：

1. 隐私保护指引生效之后，点「同意并开始」或「开始」。应出现隐私同意和麦克风授权。只有你允许，并且录音真的开始，状态才变成「正在听」。
2. 如果指引还在审核或刚保存，点开始后应看到「指引未生效」或「还未同意」这类说明，而不是只出现「麦克风未授权」，再进到一个找不到这个小程序的设置页。这一项用来看文案是否符合手机，不表示审核已经通过。
3. 拒绝麦克风之后，应看到「麦克风未授权」和「去打开设置」。从设置返回但没有打开时，不能变成「正在听」。打开之后再点开始，才可以听。
4. 暂停、锁屏或切到别的 App 之后应停止。回到小程序不会自己接着听。连续说超过 30 秒，应自己续上，已经出现的字幕还在。
5. 点「结束」。没有字幕时回到待机。有字幕时才问保存还是不保存。不保存就不会留下记录。

有空再看：

1. 说一句普通话。应先出现「正在说」，停顿后变成大字正式字幕，并滚到最新一句。
2. 字号试「大 / 超大 / 巨大」，再开关「高对比」。完全退出小程序再进来，这三项应还在。
3. 讲话语言换成 English，再说一句。
4. 拔掉再插上 Type-C 领夹麦，插好之后再点「开始」。麦克风的限制写在第 7 节。
5. 打开「已保存的对话」，可以删除一条，也可以「清空全部」。

给其他家人的手机：在开发者工具上传体验版，后台「成员管理」里添加体验成员，让他们扫体验版二维码。体验版比预览码稳定。管理员自己的预览不需要先公开发布。

待核实：体验版是否在任何情况下都不必先完成备案。以你上传体验版时的后台提示为准。

## 6. 公开发布前的备案、类目和资质

真机预览和给几位家人看，可以先做。公开发布是另一件事。

备案：

- 微信备案常见问答写明：因为没备案而发布失败时，错误码是 `86369`，提示「小程序上架需先完成备案」。见 <https://developers.weixin.qq.com/miniprogram/product/record/record_faq.html>
- 填写步骤见 <https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html>
- 待核实：2024 年有开发者提到，未备案有时可以先上线，但会限制访问人数，并要求在限期内补备案。2026 年点「发布」时是否还这样，以后台当时的提示为准。

类目和资质，下面几项都不要当成已经审核通过：

- 不要选医疗器械、助听器、诊疗。爷爷的新耳朵不是助听器，也不做诊断。
- 小程序服务类目表里，「工具」下面有办公、信息查询等；部分主体的表里还有「效率」（日常生活、工作效率提升）。见 <https://developers.weixin.qq.com/miniprogram/product/material>
- 备案用的是另一份「服务内容」表。「生活服务 → 工具」对个人备案标的是「可选，符合个人性质」。见 <https://developers.weixin.qq.com/miniprogram/product/record/record_review.html>
- 待核实：个人主体现在能不能选到合适的类目，审核会不会要额外材料。以类目申请页和驳回说明为准。
- 待核实：只调用微信同声传译、小程序自己不生成回答时，要不要做算法备案。
- 待核实：同声传译插件对个人主体是否仍然可以直接添加。

以后如果改成自己的云端识别，或加上摘要、生成式回复，再单独核对算法备案和类目。那是下一步，不是这版测试的前提。

## 7. 这版的限制

- 识别要联网。没有离线识别。
- 同声传译 `start` 的 `duration` 设为 30000。官方说明：传入合法 duration 后，到时插件会自己停，并回调 `onStop`，`result` 才是这一段的正式字幕。文档没有写 `onStop` 会在到时的同一毫秒到达，所以客户端在 30000 毫秒后再等 2000 毫秒；若还没有 `onStop`，才调用一次 `stop`。这次 `stop` 之后最多再等 8000 毫秒。仍然没有 `onStop` 就结束本次收听，不再 `start`。暂停、离开或卸载会取消这些等待。`onRecognize` 不在 2026-08-24 的中英文方法表里，没有它也能靠 `onStop` 出字幕；有它时只用来显示「正在说」。
- `start` 不能选择 Android 的 `audioSource`。插件用系统默认输入：一般是手机麦克风；系统把耳麦或 Type-C 麦当成耳机麦时，会自动改用那一个。这和微信录音接口里的 `auto` 一致。有的 USB 麦不会被当成耳机麦，手机就会继续用内置麦克风。请用你的领夹麦在真机上确认，不要只看模拟器。
- 这版不会同时自己调用 `wx.getRecorderManager()`。那个录音器是全局唯一的，和插件抢会冲突。
- 锁屏、切走、打开「已保存的对话」都会停止收音，并留下文字提示。回到前台不会自动接着听，避免手机在口袋里继续录。
- 插件没有日语、韩语。这版只有普通话、English、粤语。四川话插件支持，测试版为了少选项没有放出来。
- 没有翻译。
- 保存的记录只在这台手机，最多 30 条。换手机或删除小程序就会没。插件给的临时录音文件，这版不保存，也不上传到自己的服务器。
- 不保证医疗、法律或合同场景的准确度。
- 每天的识别条数有配额。30 秒一段，十分钟大约 20 条。一家人试用足够；人多了要看第 3 节的配额。

## 8. 建议的下一步

1. 用真机把第 5 节走一遍，尤其是领夹麦、锁屏、拒绝麦克风、连续说一分钟。
2. 若插件不能新添加，或 30 秒分段太碎，就换成云端流式识别（讯飞、阿里云或腾讯云）。字幕页面只认 `createSpeechEngine()`：`start`、`stop`、`onInterim`、`onFinal`、`onRevise`、`onError`、`onStarted`、`onPending`。`onStarted` 之后才显示「正在听」。`onPending` 表示这一段已经结束或正在重试，不能继续显示「正在听」。`onRevise` 用迟到的 `onStop.result` 替换刚才临时收住的半句。换实现时改 `createSpeechEngine()` 即可。没有 `onInterim` 也必须能靠 `onFinal` 工作。
3. 云端那一版需要一个很小的后端来发临时 token，不要把密钥放进小程序。录音可以自己用 `wx.getRecorderManager()`。Android 上优先试 `audioSource: "voice_recognition"`；基础库较新时也可以试 `audioMode: "voiceRecognition"`（和 `audioSource` 同时写时，微信文档说 `audioMode` 生效）。这一步仍不要和同声传译插件一起占用录音器。
4. 需要翻译时，同声传译还有 `plugin.translate`（普通话、英语、粤语），也可以以后交给云端翻译。
5. 找几位老人或家人看字号、按钮和「结束时问要不要保存」是否够清楚。

## 9. 代码在哪里

| 路径 | 作用 |
| --- | --- |
| `miniprogram/pages/index/` | 字幕主屏 |
| `miniprogram/pages/history/` | 已保存的对话 |
| `miniprogram/engines/index.js` | 识别引擎接口。以后换云端只改这里 |
| `miniprogram/engines/wechat-si.js` | 同声传译实现，含 30 秒自动续听 |
| `miniprogram/utils/` | 本机设置、历史、时间文字；`access-flow.js` 只判断隐私和麦克风状态，不调用微信；`permission.js` 才去调用授权接口 |
| `scripts/check-miniprogram.mjs` | 结构、识别引擎和授权门的模拟 |
| `scripts/check-contract.mjs` | 按插件文档错误码和页面流程做的模拟，不是真机 |
| `scripts/pack-miniprogram.mjs` | 打可导入的 zip，不打进 node_modules、.git、日志、音频和密钥 |
| `docs/ACCEPTANCE.md` | 验收矩阵。PASS 只表示模拟或静态检查，真机列是 NOT RUN |
| `project.config.json` | 用开发者工具打开仓库根目录。`miniprogramRoot` 是 `miniprogram/` |
| `miniprogram/project.config.json` | 用开发者工具只打开 `miniprogram` 文件夹 |

## 10. 验收时怎么跑，以及现在还不要配置

在仓库根目录：

```bash
npm run check
npm run pack:miniprogram
```

`npm run check` 同时跑结构模拟、契约模拟和独立时序探针。通过只说明 Node 模拟和文件检查没失败。它不是微信开发者工具，也不是手机。逐条 ID、mock 边界和平台清单见 [验收矩阵](ACCEPTANCE.md)。

现在不需要去公众平台改配置，也不需要提交审核。AppID 继续留在开发者工具里手选。配置本身也不能当成一定能上线。
