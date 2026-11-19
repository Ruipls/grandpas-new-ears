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
 * onStarted(handler)  handler()
 *   Fires only after the provider reports that recording has started.
 *   start() resolving is not the same thing.
 * onPending(handler)  handler()
 *   A retry is about to begin. The page must not keep showing 正在听.
 *
 * error.code:
 *   "network" | "timeout" | "transmission" | "mic" | "interrupted" | "unavailable" | "limited" | "failed" | "start-timeout"
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
