# Evaluation Fixtures

这些夹具用于验证 `scripts/evaluate-transcript.mjs` 和评测报告流程是否可运行。它们不是浏览器真实语音识别结果，只能作为脚本连通性和报告格式样例。

## 场景

| 场景 | 参考文本 | 模拟导出 |
| --- | --- | --- |
| 安静普通话固定文本 | `quiet-mandarin/reference.txt` | `quiet-mandarin/mock-export.json` |
| 家庭客厅自然对话 | `living-room-dialogue/reference.txt` | `living-room-dialogue/mock-export.json` |
| 1.5 米轻噪声固定文本 | `distance-noise/reference.txt` | `distance-noise/mock-export.json` |

## 运行

```bash
npm run eval:transcript -- --reference tests/fixtures/evaluation/quiet-mandarin/reference.txt --hypothesis tests/fixtures/evaluation/quiet-mandarin/mock-export.json
npm run eval:transcript -- --reference tests/fixtures/evaluation/living-room-dialogue/reference.txt --hypothesis tests/fixtures/evaluation/living-room-dialogue/mock-export.json
npm run eval:transcript -- --reference tests/fixtures/evaluation/distance-noise/reference.txt --hypothesis tests/fixtures/evaluation/distance-noise/mock-export.json
```

真实测试时，用应用导出的 JSON 替换 `mock-export.json`，保留同一份 `reference.txt`。
