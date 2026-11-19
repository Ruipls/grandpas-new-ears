/**
 * Behavioral reacceptance for 75c20192. Not part of the git repo.
 *
 * The archived probe scripts/independent-harness.mjs is left unchanged.
 * Two of its FAILs are not product failures:
 * - onStart-then-listening demands that no timer >= 30000 exist after onStart.
 *   A fallback that waits for the plugin's own 30000ms duration must be >= 30000.
 *   190fa6b used duration-1 (29999) to satisfy that assertion. 75c2019 must not.
 * - no-client-stop-at-30s fails if stop() has not been called at exactly 30000
 *   while the UI still says 正在听. The plugin is documented to stop itself at
 *   duration; 2000ms of grace before one client stop is the stated policy.
 *
 * This file checks that policy with a passive manager and stepped clocks.
 * Replay: node /opt/cursor/artifacts/reacceptance-75c2019/behavioral-harness.mjs
 */
import fs from "fs";
import path from "path";
import { runInThisContext } from "vm";
import { fileURLToPath } from "url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miniRoot = path.join(repo, "miniprogram");
const outDir = process.env.BEHAVIORAL_OUT || path.join(repo, "build", "behavioral");
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
  global.setTimeout = setTimer;
  global.clearTimeout = (id) => timers.delete(id);
  globalThis.setTimeout = setTimer;
  globalThis.clearTimeout = (id) => timers.delete(id);
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
  throw new Error("timer loop");
}

function delays() {
  return Array.from(timers.values()).map((timer) => timer.due - now).sort((a, b) => a - b);
}

async function micro() {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
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
    emitStop(result) {
      if (typeof this.onStop === "function") {
        this.onStop({
          result: result == null ? "" : result,
          tempFilePath: "wxfile://tmp/behavioral.silk",
          duration: 1200,
          fileSize: 32
        });
      }
    },
    emitError(retcode, msg) {
      if (typeof this.onError === "function") this.onError({ retcode, msg: msg || "behavioral" });
    }
  };
}

let currentManager = null;
let pluginMode = "ok";
let pageDef = null;
let wxState = null;

function createWx(state) {
  const storage = {};
  return {
    appHides: [],
    modals: [],
    storage,
    authorizeCalls: 0,
    getAccountInfoSync() {
      return { miniProgram: { appId: state.appId || "wx-behavioral" } };
    },
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : "";
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    setKeepScreenOn() {},
    onAppHide(fn) {
      this.appHides.push(fn);
    },
    offAppHide(fn) {
      const index = this.appHides.indexOf(fn);
      if (index >= 0) this.appHides.splice(index, 1);
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
      this.authorizeCalls += 1;
      options.success();
    },
    openSetting(options) {
      options.success({ authSetting: {} });
    },
    openPrivacyContract(options) {
      options.success({});
    },
    showModal(options) {
      this.modals.push(options);
      options.success({ confirm: state.save === true, cancel: state.save !== true });
    },
    navigateTo() {},
    nextTick(fn) {
      fn();
    }
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
    appId: "wx-behavioral",
    needPrivacy: false,
    record: true,
    plugin: "ok",
    save: false
  }, partial || {});
  wxState = state;
  pluginMode = state.plugin;
  currentManager = createPassive();
  global.wx = createWx(state);
  global.requirePlugin = function () {
    if (pluginMode === "throw") throw new Error("plugin missing");
    if (pluginMode === "bad") return {};
    return { getRecordRecognitionManager: () => currentManager };
  };
  const page = createPage();
  page.onLoad();
  page.onShow();
  await micro();
  return page;
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
loadCjs(path.join(miniRoot, "pages/index/index.js"));
const engineExports = loadCjs(path.join(miniRoot, "engines/wechat-si.js"));
const engineSource = fs.readFileSync(path.join(miniRoot, "engines/wechat-si.js"), "utf8");

async function main() {
  check(
    "constants-not-29999",
    engineExports.DEFAULT_DURATION_MS === 30000 &&
      engineExports.DEFAULT_SEGMENT_GRACE_MS === 2000 &&
      engineExports.DEFAULT_STOP_CONFIRM_MS === 8000 &&
      engineExports.DEFAULT_START_WAIT_MS === 8000 &&
      !engineSource.includes("29999") &&
      !engineSource.includes("duration - 1"),
    "duration=" + engineExports.DEFAULT_DURATION_MS +
      " grace=" + engineExports.DEFAULT_SEGMENT_GRACE_MS +
      " confirm=" + engineExports.DEFAULT_STOP_CONFIRM_MS
  );

  await (async () => {
    const page = await boot();
    await listen(page);
    check("duration-passed-30000", currentManager.starts[0].duration === 30000 && currentManager.starts[0].keys.join(",") === "duration,lang" && delays().join(",") === "32000", "start=" + JSON.stringify(currentManager.starts[0]) + " timers=" + delays().join(","));
    advance(10000);
    advance(10000);
    advance(10000);
    await micro();
    check("stepped-30s-no-client-stop", currentManager.stops === 0 && currentManager.starts.length === 1 && listening(page) && delays().join(",") === "2000", "stops=" + currentManager.stops + " label=" + page.data.statusLabel + " timers=" + delays().join(","));
    advance(2000);
    await micro();
    check("at-32s-stop-once-and-not-listening", currentManager.stops === 1 && currentManager.starts.length === 1 && !listening(page) && page.data.statusLabel !== "正在听", "stops=" + currentManager.stops + " label=" + page.data.statusLabel + " listening=" + page.data.listening);
    advance(1000);
    await micro();
    check("fallback-stop-not-repeated", currentManager.stops === 1 && currentManager.starts.length === 1, "stops=" + currentManager.stops + " starts=" + currentManager.starts.length);
    advance(7000);
    await micro();
    const starts = currentManager.starts.length;
    const label = page.data.statusLabel;
    advance(10000);
    await micro();
    check("no-onStop-ends-and-stays-ended", currentManager.stops === 1 && currentManager.starts.length === starts && starts === 1 && !listening(page), "labelAtDeadline=" + label + " later=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    advance(31000);
    await micro();
    check("inside-grace-plugin-onStop-not-preempted", currentManager.stops === 0 && listening(page), "stops=" + currentManager.stops);
    currentManager.emitStop("三十一秒的正式结果");
    await micro();
    check("plugin-onStop-kept-and-not-listening-yet", texts(page).join("|") === "三十一秒的正式结果" && !listening(page), "texts=" + texts(page).join("|") + " label=" + page.data.statusLabel);
    advance(300);
    await micro();
    check("next-segment-waits-for-onStart", currentManager.starts.length === 2 && !listening(page) && currentManager.stops === 0, "starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
    currentManager.emitStart();
    await micro();
    check("second-onStart-is-listening", listening(page), "label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    advance(32000);
    await micro();
    currentManager.emitStop("兜底 stop 之后的正式结果");
    await micro();
    check("onStop-during-confirm-kept-and-may-continue", texts(page).join("|") === "兜底 stop 之后的正式结果" && !listening(page), "texts=" + JSON.stringify(texts(page)) + " label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
    advance(300);
    await micro();
    check("confirm-window-onStop-continues-one-segment", currentManager.starts.length === 2 && currentManager.stops === 1, "starts=" + currentManager.starts.length + " stops=" + currentManager.stops);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    advance(40000);
    await micro();
    currentManager.emitStop("超过确认窗的正式结果");
    await micro();
    advance(10000);
    check("final-after-hard-deadline-kept-without-new-start", texts(page).join("|") === "超过确认窗的正式结果" && currentManager.starts.length === 1 && !listening(page), "texts=" + JSON.stringify(texts(page)) + " starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
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
    check("pause-provisional-at-1600", texts(page).join("|") === "只有前半" && !listening(page), "texts=" + JSON.stringify(texts(page)) + " label=" + page.data.statusLabel);
    advance(8400);
    currentManager.emitStop("只有前半，十秒后的后半");
    await micro();
    advance(5000);
    check("pause-final-at-10s-replaces-provisional", texts(page).join("|") === "只有前半，十秒后的后半" && currentManager.starts.length === 1 && !listening(page), "texts=" + JSON.stringify(texts(page)) + " starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onPause();
    await micro();
    advance(10000);
    currentManager.emitStop("十秒后才到的正式结果");
    await micro();
    advance(5000);
    check("pause-final-at-10s-without-interim", texts(page).join("|") === "十秒后才到的正式结果" && currentManager.starts.length === 1 && page.data.statusLabel === "已暂停", "texts=" + JSON.stringify(texts(page)) + " starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitStop("要结束的一句");
    await micro();
    const ending = page.onStop();
    await micro();
    advance(1600);
    await ending;
    const saved = JSON.stringify(global.wx.storage["gne:history"] || null);
    currentManager.emitStop("结束后的句子");
    advance(5000);
    await micro();
    check("end-then-late-final-not-shown-or-saved", texts(page).length === 0 && saved === "null" && !JSON.stringify(global.wx.storage).includes("wxfile") && currentManager.starts.length === 1, "texts=" + JSON.stringify(texts(page)) + " saved=" + saved + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    advance(10000);
    page.onHide();
    await micro();
    const stops = currentManager.stops;
    advance(40000);
    currentManager.emitStop("离开后补上的正式结果");
    await micro();
    page.onShow();
    await micro();
    advance(5000);
    check("hide-cancels-fallback-and-keeps-late-final", currentManager.stops === stops && texts(page).join("|") === "离开后补上的正式结果" && !listening(page) && currentManager.starts.length === 1, "stops=" + currentManager.stops + " texts=" + JSON.stringify(texts(page)) + " label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onUnload();
    await micro();
    advance(50000);
    currentManager.emitStop("卸载后不该出现");
    currentManager.emitStart();
    await micro();
    check("unload-drops-late-final-and-does-not-start", texts(page).length === 0 && currentManager.starts.length === 1, "texts=" + JSON.stringify(texts(page)) + " starts=" + currentManager.starts.length + " stops=" + currentManager.stops);
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    for (let i = 0; i < 5; i += 1) {
      currentManager.emitStop("");
      advance(300);
      await micro();
    }
    const starts = currentManager.starts.length;
    advance(20000);
    await micro();
    check("onStop-before-onStart-bounded", starts === 2 && currentManager.starts.length === 2 && !listening(page), "startsAfterFive=" + starts + " later=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitStop("第一句");
    await micro();
    check("seam-not-listening", !listening(page) && texts(page).join("|") === "第一句", "label=" + page.data.statusLabel + " listening=" + page.data.listening);
    currentManager.emitStop("间隙里的第二句");
    await micro();
    check("gap-second-result-kept-not-duplicated", texts(page).join("|") === "第一句|间隙里的第二句", JSON.stringify(texts(page)));
    currentManager.emitStop("间隙里的第二句");
    await micro();
    check("gap-identical-result-not-duplicated", texts(page).join("|") === "第一句|间隙里的第二句", JSON.stringify(texts(page)));
    advance(300);
    await micro();
    check("restart-not-listening-before-onStart", currentManager.starts.length >= 2 && !listening(page), "starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitStop("只有正式结果");
    await micro();
    check("final-without-onRecognize", texts(page).join("|") === "只有正式结果" && page.data.partialText === "", JSON.stringify(texts(page)) + " partial=" + page.data.partialText);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onPause();
    await micro();
    advance(2000);
    currentManager.emitError(-30004);
    currentManager.emitStop("暂停后的旧错误不该再开");
    await micro();
    advance(20000);
    check("stale-callback-after-pause-does-not-start", currentManager.starts.length === 1 && !listening(page), "starts=" + currentManager.starts.length + " texts=" + JSON.stringify(texts(page)) + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    page.onPause();
    await micro();
    advance(9600);
    await micro();
    page.onStart();
    await micro();
    currentManager.emitStart();
    await micro();
    const before = currentManager.starts.length;
    currentManager.emitStop("分不清是不是上一段");
    await micro();
    advance(300);
    await micro();
    record(
      "onStop-after-new-onStart-is-indistinguishable",
      "INFO",
      "startsBefore=" + before + " startsAfter=" + currentManager.starts.length + " texts=" + JSON.stringify(texts(page)) + " label=" + page.data.statusLabel + ". No plugin session id, so this onStop is handled as the current segment."
    );
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    const original = currentManager.stop.bind(currentManager);
    currentManager.stop = function () {
      original();
      this.emitError(-30012, "no task");
    };
    page.onPause();
    await micro();
    page.onStart();
    await micro();
    check("30012-does-not-start-immediately", currentManager.starts.length === 1 && !listening(page), "starts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
    advance(1600);
    await micro();
    check("30012-still-waiting-through-stop-timeout", currentManager.starts.length === 1, "starts=" + currentManager.starts.length + " timers=" + delays().join(","));
    advance(8000);
    await micro();
    const afterConfirm = {
      starts: currentManager.starts.length,
      label: page.data.statusLabel,
      timers: delays()
    };
    page.onStart();
    await micro();
    record("30012-after-confirm", afterConfirm.starts === 2 && afterConfirm.label !== "没有开始听" ? "PASS" : "FAIL", "afterConfirm=" + JSON.stringify(afterConfirm) + " afterExtraTapStarts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    page.onStart();
    await micro();
    page.onPause();
    await micro();
    page.onStart();
    await micro();
    advance(1600);
    await micro();
    advance(8000);
    await micro();
    const mid = { starts: currentManager.starts.length, label: page.data.statusLabel };
    page.onStart();
    await micro();
    record("silent-pause-then-continue", mid.starts === 2 && !listening(page) ? "PASS" : "FAIL", "afterWait=" + JSON.stringify(mid) + " afterExtraTapStarts=" + currentManager.starts.length + " label=" + page.data.statusLabel);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30001);
    await micro();
    advance(5000);
    check("30001-copy-and-no-retry", page.data.statusLabel === "录音出错" && page.data.statusDetail.includes("录音接口出错") && !page.data.statusDetail.startsWith("请打开设置") && currentManager.starts.length === 1 && !listening(page), "label=" + page.data.statusLabel + " detail=" + page.data.statusDetail + " starts=" + currentManager.starts.length + " micDenied=" + page.data.micDenied);
  })();

  await (async () => {
    const page = await boot({ privacyFail: true, record: undefined });
    check("privacy-fail-closed", global.wx.authorizeCalls === 0 && currentManager.starts.length === 0 && page.data.statusLabel === "暂时无法确认", "authorize=" + global.wx.authorizeCalls + " label=" + page.data.statusLabel);
    page.onStart();
    await micro();
    check("privacy-fail-second-tap-still-closed", global.wx.authorizeCalls === 0 && currentManager.starts.length === 0, "authorize=" + global.wx.authorizeCalls + " starts=" + currentManager.starts.length);
    wxState.privacyFail = false;
    wxState.record = true;
    page.onShow();
    await micro();
    page.onStart();
    await micro();
    check("privacy-fail-recovers-on-next-show", currentManager.starts.length === 1 && !listening(page) && page.data.statusLabel === "正在打开麦克风", "starts=" + currentManager.starts.length + " label=" + page.data.statusLabel + " authorize=" + global.wx.authorizeCalls);
  })();

  await (async () => {
    const page = await boot({ save: true });
    await listen(page);
    currentManager.emitStop("只保存文字");
    await micro();
    const ending = page.onStop();
    await micro();
    advance(1600);
    await ending;
    const body = JSON.stringify(global.wx.storage["gne:history"] || null);
    check("save-text-only", body.includes("只保存文字") && !body.includes("wxfile") && !body.includes("tempFile") && !body.includes(".silk"), body);
  })();

  await (async () => {
    const page = await boot();
    await listen(page);
    currentManager.emitError(-30004);
    advance(300);
    await micro();
    currentManager.emitStart();
    currentManager.emitError(-30004);
    await micro();
    const starts = currentManager.starts.length;
    advance(20000);
    check("network-retry-bounded", page.data.statusLabel === "网络异常" && starts === 2 && currentManager.starts.length === 2 && !listening(page), "label=" + page.data.statusLabel + " starts=" + currentManager.starts.length);
  })();

  const counts = cases.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    commit: "75c20192dfde88b444562bafc41391986ac86269",
    adjudication: "32000ms watchdog is accepted. Old >=30000 and exact-30000-stop assertions are not product failures.",
    counts,
    cases
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "behavioral-results.json"), JSON.stringify(summary, null, 2));
  const lines = ["commit 75c20192dfde88b444562bafc41391986ac86269", "counts " + JSON.stringify(counts), ""];
  cases.forEach((item) => lines.push(item.status + "\t" + item.name + "\t" + item.detail));
  fs.writeFileSync(path.join(outDir, "behavioral-results.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (counts.FAIL) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
