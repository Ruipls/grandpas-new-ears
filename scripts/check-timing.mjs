/**
 * Segment-duration watchdog checks.
 *
 * The plugin document says a valid start duration stops recording automatically
 * and onStop carries the final text. It does not say onStop arrives in the same
 * millisecond. These tests use a passive manager: stop() only counts, and
 * callbacks run only when the test emits them.
 *
 * This file does not change scripts/independent-harness.mjs. That probe still
 * fails onStart-then-listening when a timer of 30000ms or more is pending, and
 * fails no-client-stop-at-30s if the client has not called stop at exactly
 * 30000ms. Those two checks reject the grace used here. They are reported
 * separately and are not edited to pass.
 */
import fs from "fs";
import path from "path";
import { runInThisContext } from "vm";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miniRoot = path.join(root, "miniprogram");
const cjsCache = new Map();
let assertions = 0;
const ids = [];

function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

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

async function micro() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function createManager() {
  return {
    starts: [],
    stops: 0,
    start(options) {
      this.starts.push({
        duration: options && options.duration,
        lang: options && options.lang,
        keys: Object.keys(options || {}).sort()
      });
    },
    stop() {
      this.stops += 1;
    },
    emitStart() {
      if (typeof this.onStart === "function") this.onStart({ msg: "Ok" });
    },
    emitStop(result) {
      if (typeof this.onStop === "function") {
        this.onStop({
          result: result == null ? "" : result,
          tempFilePath: "wxfile://tmp/timing.silk",
          duration: 1000,
          fileSize: 8
        });
      }
    }
  };
}

let manager = null;
let pageDef = null;

function createWx() {
  const storage = {};
  return {
    appHides: [],
    storage,
    getAccountInfoSync() {
      return { miniProgram: { appId: "wx-timing-test" } };
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
      options.success({ needAuthorization: false, privacyContractName: "《测试》" });
    },
    getSetting(options) {
      options.success({ authSetting: { "scope.record": true } });
    },
    authorize(options) {
      options.success();
    },
    openSetting(options) {
      options.success({ authSetting: { "scope.record": true } });
    },
    openPrivacyContract(options) {
      options.success({});
    },
    showModal(options) {
      options.success({ confirm: false, cancel: true });
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

async function boot() {
  timers.clear();
  now = 0;
  manager = createManager();
  global.wx = createWx();
  global.requirePlugin = function () {
    return {
      getRecordRecognitionManager() {
        return manager;
      }
    };
  };
  const page = createPage();
  page.onLoad();
  page.onShow();
  await micro();
  return page;
}

function listening(page) {
  return page.data.listening === true && page.data.statusLabel === "正在听";
}

function texts(page) {
  return page.data.segments.map((segment) => segment.text);
}

installClock();
global.Page = (definition) => {
  pageDef = definition;
};
loadCjs(path.join(miniRoot, "pages/index/index.js"));
const engineExports = loadCjs(path.join(miniRoot, "engines/wechat-si.js"));

const DURATION = engineExports.DEFAULT_DURATION_MS;
const GRACE = engineExports.DEFAULT_SEGMENT_GRACE_MS;
const CONFIRM = engineExports.DEFAULT_STOP_CONFIRM_MS;

assert(DURATION === 30000, "plugin duration stays 30000");
assert(GRACE > 0, "fallback waits past the plugin duration");
assert(DURATION + GRACE > 30000, "fallback is not scheduled by subtracting from 30000");
ids.push("TIME-CONST");

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  assert(listening(page), "onStart is listening during the segment");
  assert(manager.starts[0].duration === 30000, "start duration is 30000, not 29999");
  advance(DURATION);
  await micro();
  assert(manager.stops === 0, "no client stop during the plugin duration");
  assert(listening(page), "still the same segment at exactly 30000ms");
  assert(manager.starts.length === 1, "no extra start at exactly 30000ms");
  ids.push("TIME-WITHIN-DURATION");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  advance(DURATION + GRACE);
  await micro();
  assert(manager.stops === 1, "one fallback stop after duration plus grace");
  assert(!listening(page), "fallback stop is not shown as 正在听");
  const stops = manager.stops;
  const starts = manager.starts.length;
  advance(1000);
  await micro();
  assert(manager.stops === stops, "fallback stop is not repeated");
  assert(manager.starts.length === starts, "no new start while waiting for onStop");
  ids.push("TIME-ONE-STOP");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  advance(DURATION + GRACE + CONFIRM);
  await micro();
  assert(manager.stops === 1, "missing onStop still stops only once");
  assert(manager.starts.length === 1, "missing onStop does not start again");
  assert(!listening(page), "missing onStop is not listening");
  assert(page.data.statusLabel === "没有收到结果", "missing onStop says the result did not arrive");
  const starts = manager.starts.length;
  advance(CONFIRM);
  await micro();
  assert(manager.starts.length === starts, "the ended session stays ended");
  ids.push("TIME-NO-ONSTOP");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  advance(DURATION + GRACE + CONFIRM);
  await micro();
  manager.emitStop("迟到的正式结果");
  await micro();
  assert(texts(page).join("|") === "迟到的正式结果", "a late onStop is kept");
  assert(manager.starts.length === 1, "a late onStop does not start a new segment");
  assert(!listening(page), "a late onStop does not show 正在听");
  ids.push("TIME-LATE-ONSTOP");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  advance(10000);
  page.onPause();
  await micro();
  assert(manager.stops === 1, "pause stops once");
  advance(DURATION + GRACE + CONFIRM);
  await micro();
  assert(manager.stops === 1, "pause cancels the duration fallback");
  assert(manager.starts.length === 1, "pause does not start again");
  assert(page.data.statusLabel === "已暂停", "pause stays paused");
  ids.push("TIME-PAUSE-CANCELS");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  page.onHide();
  await micro();
  const stops = manager.stops;
  advance(DURATION + GRACE + CONFIRM);
  await micro();
  assert(manager.stops === stops, "hide cancels the duration fallback");
  assert(!listening(page), "hide does not resume");
  assert(manager.starts.length === 1, "hide does not start again");
  ids.push("TIME-HIDE-CANCELS");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  page.onUnload();
  await micro();
  advance(DURATION + GRACE + CONFIRM);
  manager.emitStop("卸载后不该出现");
  await micro();
  assert(texts(page).length === 0, "unload drops a late onStop");
  assert(manager.starts.length === 1, "unload does not start again");
  ids.push("TIME-UNLOAD-CANCELS");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  manager.emitStart();
  await micro();
  manager.emitStop("第一小段");
  await micro();
  assert(texts(page).join("|") === "第一小段", "onStop keeps the final");
  assert(!listening(page), "after onStop the next segment is not listening yet");
  advance(300);
  await micro();
  assert(manager.starts.length === 2, "the next start waits for the restart delay");
  assert(!listening(page), "the next start is not listening before onStart");
  manager.emitStart();
  await micro();
  assert(listening(page), "the next onStart is listening");
  ids.push("TIME-SEAM");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  page.onPause();
  await micro();
  page.onStart();
  await micro();
  assert(manager.starts.length === 1, "continue does not start before the previous stop settles");
  advance(1600 + CONFIRM);
  await micro();
  assert(manager.starts.length === 2, "the queued continue starts after the old stop settles");
  assert(page.data.statusLabel !== "没有开始听", "the old stop does not cancel the new start");
  assert(!listening(page), "the new start is not listening before onStart");
  const starts = manager.starts.length;
  advance(CONFIRM);
  await micro();
  assert(manager.starts.length === starts, "no callback does not start an unbounded extra segment");
  ids.push("TIME-CONTINUE-AFTER-SILENT-PAUSE");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  const original = manager.stop.bind(manager);
  manager.stop = function stopWith30012() {
    original();
    if (typeof this.onError === "function") this.onError({ retcode: -30012, msg: "no task" });
  };
  page.onPause();
  await micro();
  page.onStart();
  await micro();
  assert(manager.starts.length === 1, "-30012 does not open the next recorder immediately");
  advance(1600);
  await micro();
  assert(manager.starts.length === 1, "-30012 still waits through the stop timeout");
  advance(CONFIRM);
  await micro();
  assert(manager.starts.length === 2, "-30012 confirm releases the queued continue");
  assert(page.data.statusLabel !== "没有开始听", "-30012 confirm does not report that listening never started");
  ids.push("TIME-30012-CONTINUE");
})();

await (async () => {
  const page = await boot();
  page.onStart();
  await micro();
  page.onPause();
  await micro();
  page.onStart();
  page.onStart();
  page.onStart();
  await micro();
  advance(1600 + CONFIRM);
  await micro();
  assert(manager.starts.length === 2, "repeated continue taps open one recorder, not many");
  page.onHide();
  await micro();
  const starts = manager.starts.length;
  advance(DURATION + GRACE + CONFIRM);
  await micro();
  assert(manager.starts.length === starts, "hide after continue does not keep starting");
  ids.push("TIME-RAPID-AND-HIDE");
})();

console.log("timing check ok");
console.log("timing assertions passed: " + assertions);
console.log("timing flows passed: " + ids.length);
console.log("timing flow ids: " + ids.join(" "));
console.log("timing check is a Node simulation, not WeChat DevTools or a phone");
