/**
 * Independent pre-integration harness for grandpas-new-ears @ f8f68ab.
 * Lives outside the git repo. Does not modify production files.
 *
 * The plugin fake is passive: start/stop only record calls. Callbacks fire
 * only when a test emits them. It does not auto-send -30011, -30012, or onStop.
 *
 * Replay:
 *   node /opt/cursor/artifacts/independent-acceptance/harness.mjs
 */
import fs from "fs";
import path from "path";
import { runInThisContext } from "vm";
import { fileURLToPath } from "url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miniRoot = path.join(repo, "miniprogram");
const outDir = process.env.INDEPENDENT_OUT || path.join(repo, "build", "independent-acceptance");
const cjsCache = new Map();
const cases = [];

function loadCjs(file) {
  const resolved = path.resolve(file);
  if (cjsCache.has(resolved)) return cjsCache.get(resolved).exports;
  const module = { exports: {} };
  cjsCache.set(resolved, module);
  const code = fs.readFileSync(resolved, "utf8");
  const dirname = path.dirname(resolved);
  function cjsRequire(request) {
    if (!request.startsWith(".")) throw new Error("unexpected import " + request);
    const target = path.resolve(dirname, request);
    return loadCjs(target.endsWith(".js") ? target : target + ".js");
  }
  const wrapper = "(function (exports, require, module, __filename, __dirname) {\n" + code + "\n})";
  runInThisContext(wrapper, { filename: resolved })(module.exports, cjsRequire, module, resolved, dirname);
  return module.exports;
}

let now = 0;
let timerSeq = 1;
const timers = new Map();

function installClock() {
  const setTimer = (fn, ms) => {
    const id = timerSeq++;
    timers.set(id, { fn, due: now + Number(ms || 0) });
    return id;
  };
  const clearTimer = (id) => {
    timers.delete(id);
  };
  global.setTimeout = setTimer;
  global.clearTimeout = clearTimer;
  globalThis.setTimeout = setTimer;
  globalThis.clearTimeout = clearTimer;
}

function advance(ms) {
  const target = now + ms;
  let guard = 0;
  while (guard++ < 20000) {
    let nextId = null;
    let nextDue = Infinity;
    for (const [id, timer] of timers) {
      if (timer.due <= target && timer.due < nextDue) {
        nextDue = timer.due;
        nextId = id;
      }
    }
    if (nextId == null) {
      now = target;
      return;
    }
    now = nextDue;
    const timer = timers.get(nextId);
    timers.delete(nextId);
    timer.fn();
  }
  throw new Error("timer loop exceeded");
}

function delays() {
  return Array.from(timers.values()).map((timer) => timer.due - now).sort((a, b) => a - b);
}

async function micro(turns = 12) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function createPassive() {
  return {
    starts: [],
    stops: 0,
    start(options) {
      this.starts.push({
        duration: options && options.duration,
        lang: options && options.lang,
        keys: Object.keys(options || {}).sort(),
        audioSource: options && options.audioSource
      });
    },
    stop() {
      this.stops += 1;
    },
    emitStart() {
      if (typeof this.onStart === "function") this.onStart({ msg: "Ok" });
    },
    emitRecognize(result) {
      if (typeof this.onRecognize === "function") this.onRecognize({ result });
    },
    emitStop(result, extra) {
      if (typeof this.onStop === "function") {
        this.onStop(Object.assign({
          result: result == null ? "" : result,
          tempFilePath: "wxfile://tmp/independent.silk",
          duration: 1200,
          fileSize: 32
        }, extra || {}));
      }
    },
    emitError(retcode, msg) {
      if (typeof this.onError === "function") {
        this.onError({ retcode, msg: msg || "independent" });
      }
    }
  };
}

let currentManager = null;
let pluginMode = "ok";
let pageDef = null;
let wxState = null;

function createWx(state) {
  const storage = {};
  const api = {
    appHides: [],
    modals: [],
    storage,
    authorizeCalls: 0,
    storageWrites: [],
    getAccountInfoSync() {
      if (state.account === "throw") throw new Error("account unavailable");
      if (state.account === "missing") return {};
      return { miniProgram: { appId: state.appId } };
    },
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : "";
    },
    setStorageSync(key, value) {
      storage[key] = value;
      api.storageWrites.push(key);
    },
    setKeepScreenOn() {},
    onAppHide(fn) {
      api.appHides.push(fn);
    },
    offAppHide(fn) {
      const index = api.appHides.indexOf(fn);
      if (index >= 0) api.appHides.splice(index, 1);
    },
    getPrivacySetting(options) {
      if (state.privacyFail) {
        options.fail({ errMsg: "getPrivacySetting:fail" });
        return;
      }
      options.success({
        needAuthorization: state.needPrivacy === true,
        privacyContractName: "《测试隐私保护指引》"
      });
    },
    getSetting(options) {
      const auth = {};
      if (state.record === true) auth["scope.record"] = true;
      if (state.record === false) auth["scope.record"] = false;
      options.success({ authSetting: auth });
    },
    authorize(options) {
      api.authorizeCalls += 1;
      api._authorize = options;
      if (state.autoAuthorize === "allow") options.success();
      if (state.autoAuthorize === "deny") {
        options.fail(state.authorizeError || { errMsg: "authorize:fail auth deny" });
      }
    },
    openSetting(options) {
      if (state.settingOpens === false) {
        options.fail({ errMsg: "openSetting:fail" });
        return;
      }
      options.success({
        authSetting: state.settingGrant === true ? { "scope.record": true } : { "scope.record": false }
      });
    },
    openPrivacyContract(options) {
      if (state.contractFails) options.fail({ errMsg: "openPrivacyContract:fail" });
      else options.success({});
    },
    showModal(options) {
      api.modals.push({
        title: options.title,
        content: options.content,
        confirmText: options.confirmText,
        cancelText: options.cancelText
      });
      options.success({ confirm: state.save === true, cancel: state.save !== true });
    },
    navigateTo() {},
    nextTick(fn) {
      fn();
    }
  };
  return api;
}

function installPlugin() {
  global.requirePlugin = function requirePlugin() {
    if (pluginMode === "throw") throw new Error("plugin missing");
    if (pluginMode === "bad") return {};
    return {
      getRecordRecognitionManager() {
        return currentManager;
      }
    };
  };
}

function createPage() {
  const page = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData(patch, callback) {
      Object.assign(page.data, patch);
      if (typeof callback === "function") callback();
    }
  };
  Object.keys(pageDef).forEach((key) => {
    if (typeof pageDef[key] === "function") page[key] = pageDef[key].bind(page);
  });
  return page;
}

async function boot(partial) {
  timers.clear();
  now = 0;
  const state = Object.assign({
    appId: "wx-independent",
    needPrivacy: false,
    record: true,
    plugin: "ok"
  }, partial || {});
  wxState = state;
  pluginMode = state.plugin;
  currentManager = createPassive();
  global.wx = createWx(state);
  installPlugin();
  const page = createPage();
  page.onLoad();
  page.onShow();
  await micro();
  return page;
}

async function finishAuthorize(ok, error) {
  const pending = global.wx._authorize;
  if (!pending) throw new Error("authorize was not called");
  if (ok) pending.success();
  else pending.fail(error || { errMsg: "authorize:fail" });
  await micro();
}

function texts(page) {
  return page.data.segments.map((segment) => segment.text);
}

function listening(page) {
  return page.data.listening === true && page.data.statusLabel === "正在听";
}

function record(name, status, detail) {
  cases.push({ name, status, detail });
}

function check(name, condition, detail) {
  record(name, condition ? "PASS" : "FAIL", detail);
}

async function listen(page) {
  page.onStart();
  await micro();
  currentManager.emitStart();
  await micro();
}

installClock();
global.Page = (definition) => {
  pageDef = definition;
};
installPlugin();
loadCjs(path.join(miniRoot, "pages/index/index.js"));
const engineExports = loadCjs(path.join(miniRoot, "engines/wechat-si.js"));

async function main() {
  const head = "workspace";

  await (async () => {
    const page = await boot();
    check("constants", engineExports.DEFAULT_DURATION_MS === 30000 && engineExports.DEFAULT_START_WAIT_MS === 8000, "DEFAULT_DURATION_MS=" + engineExports.DEFAULT_DURATION_MS + " DEFAULT_START_WAIT_MS=" + engineExports.DEFAULT_START_WAIT_MS);
    page.onStart();
    await micro();
    const first = currentManager.starts[0];
    check("start-shape", currentManager.starts.length === 1 && first.duration === 30000 && first.lang === "zh_CN" && first.keys.join(",") === "duration,lang" && first.audioSource === undefined, JSON.stringify(first));
    check("before-onStart-not-listening", !listening(page) && page.data.statusLabel === "正在打开麦克风" && delays().includes(8000), "label=" + page.data.statusLabel + " listening=" + page.data.listening + " timers=" + delays().join(","));
    currentManager.emitStart();
    await micro();
    check("onStart-then-listening", listening(page) && !delays().includes(8000) && !delays().some((ms) => ms >= 30000), "label=" + page.data.statusLabel + " timers=" + delays().join(","));
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitRecognize("你好");
    advance(120);
    await micro();
    check("interim-visible", page.data.partialText === "你好", "partial=" + page.data.partialText);
    currentManager.emitStop("你好世界");
    advance(200);
    await micro();
    check("interim-then-longer-final-once", texts(page).join("|") === "你好世界" && page.data.partialText === "" && !JSON.stringify(page.data).includes("wxfile"), "texts=" + texts(page).join("|") + " partial=" + JSON.stringify(page.data.partialText));
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitRecognize("同一句");
    advance(120);
    currentManager.emitStop("同一句");
    advance(400);
    await micro();
    check("interim-final-same-not-duplicated", texts(page).join("|") === "同一句" && page.data.partialText === "", "texts=" + texts(page).join("|") + " partial=" + JSON.stringify(page.data.partialText) + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitStop("   ");
    advance(50);
    await micro();
    check("blank-final-dropped", texts(page).length === 0, "texts=" + texts(page).length);
    currentManager.emitStop("");
    advance(50);
    await micro();
    check("empty-final-dropped", texts(page).length === 0, "texts=" + texts(page).length + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitStop("同一句");
    advance(400);
    await micro();
    currentManager.emitStop("同一句");
    advance(50);
    await micro();
    check("adjacent-duplicate-dropped", texts(page).join("|") === "同一句", "texts=" + texts(page).join("|"));
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    const longText = "字".repeat(4000) + "🙂" + "e\u0301" + "\u200b尾";
    currentManager.emitStop(longText);
    await micro();
    check("long-unicode-kept", texts(page)[0] === longText && texts(page)[0].length === longText.length, "len=" + (texts(page)[0] || "").length + " expected=" + longText.length);
  })();

  await (async () => {
    const format = loadCjs(path.join(miniRoot, "utils/format.js"));
    check("normalize-ideographic-space", format.normalizeCaption("你好\u3000世界") === "你好 世界", JSON.stringify(format.normalizeCaption("你好\u3000世界")));
    const page = await boot();
    await listen(page);
    currentManager.emitStop("你好\u3000世界");
    await micro();
    check("page-keeps-ideographic-space-as-one-space", texts(page).join("|") === "你好 世界", JSON.stringify(texts(page)));
    const gapStarts = currentManager.starts.length;
    currentManager.emitStop("间隙里的第二句");
    await micro();
    record("onStop-during-restart-gap", texts(page).join("|") === "你好 世界|间隙里的第二句" ? "PASS" : "FAIL", "texts=" + JSON.stringify(texts(page)) + " startsBeforeAdvance=" + gapStarts + " timers=" + delays().join(","));
    const zw = await boot();
    await listen(zw);
    currentManager.emitStop("你好");
    advance(300);
    await micro();
    currentManager.emitStart();
    await micro();
    currentManager.emitStop("你好\u200b");
    await micro();
    check("zwsp-not-deduped", texts(zw).join("|") === "你好|你好\u200b", JSON.stringify(texts(zw)));
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    currentManager.emitRecognize("还没开始的临时");
    advance(200);
    currentManager.emitStop("正式先到");
    await micro();
    const before = {
      label: page.data.statusLabel,
      listening: page.data.listening,
      texts: texts(page),
      starts: currentManager.starts.length,
      timers: delays()
    };
    advance(300);
    await micro();
    record("final-before-onStart", "INFO", JSON.stringify({ before, afterStarts: currentManager.starts.length, afterLabel: page.data.statusLabel, timers: delays() }));
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    const starts = currentManager.starts.length;
    page.onStart();
    page.onStart();
    await micro();
    check("repeat-start-while-listening", currentManager.starts.length === starts && listening(page), "starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    const stops = currentManager.stops;
    const starts = currentManager.starts.length;
    advance(30000);
    await micro();
    record("no-client-stop-at-30s", currentManager.stops === stops && currentManager.starts.length === starts && listening(page) ? "FAIL" : "PASS", "30 秒推进后客户端没有调用 stop，界面仍是正在听。starts=" + currentManager.starts.length + " stops=" + currentManager.stops + " label=" + page.data.statusLabel + " timers=" + JSON.stringify(delays()));
    currentManager.emitStop("满三十一句");
    await micro();
    const seam = {
      label: page.data.statusLabel,
      listening: listening(page),
      starts: currentManager.starts.length,
      timers: delays()
    };
    check("seam-not-listening-before-next-onStart", seam.listening === false, JSON.stringify(seam));
    advance(300);
    await micro();
    check("rollover-starts-only-after-onStop", currentManager.starts.length === starts + 1 && currentManager.starts[1].duration === 30000, "starts=" + currentManager.starts.length + " second=" + JSON.stringify(currentManager.starts[1]));
    check("rollover-still-not-listening-until-onStart", !listening(page), "label=" + page.data.statusLabel + " listening=" + page.data.listening);
    currentManager.emitStart();
    await micro();
    check("rollover-listens-after-second-onStart", listening(page) && texts(page).join("|") === "满三十一句", "label=" + page.data.statusLabel + " texts=" + texts(page).join("|"));
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30004);
    await micro();
    check("first-network-retries-without-listening", page.data.statusLabel === "正在重新连接" && !listening(page) && currentManager.starts.length === 1, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
    advance(300);
    await micro();
    check("one-network-retry-start", currentManager.starts.length === 2, "starts=" + currentManager.starts.length);
    currentManager.emitStart();
    currentManager.emitError(-30004);
    await micro();
    const starts = currentManager.starts.length;
    advance(10000);
    await micro();
    check("second-network-stops-for-good", page.data.statusLabel === "网络异常" && !listening(page) && currentManager.starts.length === starts, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length + " expected=" + starts);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30006);
    advance(300);
    await micro();
    currentManager.emitStart();
    currentManager.emitError(-30006);
    await micro();
    advance(5000);
    check("timeout-not-called-network", page.data.statusLabel === "识别超时" && !listening(page) && currentManager.starts.length === 2, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30003);
    advance(300);
    await micro();
    currentManager.emitError(-30003);
    await micro();
    check("transmission-copy", page.data.statusLabel === "没有听完整" && !listening(page), "label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30001);
    await micro();
    advance(5000);
    check("recording-interface-error-stops", !listening(page) && currentManager.starts.length === 1, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
    record("recording-interface-error-copy", page.data.statusLabel === "麦克风未授权" ? "FAIL" : "PASS", "官方文案是「录音接口出错」。页面标题=" + page.data.statusLabel + " detail=" + page.data.statusDetail);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30005);
    await micro();
    advance(3000);
    check("internal-error-not-retried-as-network", page.data.statusLabel === "识别失败" && currentManager.starts.length === 1, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30011);
    await micro();
    check("injected-30011-does-not-stop-ui", listening(page) && currentManager.starts.length === 1, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitRecognize("完整的一句");
    advance(120);
    page.onPause();
    await micro();
    check("pause-waits-for-stop", page.data.statusLabel === "已暂停" && !listening(page) && currentManager.stops === 1, "label=" + page.data.statusLabel + " stops=" + currentManager.stops + " timers=" + delays().join(","));
    advance(500);
    currentManager.emitStop("完整的一句，停得及");
    await micro();
    check("onStop-within-1600-kept", texts(page).join("|") === "完整的一句，停得及", "texts=" + texts(page).join("|"));
    advance(5000);
    check("pause-does-not-autostart", currentManager.starts.length === 1 && !listening(page), "starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitRecognize("只有前半");
    advance(120);
    page.onPause();
    await micro();
    advance(1600);
    await micro();
    const flushed = texts(page).join("|");
    currentManager.emitStop("只有前半，后半在正式结果里");
    await micro();
    advance(1000);
    const lost = texts(page).join("|") !== "只有前半，后半在正式结果里";
    record("late-onStop-after-1600", lost ? "FAIL" : "PASS", "flushed=" + flushed + " finalTexts=" + texts(page).join("|") + " starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onPause();
    await micro();
    advance(1600);
    await micro();
    currentManager.emitStop("整句只在迟到的正式结果");
    await micro();
    record("late-onStop-without-interim", texts(page).join("|") === "整句只在迟到的正式结果" ? "PASS" : "FAIL", "texts=" + JSON.stringify(texts(page)) + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    const starts = currentManager.starts.length;
    page.onPause();
    await micro();
    page.onStart();
    await micro();
    check("continue-while-stop-pending-does-not-start-yet", currentManager.starts.length === starts, "starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
    advance(1600);
    await micro();
    advance(2400);
    await micro();
    const afterSilent = {
      starts: currentManager.starts.length,
      label: page.data.statusLabel,
      listening: page.data.listening
    };
    page.onStart();
    await micro();
    record("continue-after-silent-stop", "INFO", JSON.stringify({
      afterSilent,
      afterTapStarts: currentManager.starts.length,
      label: page.data.statusLabel,
      timers: delays()
    }));
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    const originalStop = currentManager.stop.bind(currentManager);
    currentManager.stop = function stopWith30012() {
      originalStop();
      this.emitError(-30012, "no task");
    };
    page.onPause();
    await micro();
    page.onStart();
    await micro();
    record("stop-before-onStart-with-30012", "INFO", JSON.stringify({
      starts: currentManager.starts.length,
      label: page.data.statusLabel,
      listening: listening(page),
      opening: page.data.opening
    }));
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    currentManager.emitStop("");
    let emitted = 1;
    for (let i = 0; i < 5; i += 1) {
      advance(300);
      await micro();
      emitted += 1;
      currentManager.emitStop("");
    }
    const loopStarts = currentManager.starts.length;
    page.onPause();
    await micro();
    advance(2000);
    await micro();
    record("onStop-without-onStart-loop", loopStarts > 3 ? "FAIL" : "PASS", "starts=" + loopStarts + " emptyOnStops=" + emitted + " labelBeforePause=" + page.data.statusLabel + " startsAfterPause=" + currentManager.starts.length + " listening=" + page.data.listening + " timers=" + delays().join(","));
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onHide();
    await micro();
    const starts = currentManager.starts.length;
    const label = page.data.statusLabel;
    page.onShow();
    await micro();
    advance(5000);
    await micro();
    check("show-does-not-resume", !listening(page) && currentManager.starts.length === starts && label === "已暂停", "hideLabel=" + label + " now=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
    currentManager.emitStart();
    currentManager.emitStop("离开后的迟到句子");
    await micro();
    check("late-callback-after-hide-not-listening", !listening(page), "label=" + page.data.statusLabel + " texts=" + texts(page).join("|") + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onUnload();
    await micro();
    currentManager.emitStart();
    currentManager.emitRecognize("卸载后");
    advance(200);
    currentManager.emitStop("卸载后");
    advance(5000);
    await micro();
    check("unload-drops-late-caption-and-does-not-restart", texts(page).length === 0 && page.data.partialText !== "卸载后", "texts=" + texts(page).join("|") + " partial=" + page.data.partialText + " starts=" + currentManager.starts.length + " hides=" + global.wx.appHides.length);
  })();

  await (async () => {
    const page = await boot();
    const hides = global.wx.appHides.length;
    page.onLoad();
    await listen(page);
    currentManager.emitStop("只记一次");
    await micro();
    check("second-onLoad-one-listener", global.wx.appHides.length === hides && texts(page).join("|") === "只记一次", "hides=" + global.wx.appHides.length + " texts=" + texts(page).join("|"));
  })();

  await (async () => {
    const page = await boot({ save: false });
    await listen(page);
    const originalStop = currentManager.stop.bind(currentManager);
    currentManager.stop = function stopWithText() {
      originalStop();
      this.emitStop("只保存文字");
    };
    page.onPause();
    await micro();
    await page.onStop();
    const saved = JSON.stringify(global.wx.storage["gne:history"] || null);
    check("cancel-save-stores-nothing", global.wx.modals.length === 1 && saved === "null", "modal=" + JSON.stringify(global.wx.modals[0]) + " saved=" + saved);
    wxState.save = true;
    page.onStart();
    await micro();
    currentManager.emitStart();
    await micro();
    page.onPause();
    await micro();
    await page.onStop();
    const body = JSON.stringify(global.wx.storage["gne:history"] || null);
    check("confirm-saves-text-only", body.includes("只保存文字") && !body.includes("wxfile") && !body.includes("tempFile") && !body.includes(".silk"), body);
  })();

  await (async () => {
    const page = await boot({ needPrivacy: true, record: undefined });
    check("privacy-required-before-tap", page.data.privacyNeeded === true && page.data.statusLabel === "请先同意", "label=" + page.data.statusLabel);
    page.onStart();
    await micro();
    check("ordinary-start-does-not-skip-agree", currentManager.starts.length === 0 && global.wx.authorizeCalls === 0, "starts=" + currentManager.starts.length + " authorize=" + global.wx.authorizeCalls);
    page.onDeclinePrivacy();
    await micro();
    check("decline-does-not-record", currentManager.starts.length === 0 && page.data.statusLabel === "还未同意", "label=" + page.data.statusLabel);
    page.onAgreePrivacy();
    await micro();
    check("agree-asks-record-not-listening", global.wx.authorizeCalls === 1 && currentManager.starts.length === 0 && !listening(page), "authorize=" + global.wx.authorizeCalls + " label=" + page.data.statusLabel);
    await finishAuthorize(false, { errno: 112, errMsg: "authorize:fail api scope is not declared in the privacy agreement" });
    check("errno-112-no-record", currentManager.starts.length === 0 && page.data.statusLabel === "指引未生效" && page.data.privacyBlocked === true && page.data.micDenied !== true, "label=" + page.data.statusLabel + " blocked=" + page.data.privacyBlocked + " micDenied=" + page.data.micDenied);
  })();

  await (async () => {
    const page = await boot({ needPrivacy: false, record: false });
    check("scope-denied-visible", page.data.statusLabel === "麦克风未授权" && page.data.micDenied === true, "label=" + page.data.statusLabel);
    page.onStart();
    await micro();
    check("scope-denied-no-start", currentManager.starts.length === 0, "starts=" + currentManager.starts.length);
    wxState.settingGrant = false;
    page.onOpenSetting();
    await micro();
    check("settings-still-denied", page.data.statusLabel === "麦克风未授权" && !listening(page), "label=" + page.data.statusLabel);
    wxState.settingGrant = true;
    page.onOpenSetting();
    await micro();
    check("settings-grant-waits-for-another-tap", page.data.statusLabel === "麦克风已允许" && !listening(page) && currentManager.starts.length === 0, "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
    page.onStart();
    await micro();
    check("second-tap-opens-mic-before-onStart", page.data.statusLabel === "正在打开麦克风" && !listening(page) && currentManager.starts.length === 1, "label=" + page.data.statusLabel);
    currentManager.emitStart();
    await micro();
    check("second-tap-listens-after-onStart", listening(page), "label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onPause();
    await micro();
    wxState.needPrivacy = true;
    page.onShow();
    await micro();
    const starts = currentManager.starts.length;
    page.onStart();
    await micro();
    check("revoked-privacy-does-not-resume", page.data.privacyNeeded === true && currentManager.starts.length === starts && !listening(page), "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot({ privacyFail: true, record: undefined });
    page.onStart();
    await micro();
    record("privacy-query-fail-does-not-block", global.wx.authorizeCalls === 1 ? "RISK" : "PASS", "authorizeCalls=" + global.wx.authorizeCalls + " label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot({ appId: "touristappid" });
    page.onStart();
    await micro();
    check("tourist-does-not-start", currentManager.starts.length === 0 && page.data.statusLabel === "还没有 AppID" && !listening(page), "label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot({ plugin: "throw" });
    page.onStart();
    await micro();
    check("plugin-throw-does-not-start", currentManager.starts.length === 0 && page.data.statusLabel === "插件不可用", "label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot({ plugin: "bad" });
    page.onStart();
    await micro();
    check("plugin-bad-shape-does-not-start", currentManager.starts.length === 0 && page.data.statusLabel === "插件不可用", "label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot({ account: "throw" });
    page.onStart();
    await micro();
    check("unknown-account-still-reaches-plugin", currentManager.starts.length === 1 && page.data.statusLabel === "正在打开麦克风", "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    global.wx.appHides[0]();
    page.onHide();
    await micro();
    advance(5000);
    check("duplicate-hide-does-not-resume", !listening(page) && currentManager.starts.length === 1, "stops=" + currentManager.stops + " starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const finals = [];
    const errors = [];
    const mgr = createPassive();
    const pending = new Map();
    let seq = 1;
    const schedule = (fn) => {
      const id = seq++;
      pending.set(id, fn);
      return id;
    };
    const engine = engineExports.createWechatSIEngine({
      loadManager: () => mgr,
      schedule,
      cancel: (id) => pending.delete(id),
      restartDelay: 0,
      stopTimeout: 5000,
      startWait: 8000
    });
    engine.onFinal((text) => finals.push(text));
    engine.onError((error) => errors.push(error.code));
    await engine.start({ lang: "zh_CN" });
    mgr.emitStart();
    const stopping = engine.stop();
    const restarted = engine.start({ lang: "zh_CN" });
    const startsBeforeLate = mgr.starts.length;
    mgr.emitStop("上一段的正式结果");
    for (let i = 0; i < 5; i += 1) {
      const fns = Array.from(pending.values());
      pending.clear();
      fns.forEach((fn) => fn());
      await Promise.resolve();
    }
    await Promise.race([
      Promise.all([stopping, restarted]),
      Promise.resolve("pending")
    ]);
    record("engine-start-during-inflight-stop", "INFO", JSON.stringify({
      startsBeforeLate,
      starts: mgr.starts.length,
      finals,
      errors,
      pending: pending.size
    }));
  })();

  record("os-microphone-versus-privacy", "NOT_RUN", "代码没有系统麦克风 API。scope.record、隐私 needAuthorization、插件 -30001 是三条不同分支；手机系统弹窗、审核中指引、领夹麦输入都没有跑。");
  record("wechat-devtools-and-device", "NOT_RUN", "没有打开微信开发者工具，没有真机，没有真实插件回调。");

  const counts = cases.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    commit: head,
    harness: "passive plugin fake; callbacks only when emitted",
    counts,
    cases
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "harness-results.json"), JSON.stringify(summary, null, 2));
  const lines = ["commit " + head, "counts " + JSON.stringify(counts), ""];
  cases.forEach((item) => {
    lines.push(item.status + "\t" + item.name + "\t" + item.detail);
  });
  fs.writeFileSync(path.join(outDir, "harness-results.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (counts.FAIL) {
    console.error("independent harness failures: " + counts.FAIL);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
