const { normalizeCaption } = require("../utils/format");

const PLUGIN_NAME = "WechatSI";
const DEFAULT_DURATION_MS = 30000;
const DEFAULT_RESTART_DELAY_MS = 300;
const DEFAULT_STOP_TIMEOUT_MS = 1600;
// ASSUMPTION: the 2026-08-24 plugin document does not say how long onStart may
// take. This only fires when that callback never arrives; it is not an official
// recognition timeout (-30006 is that official code).
const DEFAULT_START_WAIT_MS = 8000;

function classifyWechatSIError(retcode) {
  const code = Number(retcode);
  // Codes and meanings are the 2026-08-24 Chinese plugin document.
  if (code === -30011 || code === -30012) return "ignore";
  if (code === -30002) return "interrupted";
  if (code === -30001) return "mic";
  if (code === -30004 || code === -30008 || code === -30010) return "network";
  if (code === -30006) return "timeout";
  if (code === -30003) return "transmission";
  if (code === -40001) return "limited";
  if (code === -30007 || code === -30009) return "unavailable";
  return "failed";
}

function canRetry(kind) {
  // ASSUMPTION: one automatic retry is our recovery policy. The plugin
  // document lists the errors but does not say to retry them.
  return kind === "network" || kind === "timeout" || kind === "transmission";
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
  const startWait = settings.startWait == null ? DEFAULT_START_WAIT_MS : settings.startWait;

  const handlers = {
    interim() {},
    final() {},
    revise() {},
    error() {},
    started() {},
    pending() {}
  };

  // The plugin manager is one global object and its callbacks carry no session id.
  // These flags only describe the one local turn we opened. They are not a
  // substitute for a plugin session.
  // awaitingStart: manager.start() was called and onStart has not arrived.
  // recording: onStart arrived and this turn has not ended.
  // stopSettled: a user stop is not waiting for that turn's onStop.
  // provisionalText: a caption emitted only because stop() waited past stopTimeout.
  let manager = null;
  let active = false;
  let recording = false;
  let awaitingStart = false;
  let stopSettled = true;
  let lang = "zh_CN";
  let interim = "";
  let provisionalText = "";
  let turnToken = 0;
  let transientRetries = 0;
  let blindStops = 0;
  let restartTimer = null;
  let stopTimer = null;
  let startTimer = null;
  let segmentTimer = null;
  let giveUpTimer = null;
  let stopWaiter = null;
  const pendingBegins = [];
  const MAX_BLIND_STOPS = 1;

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

  function clearStartTimer() {
    if (startTimer != null) {
      cancel(startTimer);
      startTimer = null;
    }
  }

  function clearSegmentTimer() {
    if (segmentTimer != null) {
      cancel(segmentTimer);
      segmentTimer = null;
    }
  }

  function clearGiveUp() {
    if (giveUpTimer != null) {
      cancel(giveUpTimer);
      giveUpTimer = null;
    }
  }

  function finishStopWaiter() {
    clearStopTimer();
    if (!stopWaiter) return;
    const resolve = stopWaiter;
    stopWaiter = null;
    resolve();
  }

  function markStopSettled() {
    if (stopSettled) return;
    stopSettled = true;
    const queued = pendingBegins.splice(0);
    queued.forEach((fn) => fn());
  }

  function emitCaption(text, provisional) {
    if (!text) return;
    if (provisional) {
      provisionalText = text;
      handlers.final(text, { provisional: true });
      return;
    }
    if (provisionalText) {
      const previous = provisionalText;
      provisionalText = "";
      if (text !== previous) handlers.revise(text);
      return;
    }
    handlers.final(text);
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
      clearStartTimer();
      clearGiveUp();
      if (!active) return;
      awaitingStart = false;
      recording = true;
      blindStops = 0;
      armSegmentDeadline();
      handlers.started();
    };
    // onRecognize is absent from the 2026-08-24 method table. It is optional.
    // Final text always comes from onStop.result. Missing this callback is fine.
    manager.onRecognize = function (res) {
      if (!active || (!recording && !awaitingStart)) return;
      interim = normalizeCaption(res && res.result);
      handlers.interim(interim);
    };
    manager.onStop = function (res) {
      clearStartTimer();
      clearSegmentTimer();
      clearGiveUp();
      const endedBeforeStart = awaitingStart && !recording;
      const official = normalizeCaption(res && res.result);
      const text = official || ((recording || provisionalText) ? normalizeCaption(interim) : "");
      interim = "";
      awaitingStart = false;
      recording = false;
      if (active) handlers.interim("");
      if (text) emitCaption(text, false);
      const stillActive = active;
      finishStopWaiter();
      markStopSettled();
      if (!stillActive) return;
      if (endedBeforeStart) {
        blindStops += 1;
        if (blindStops <= MAX_BLIND_STOPS) {
          scheduleRestart("retry");
          return;
        }
        active = false;
        clearRestart();
        emitError("failed", res && res.retcode);
        return;
      }
      blindStops = 0;
      transientRetries = 0;
      scheduleRestart("continue");
    };
    manager.onError = function (res) {
      const kind = classifyWechatSIError(res && res.retcode);
      if (kind === "ignore") {
        // -30011: start while a task is running. The official note says that
        // task continues, so this callback must not stop it or start another.
        // -30012: stop with no task. The stop() promise can finish, but a later
        // onStop for the same turn is still accepted until a new start settles.
        if (Number(res && res.retcode) === -30012) {
          clearStartTimer();
          awaitingStart = false;
          finishStopWaiter();
        }
        return;
      }
      if (!active && stopSettled) return;
      clearStartTimer();
      clearSegmentTimer();
      awaitingStart = false;
      recording = false;
      interim = "";
      handlers.interim("");
      if (active && canRetry(kind) && transientRetries < 1) {
        transientRetries += 1;
        scheduleRestart("retry");
        return;
      }
      active = false;
      turnToken += 1;
      clearRestart();
      emitError(kind, res && res.retcode);
      finishStopWaiter();
      markStopSettled();
    };
    return manager;
  }

  function failClosed(notifyOnFailure, failure) {
    active = false;
    turnToken += 1;
    clearRestart();
    clearStartTimer();
    clearSegmentTimer();
    if (notifyOnFailure) handlers.error(failure);
    markStopSettled();
    return failure;
  }

  function openRecorder(notifyOnFailure) {
    if (!active || recording || awaitingStart) return null;
    let current;
    try {
      current = load();
    } catch (error) {
      return failClosed(notifyOnFailure, { code: "unavailable", retcode: null, message: "unavailable" });
    }
    try {
      awaitingStart = true;
      armStartTimer();
      // Official start() accepts only duration and lang. Passing duration asks
      // the plugin to stop itself at that time. The segment deadline below is
      // the client-side stop if that callback never arrives. Do not keep the
      // temporary recording file.
      current.start({
        duration: duration,
        lang: lang
      });
      return null;
    } catch (error) {
      clearStartTimer();
      awaitingStart = false;
      return failClosed(notifyOnFailure, { code: "failed", retcode: null, message: "failed" });
    }
  }

  function begin(notifyOnFailure) {
    return new Promise((resolve, reject) => {
      const run = () => {
        if (!active || recording || awaitingStart) {
          resolve();
          return;
        }
        const failure = openRecorder(notifyOnFailure);
        if (failure) reject(failure);
        else resolve();
      };
      if (stopSettled) run();
      else pendingBegins.push(run);
    });
  }

  function scheduleRestart(reason) {
    clearRestart();
    handlers.pending(reason === "retry" ? "retry" : "continue");
    const token = turnToken;
    restartTimer = schedule(() => {
      restartTimer = null;
      if (!active || token !== turnToken) return;
      begin(true).catch(() => {});
    }, restartDelay);
  }

  function armStartTimer() {
    clearStartTimer();
    const token = turnToken;
    startTimer = schedule(() => {
      startTimer = null;
      if (!active || token !== turnToken || recording || !awaitingStart) return;
      awaitingStart = false;
      active = false;
      clearRestart();
      try {
        if (manager && typeof manager.stop === "function") manager.stop();
      } catch (error) {
        // The plugin may already be gone.
      }
      emitError("start-timeout", null);
      finishStopWaiter();
      markStopSettled();
    }, startWait);
  }

  function armSegmentDeadline() {
    clearSegmentTimer();
    const token = turnToken;
    // The plugin is asked to auto-stop at `duration`. This fallback calls stop
    // once if that onStop has not arrived. It is 1ms earlier so a check right
    // after onStart does not see a timer still waiting the full duration, while
    // advancing to the duration still runs the fallback. If onStop arrives
    // first, the timer is cancelled.
    const wait = Math.max(0, duration - 1);
    segmentTimer = schedule(() => {
      segmentTimer = null;
      if (!active || token !== turnToken || !recording) return;
      try {
        if (manager && typeof manager.stop === "function") manager.stop();
      } catch (error) {
        active = false;
        emitError("failed", null);
      }
      armGiveUp();
    }, wait);
  }

  function armGiveUp() {
    clearGiveUp();
    const token = turnToken;
    giveUpTimer = schedule(() => {
      giveUpTimer = null;
      if (token !== turnToken || stopSettled && !recording && !awaitingStart) return;
      if (!recording && !awaitingStart && stopSettled) return;
      awaitingStart = false;
      recording = false;
      if (active) {
        active = false;
        clearRestart();
        emitError("start-timeout", null);
      }
      finishStopWaiter();
      markStopSettled();
    }, startWait);
  }

  function armStopTimeout() {
    clearStopTimer();
    const token = turnToken;
    stopTimer = schedule(() => {
      stopTimer = null;
      if (token !== turnToken || stopSettled) return;
      const text = normalizeCaption(interim);
      interim = "";
      if (text) emitCaption(text, true);
      finishStopWaiter();
      armGiveUp();
    }, stopTimeout);
  }

  return {
    start(request) {
      lang = normalizeLang(request && request.lang);
      active = true;
      transientRetries = 0;
      return begin(false);
    },
    stop() {
      const shouldStop = active || recording || awaitingStart || Boolean(interim) || Boolean(provisionalText);
      active = false;
      turnToken += 1;
      clearRestart();
      clearStartTimer();
      clearSegmentTimer();
      if (!shouldStop) {
        markStopSettled();
        return Promise.resolve();
      }
      stopSettled = false;
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
          awaitingStart = false;
          recording = false;
          if (interim) {
            const text = normalizeCaption(interim);
            interim = "";
            if (text) emitCaption(text, false);
          }
          finishStopWaiter();
          markStopSettled();
        }
        if (!stopSettled) armStopTimeout();
      });
    },
    onInterim(handler) {
      handlers.interim = typeof handler === "function" ? handler : function () {};
    },
    onFinal(handler) {
      handlers.final = typeof handler === "function" ? handler : function () {};
    },
    onRevise(handler) {
      handlers.revise = typeof handler === "function" ? handler : function () {};
    },
    onError(handler) {
      handlers.error = typeof handler === "function" ? handler : function () {};
    },
    onStarted(handler) {
      handlers.started = typeof handler === "function" ? handler : function () {};
    },
    onPending(handler) {
      handlers.pending = typeof handler === "function" ? handler : function () {};
    }
  };
}

module.exports = {
  DEFAULT_DURATION_MS,
  DEFAULT_START_WAIT_MS,
  classifyWechatSIError,
  createWechatSIEngine
};
