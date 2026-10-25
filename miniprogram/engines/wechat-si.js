const { normalizeCaption } = require("../utils/format");

const PLUGIN_NAME = "WechatSI";
const DEFAULT_DURATION_MS = 30000;
const DEFAULT_RESTART_DELAY_MS = 300;
const DEFAULT_STOP_TIMEOUT_MS = 1600;

const NETWORK_CODES = {
  "-30003": true,
  "-30004": true,
  "-30006": true,
  "-30008": true,
  "-30010": true
};

function classifyWechatSIError(retcode) {
  const code = Number(retcode);
  if (code === -30011 || code === -30012) return "ignore";
  if (code === -30002) return "interrupted";
  if (code === -30001) return "mic";
  if (code === -40001) return "limited";
  if (NETWORK_CODES[String(code)]) return "network";
  return "failed";
}

function normalizeLang(lang) {
  if (lang === "zh_CN" || lang === "en_US" || lang === "zh_HK" || lang === "sichuanhua") {
    return lang;
  }
  return "zh_CN";
}

function defaultLoadManager() {
  if (typeof requirePlugin !== "function") {
    throw new Error("requirePlugin unavailable");
  }
  const plugin = requirePlugin(PLUGIN_NAME);
  if (!plugin || typeof plugin.getRecordRecognitionManager !== "function") {
    throw new Error("WechatSI manager missing");
  }
  return plugin.getRecordRecognitionManager();
}

function createWechatSIEngine(options) {
  const settings = options || {};
  const loadManager = settings.loadManager || defaultLoadManager;
  const schedule = settings.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = settings.cancel || ((timer) => clearTimeout(timer));
  const duration = settings.duration || DEFAULT_DURATION_MS;
  const restartDelay = settings.restartDelay == null ? DEFAULT_RESTART_DELAY_MS : settings.restartDelay;
  const stopTimeout = settings.stopTimeout == null ? DEFAULT_STOP_TIMEOUT_MS : settings.stopTimeout;

  const handlers = {
    interim() {},
    final() {},
    error() {}
  };

  let manager = null;
  let active = false;
  let running = false;
  let startedPending = false;
  let discardNextStop = false;
  let lang = "zh_CN";
  let interim = "";
  let generation = 0;
  let networkRetries = 0;
  let restartTimer = null;
  let stopTimer = null;
  let stopWaiter = null;

  function clearRestart() {
    if (restartTimer != null) {
      cancel(restartTimer);
      restartTimer = null;
    }
  }

  function clearStopTimer() {
    if (stopTimer != null) {
      cancel(stopTimer);
      stopTimer = null;
    }
  }

  function finishStopWaiter() {
    clearStopTimer();
    if (!stopWaiter) return;
    const resolve = stopWaiter;
    stopWaiter = null;
    resolve();
  }

  function emitError(code, retcode) {
    handlers.error({
      code: code,
      retcode: retcode == null ? null : retcode,
      message: code
    });
  }

  function load() {
    if (manager) return manager;
    manager = loadManager();
    if (!manager || typeof manager.start !== "function" || typeof manager.stop !== "function") {
      manager = null;
      throw new Error("WechatSI manager missing");
    }
    manager.onStart = function () {
      discardNextStop = false;
      startedPending = false;
      running = true;
    };
    manager.onRecognize = function (res) {
      if (!running && !active) return;
      interim = normalizeCaption(res && res.result);
      if (active) handlers.interim(interim);
    };
    manager.onStop = function (res) {
      if (discardNextStop) {
        discardNextStop = false;
        running = false;
        startedPending = false;
        interim = "";
        finishStopWaiter();
        return;
      }
      const wasRunning = running || startedPending;
      running = false;
      startedPending = false;
      const text = normalizeCaption(res && res.result) || interim;
      interim = "";
      if (active) handlers.interim("");
      if ((wasRunning || stopWaiter) && text) handlers.final(text);
      const stillActive = active;
      finishStopWaiter();
      if (stillActive) {
        networkRetries = 0;
        scheduleRestart();
      }
    };
    manager.onError = function (res) {
      const kind = classifyWechatSIError(res && res.retcode);
      if (kind === "ignore") {
        if (Number(res && res.retcode) === -30012) {
          running = false;
          startedPending = false;
          finishStopWaiter();
        }
        return;
      }
      running = false;
      startedPending = false;
      interim = "";
      handlers.interim("");
      if (active && kind === "network" && networkRetries < 1) {
        networkRetries += 1;
        scheduleRestart();
        return;
      }
      active = false;
      clearRestart();
      emitError(kind, res && res.retcode);
      finishStopWaiter();
    };
    return manager;
  }

  function failBegin(notifyOnFailure, failure, reject) {
    active = false;
    if (notifyOnFailure) handlers.error(failure);
    reject(failure);
  }

  function begin(notifyOnFailure, attempt) {
    const tries = attempt || 0;
    return new Promise((resolve, reject) => {
      if (running || startedPending) {
        resolve();
        return;
      }
      if (discardNextStop) {
        if (tries >= 8) {
          discardNextStop = false;
          failBegin(notifyOnFailure, { code: "failed", retcode: null, message: "failed" }, reject);
          return;
        }
        const token = generation;
        schedule(() => {
          if (!active || token !== generation) {
            resolve();
            return;
          }
          begin(notifyOnFailure, tries + 1).then(resolve, reject);
        }, restartDelay);
        return;
      }
      let current;
      try {
        current = load();
      } catch (error) {
        failBegin(notifyOnFailure, { code: "unavailable", retcode: null, message: "unavailable" }, reject);
        return;
      }
      try {
        startedPending = true;
        // Official start() only accepts duration and lang. The plugin records
        // with the system default input, so a headset or Type-C mic that the
        // phone already treats as the headset microphone is used automatically.
        // audioSource cannot be set here. Do not also call wx.getRecorderManager();
        // the plugin owns that global recorder.
        current.start({
          duration: duration,
          lang: lang
        });
        resolve();
      } catch (error) {
        startedPending = false;
        failBegin(notifyOnFailure, { code: "failed", retcode: null, message: "failed" }, reject);
      }
    });
  }

  function scheduleRestart() {
    clearRestart();
    const token = generation;
    restartTimer = schedule(() => {
      restartTimer = null;
      if (!active || token !== generation) return;
      begin(true).catch(() => {});
    }, restartDelay);
  }

  function armStopTimeout() {
    clearStopTimer();
    stopTimer = schedule(() => {
      stopTimer = null;
      if (!stopWaiter) return;
      discardNextStop = true;
      running = false;
      startedPending = false;
      if (interim) {
        const text = interim;
        interim = "";
        handlers.interim("");
        handlers.final(text);
      }
      finishStopWaiter();
    }, stopTimeout);
  }

  return {
    start(request) {
      lang = normalizeLang(request && request.lang);
      active = true;
      networkRetries = 0;
      return begin(false);
    },
    stop() {
      const shouldStop = active || running || startedPending || Boolean(interim);
      active = false;
      generation += 1;
      clearRestart();
      if (!shouldStop) return Promise.resolve();
      if (stopWaiter) {
        return new Promise((resolve) => {
          const previous = stopWaiter;
          stopWaiter = () => {
            previous();
            resolve();
          };
        });
      }
      return new Promise((resolve) => {
        stopWaiter = resolve;
        try {
          load().stop();
        } catch (error) {
          running = false;
          startedPending = false;
          if (interim) {
            const text = interim;
            interim = "";
            handlers.final(text);
          }
          finishStopWaiter();
        }
        if (stopWaiter) armStopTimeout();
      });
    },
    onInterim(handler) {
      handlers.interim = typeof handler === "function" ? handler : function () {};
    },
    onFinal(handler) {
      handlers.final = typeof handler === "function" ? handler : function () {};
    },
    onError(handler) {
      handlers.error = typeof handler === "function" ? handler : function () {};
    }
  };
}

module.exports = {
  DEFAULT_DURATION_MS,
  classifyWechatSIError,
  createWechatSIEngine
};
