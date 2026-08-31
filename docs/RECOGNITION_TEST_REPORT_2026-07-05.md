# 识别评测测试报告

日期：2026-07-05
测试版本：`20260705-huawei1`
数据来源：`tests/fixtures/evaluation/` mock export
执行角色：`docs/agents/recognition-test-content-agent.md`

## 结论

本轮完成了测试内容 sub-agent 的定义，并创建了三组可复现评测夹具。现有 `eval:transcript` 脚本可以正确读取 reference 文本和 `gne-eval-v1` 导出 JSON，三组 mock 数据的准确率计算全部通过。

这些结果只能证明评测链路可用，不能代表真实浏览器语音识别能力。真实验收仍需要在 Android Chrome、Android Edge、iPhone Safari，以及问题设备上的华为 / 鸿蒙浏览器里导出实际 JSON 后复测。

## 测试内容

| 场景 | 参考文本 | 模拟导出 |
| --- | --- | --- |
| 安静普通话固定文本 | `tests/fixtures/evaluation/quiet-mandarin/reference.txt` | `tests/fixtures/evaluation/quiet-mandarin/mock-export.json` |
| 家庭客厅自然对话 | `tests/fixtures/evaluation/living-room-dialogue/reference.txt` | `tests/fixtures/evaluation/living-room-dialogue/mock-export.json` |
| 1.5 米轻噪声固定文本 | `tests/fixtures/evaluation/distance-noise/reference.txt` | `tests/fixtures/evaluation/distance-noise/mock-export.json` |

## 准确率结果

| 场景 | CER | 字准确率 | Token 错误率 | Token 准确率 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| 安静普通话固定文本 | 1.90% | 98.10% | 3.28% | 96.72% | 通过 mock 阈值 |
| 家庭客厅自然对话 | 1.85% | 98.15% | 3.28% | 96.72% | 通过 mock 阈值 |
| 1.5 米轻噪声固定文本 | 1.80% | 98.20% | 2.99% | 97.01% | 通过 mock 阈值 |

安静普通话场景的 CER 低于 `docs/EVALUATION.md` 中 15% 的初始目标，字准确率高于 85%。另外两组作为扩展场景，也保持在可读范围内。

## 速度与稳定性摘要

| 场景 | 首字可见 | 首条最终字幕 | 渲染 P95 | 重启次数 | 错误数 | 后半程/前半程渲染 P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 安静普通话固定文本 | 780 ms | 1820 ms | 18.6 ms | 0 | 0 | 1.10 |
| 家庭客厅自然对话 | 940 ms | 2300 ms | 28.4 ms | 1 | 0 | 1.42 |
| 1.5 米轻噪声固定文本 | 1260 ms | 2860 ms | 42.5 ms | 0 | 0 | 1.49 |

三组 mock 数据均满足首字可见低于 1.5 秒、渲染 P95 低于 50 ms、错误数为 0 的初始目标。家庭客厅场景保留 1 次自动重启样例，用于报告稳定性指标，但没有记录不可恢复错误。

## 执行命令

```bash
npm run eval:transcript -- --reference tests/fixtures/evaluation/quiet-mandarin/reference.txt --hypothesis tests/fixtures/evaluation/quiet-mandarin/mock-export.json
npm run eval:transcript -- --reference tests/fixtures/evaluation/living-room-dialogue/reference.txt --hypothesis tests/fixtures/evaluation/living-room-dialogue/mock-export.json
npm run eval:transcript -- --reference tests/fixtures/evaluation/distance-noise/reference.txt --hypothesis tests/fixtures/evaluation/distance-noise/mock-export.json
npm run check
```

结果：三组评测命令成功返回 JSON 报告，`npm run check` 通过。

## 边界

- mock export 是手工构造数据，不代表真实设备、真实浏览器或真实网络下的识别表现。
- 当前脚本只自动计算 CER 和 token 错误率；速度、重启和渲染指标来自导出 JSON 的 `summary`。
- 华为 / 鸿蒙浏览器的“麦克风正常但无字幕”问题不能靠 mock 数据验证，需要真实设备导出诊断信息。

## 下一步

1. 用同一批 `reference.txt` 在真实设备上朗读，导出实际 `gne-eval-v1` JSON。
2. 将真实 JSON 放到对应场景目录下，保留 mock 文件作为样例。
3. 如果真实华为 / 鸿蒙浏览器仍无字幕，把诊断 JSON 与本报告一起用于后端 ASR 方案设计。
