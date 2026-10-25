const { createWechatSIEngine } = require("./wechat-si");

/**
 * Speech engine used by the caption screen.
 *
 * start({ lang }) -> Promise
 *   Keeps listening until stop(). If the provider ends a session on its own
 *   (a time limit), the engine emits onFinal for that piece and starts again.
 * stop() -> Promise
 *   Resolves after the current session ends.
 * onInterim(handler)  handler(text)
 * onFinal(handler)    handler(text)
 * onError(handler)    handler({ code, retcode, message })
 *
 * error.code:
 *   "network" | "mic" | "interrupted" | "unavailable" | "limited" | "failed"
 *
 * Pages should import only createSpeechEngine(). A later cloud recognizer
 * (讯飞 / 阿里云 / 腾讯云, with a small token backend) can replace the body
 * of this function. The caption screen stays the same.
 *
 * WechatSI does not accept an Android audioSource. A cloud engine that owns
 * wx.getRecorderManager() can pass audioSource "voice_recognition" on Android,
 * or audioMode "voiceRecognition". Do not run that recorder together with
 * the WechatSI plugin, because both want the one global recorder.
 */
function createSpeechEngine() {
  return createWechatSIEngine();
}

module.exports = {
  createSpeechEngine
};
