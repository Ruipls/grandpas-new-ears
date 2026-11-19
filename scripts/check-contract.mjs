import fs from "fs";
import path from "path";
import { runInThisContext } from "vm";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miniRoot = path.join(root, "miniprogram");
const cjsCache = new Map();
const passedIds = [];
let assertions = 0;

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

function createScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    schedule(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    flush() {
      const fns = Array.from(pending.values());
      pending.clear();
      fns.forEach((fn) => fn());
    },
    get size() {
      return pending.size;
    }
  };
}

// Official onError table from
// https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/extended/translator.html
// 最后一次编辑于 2026-08-24.
// The second column is this test's required handling, not a value exported by the engine.
const OFFICIAL_ERRORS = [
  [-30001, "mic"],
  [-30002, "interrupted"],
  [-30003, "transmission"],
  [-30004, "network"],
  [-30005, "failed"],
  [-30006, "timeout"],
  [-30007, "unavailable"],
  [-30008, "network"],
  [-30009, "unavailable"],
  [-30010, "network"],
  [-30011, "ignore"],
  [-30012, "ignore"],
  [-30013, "failed"],
  [-40001, "limited"]
];

function createContractManager() {
  return {
    starts: [],
    running: false,
    nextResult: "",
    start(options) {
      const keys = Object.keys(options || {}).sort();
      this.starts.push({
        duration: options && options.duration,
        lang: options && options.lang,
        keys: keys,
        audioSource: options && options.audioSource
      });
      if (this.running) {
        if (typeof this.onError === "function") {
          this.onError({ retcode: -30011, msg: "recognizing" });
        }
        return;
      }
      this.running = true;
    },
    stop() {
      if (!this.running) {
        if (typeof this.onError === "function") {
          this.onError({ retcode: -30012, msg: "no task" });
        }
        return;
      }
      this.running = false;
      if (typeof this.onStop === "function") {
        this.onStop({
          tempFilePath: "wxfile://tmp/should-not-be-saved.silk",
          duration: 1000,
          fileSize: 16,
          result: this.nextResult
        });
      }
    },
    emitStart() {
      if (typeof this.onStart === "function") this.onStart({ msg: "Ok" });
    },
    emitRecognize(result) {
      if (typeof this.onRecognize === "function") this.onRecognize({ result: result });
    },
    emitStop(result) {
      this.running = false;
      if (typeof this.onStop === "function") {
        this.onStop({
          tempFilePath: "wxfile://tmp/should-not-be-saved.silk",
          duration: 1000,
          fileSize: 16,
          result: result
        });
      }
    },
    emitError(retcode) {
      this.running = false;
      if (typeof this.onError === "function") {
        this.onError({ retcode: retcode, msg: "contract" });
      }
    }
  };
}

function testOfficialCodes() {
  const { classifyWechatSIError } = loadCjs(path.join(miniRoot, "engines/wechat-si.js"));
  const { commitCaption } = loadCjs(path.join(miniRoot, "utils/format.js"));
  OFFICIAL_ERRORS.forEach((row) => {
    assert(classifyWechatSIError(row[0]) === row[1], "official " + row[0] + " -> " + row[1]);
    passedIds.push("CODE-" + String(row[0]).replace("-", ""));
  });
  assert(classifyWechatSIError(0) === "failed", "undocumented retcode stays failed");
  passedIds.push("CODE-UNKNOWN");
  assert(commitCaption("", "  ") === "", "blank caption is empty");
  assert(commitCaption("你好", "  你好  ") === "", "same caption is not repeated");
  assert(commitCaption("你好", "你好世界") === "你好世界", "a longer final is kept");
  const longText = "字".repeat(500);
  assert(commitCaption("", longText) === longText, "long caption is not truncated");
  passedIds.push("CAP-RULES");
}

async function testEngineContract() {
  const { createWechatSIEngine } = loadCjs(path.join(miniRoot, "engines/wechat-si.js"));
  const scheduler = createScheduler();
  const manager = createContractManager();
  const finals = [];
  const interims = [];
  const errors = [];
  const pending = [];
  let started = 0;
  const engine = createWechatSIEngine({
    loadManager: () => manager,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0,
    startWait: 0
  });
  engine.onFinal((text) => finals.push(text));
  engine.onInterim((text) => interims.push(text));
  engine.onError((error) => errors.push(error.code));
  engine.onStarted(() => {
    started += 1;
  });
  engine.onPending(() => pending.push("retry"));

  await engine.start({ lang: "zh_CN" });
  assert(started === 0, "start() without onStart is not listening");
  assert(manager.starts[0].keys.join(",") === "duration,lang", "start options are only duration and lang");
  assert(manager.starts[0].audioSource === undefined, "audioSource is not sent");
  scheduler.flush();
  assert(errors[0] === "start-timeout", "missing onStart becomes start-timeout");
  assert(started === 0, "watchdog does not pretend recording started");
  passedIds.push("ENG-WATCHDOG");

  const live = createContractManager();
  const liveFinals = [];
  const liveErrors = [];
  const livePending = [];
  let liveStarted = 0;
  const liveEngine = createWechatSIEngine({
    loadManager: () => live,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0,
    startWait: 0
  });
  liveEngine.onFinal((text) => liveFinals.push(text));
  liveEngine.onError((error) => liveErrors.push(error.code));
  liveEngine.onStarted(() => {
    liveStarted += 1;
  });
  liveEngine.onPending(() => livePending.push("retry"));
  liveEngine.onInterim((text) => interims.push(text));

  await liveEngine.start({ lang: "en_US" });
  live.emitStart();
  assert(liveStarted === 1, "onStart is the listening signal");
  // ASSUMPTION: 2026-08-24 method table does not list onRecognize.
  // Older Chinese and English notes used res.result as the in-progress text.
  live.emitRecognize("you ");
  live.emitRecognize("hello");
  assert(interims[interims.length - 1] === "hello", "assumed interim uses result and replaces");
  live.emitStop("hello there");
  assert(liveFinals[0] === "hello there", "onStop.result is the final text");
  assert(!JSON.stringify(liveFinals).includes("wxfile"), "temporary audio path is not a caption");
  scheduler.flush();
  live.emitStart();
  assert(liveStarted === 2, "the continued session reports onStart");
  const startsBefore = live.starts.length;
  live.start({ duration: 1, lang: "zh_CN" });
  assert(liveErrors.length === 0, "-30011 is not shown");
  assert(liveStarted === 2, "-30011 does not cancel the current listen");
  assert(live.starts.length === startsBefore + 1, "duplicate start is rejected by the plugin contract");
  passedIds.push("ENG-FINAL");
  passedIds.push("ENG-30011");

  live.emitError(-30004);
  assert(liveErrors.length === 0, "first official network error retries");
  assert(livePending[0] === "retry", "retry tells the page it is not listening");
  scheduler.flush();
  live.emitStart();
  live.emitError(-30004);
  assert(liveErrors[0] === "network", "second -30004 is network");
  passedIds.push("ENG-NETWORK");

  const timeoutManager = createContractManager();
  const timeoutErrors = [];
  const timeoutEngine = createWechatSIEngine({
    loadManager: () => timeoutManager,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0,
    startWait: 0
  });
  timeoutEngine.onError((error) => timeoutErrors.push(error.code));
  await timeoutEngine.start({ lang: "zh_CN" });
  timeoutManager.emitStart();
  timeoutManager.emitError(-30006);
  scheduler.flush();
  timeoutManager.emitStart();
  timeoutManager.emitError(-30006);
  assert(timeoutErrors[0] === "timeout", "-30006 stays a timeout");
  passedIds.push("ENG-TIMEOUT");

  const dropped = createContractManager();
  const droppedErrors = [];
  const droppedEngine = createWechatSIEngine({
    loadManager: () => dropped,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0,
    startWait: 0
  });
  droppedEngine.onError((error) => droppedErrors.push(error.code));
  await droppedEngine.start({ lang: "zh_CN" });
  dropped.emitStart();
  dropped.emitError(-30003);
  scheduler.flush();
  dropped.emitError(-30003);
  assert(droppedErrors[0] === "transmission", "-30003 is transmission, not network");
  passedIds.push("ENG-TRANSMISSION");

  const idleManager = createContractManager();
  const idleErrors = [];
  const idleEngine = createWechatSIEngine({
    loadManager: () => idleManager,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0,
    startWait: 0
  });
  idleEngine.onError((error) => idleErrors.push(error.code));
  await idleEngine.start({ lang: "zh_CN" });
  idleManager.emitStart();
  idleManager.running = false;
  const stopped = idleEngine.stop();
  scheduler.flush();
  await stopped;
  assert(idleErrors.length === 0, "-30012 does not surface as a caption failure");
  assert(idleManager.starts.length === 1, "stop does not start again");
  passedIds.push("ENG-30012");
}

const openPages = [];
let pluginMode = "ok";
let currentManager = null;
let pageDef = null;

function createWx(state) {
  const storage = {};
  const api = {
    appHides: [],
    modals: [],
    storage: storage,
    authorizeCalls: 0,
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
    },
    setKeepScreenOn(options) {
      if (options && options.fail) {
        // success is optional
      }
    },
    onAppHide(fn) {
      api.appHides.push(fn);
    },
    offAppHide(fn) {
      const index = api.appHides.indexOf(fn);
      if (index >= 0) api.appHides.splice(index, 1);
    },
    getPrivacySetting(options) {
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
    },
    finishAuthorize(ok, error) {
      const pending = api._authorize;
      if (!pending) throw new Error("authorize was not called");
      if (ok) pending.success();
      else pending.fail(error || { errMsg: "authorize:fail" });
    },
    openSetting(options) {
      if (state.settingOpens === false) {
        options.fail({ errMsg: "openSetting:fail" });
        return;
      }
      if (state.settingGrant === true) state.record = true;
      if (state.settingGrant === false) state.record = false;
      options.success({
        authSetting: { "scope.record": state.settingGrant === true }
      });
    },
    openPrivacyContract(options) {
      options.success({});
    },
    showModal(options) {
      api.modals.push(options);
      options.success({ confirm: state.save === true, cancel: state.save !== true });
    },
    navigateTo() {},
    nextTick(fn) {
      fn();
    }
  };
  return api;
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
  openPages.push(page);
  return page;
}

function installPlugin() {
  global.requirePlugin = function () {
    if (pluginMode === "throw") throw new Error("plugin missing");
    if (pluginMode === "bad") return {};
    return {
      getRecordRecognitionManager() {
        return currentManager;
      }
    };
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot(state) {
  currentManager = createContractManager();
  global.wx = createWx(state);
  installPlugin();
  const page = createPage();
  page.onLoad();
  page.onShow();
  await flush();
  return page;
}

function listening(page) {
  return page.data.listening === true && page.data.statusLabel === "正在听";
}

async function closePages() {
  while (openPages.length) {
    const page = openPages.pop();
    try {
      if (!page._unloaded) page.onUnload();
    } catch (error) {
      // The assertion above is the failure that matters.
    }
  }
}

async function flow(id, fn) {
  try {
    await fn();
    passedIds.push(id);
  } finally {
    await closePages();
  }
}

async function testPages() {
  global.Page = function (definition) {
    pageDef = definition;
  };
  loadCjs(path.join(miniRoot, "pages/index/index.js"));
  assert(pageDef && typeof pageDef.onLoad === "function", "page registered");

  await flow("PAGE-01", async () => {
    const page = await boot({ appId: "touristappid", needPrivacy: false, record: true });
    page.onStart();
    await flush();
    assert(currentManager.starts.length === 0, "tourist appid does not start the plugin");
    assert(page.data.statusLabel === "还没有 AppID", "tourist appid copy");
    assert(!listening(page), "tourist appid is not listening");
  });

  await flow("PAGE-02", async () => {
    pluginMode = "throw";
    try {
      const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
      page.onStart();
      await flush();
      assert(page.data.statusLabel === "插件不可用", "missing plugin copy");
      assert(!listening(page), "missing plugin is not listening");
      assert(currentManager.starts.length === 0, "missing plugin does not start");
    } finally {
      pluginMode = "ok";
    }
  });

  await flow("PAGE-03", async () => {
    pluginMode = "bad";
    try {
      const page = await boot({ appId: "wx-test-app", account: "missing", needPrivacy: false, record: true });
      page.onStart();
      assert(page.data.statusLabel === "插件不可用", "unknown account still requires the plugin");
      assert(!listening(page), "bad plugin is not listening");
    } finally {
      pluginMode = "ok";
    }
  });

  await flow("PAGE-04", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: true, record: undefined });
    assert(page.data.privacyNeeded === true, "privacy agreement is required");
    assert(page.data.statusLabel === "请先同意", "privacy prompt");
    const calls = global.wx.authorizeCalls;
    page.onStart();
    await flush();
    assert(global.wx.authorizeCalls === calls, "ordinary start does not skip the agree button");
    assert(currentManager.starts.length === 0, "privacy block does not record");
    assert(!listening(page), "privacy block is not listening");
  });

  await flow("PAGE-05", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: true, record: undefined });
    page.onDeclinePrivacy();
    assert(page.data.statusLabel === "还未同意", "decline copy");
    assert(currentManager.starts.length === 0, "decline does not record");
    assert(!listening(page), "decline is not listening");
  });

  await flow("PAGE-06", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: true, record: undefined });
    page.onAgreePrivacy();
    global.wx.finishAuthorize(false, {
      errno: 112,
      errMsg: "authorize:fail api scope is not declared in the privacy agreement"
    });
    await flush();
    assert(page.data.statusLabel === "指引未生效", "errno 112 copy");
    assert(currentManager.starts.length === 0, "errno 112 does not record");
    assert(!listening(page), "errno 112 is not listening");
  });

  await flow("PAGE-07", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    await flush();
    assert(page.data.statusLabel === "正在打开麦克风", "before onStart");
    assert(page.data.listening !== true, "opening is not listening");
    currentManager.emitStart();
    assert(listening(page), "onStart is listening");
  });

  await flow("PAGE-09", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.emitRecognize("你好");
    await wait(160);
    assert(page.data.partialText === "你好", "interim is shown");
    currentManager.nextResult = "你好世界";
    page.onPause();
    assert(page.data.segments.length === 1, "one final segment");
    assert(page.data.segments[0].text === "你好世界", "final replaces interim");
    assert(page.data.partialText === "", "interim cleared");
    assert(page.data.statusLabel === "已暂停", "pause copy");
    assert(!listening(page), "paused is not listening");
  });

  await flow("PAGE-10", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.nextResult = "   ";
    page.onPause();
    assert(page.data.segments.length === 0, "blank result is not a caption");
    page.onStart();
    currentManager.emitStart();
    currentManager.emitStop("");
    assert(page.data.segments.length === 0, "empty onStop is not a caption");
  });

  await flow("PAGE-11", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.emitStop("同一句");
    await wait(360);
    currentManager.emitStop("同一句");
    assert(page.data.segments.length === 1, "adjacent duplicate final is skipped");
  });

  await flow("PAGE-12", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    const longText = "甲".repeat(480);
    page.onStart();
    currentManager.emitStart();
    currentManager.nextResult = longText;
    page.onPause();
    assert(page.data.segments[0].text === longText, "long caption is kept");
  });

  await flow("PAGE-13", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    const starts = currentManager.starts.length;
    page.onPause();
    currentManager.emitStart();
    assert(!listening(page), "late onStart after pause is ignored");
    assert(page.data.statusLabel === "已暂停", "pause remains");
    assert(currentManager.starts.length === starts, "pause does not start again");
  });

  await flow("PAGE-14", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    const starts = currentManager.starts.length;
    page.onHide();
    assert(!listening(page), "hide stops listening");
    page.onShow();
    await flush();
    assert(!listening(page), "show does not resume");
    assert(currentManager.starts.length === starts, "show does not start the plugin");
  });

  await flow("PAGE-15", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    page.onUnload();
    currentManager.emitStart();
    currentManager.emitRecognize("迟到");
    currentManager.emitStop("迟到");
    await wait(160);
    assert(currentManager.running === false, "unload stops the plugin");
    assert(page.data.segments.length === 0, "late caption after unload is ignored");
    assert(page.data.partialText !== "迟到", "late interim after unload is ignored");
  });

  await flow("PAGE-16", async () => {
    const state = { appId: "wx-test-app", needPrivacy: false, record: false, settingGrant: false };
    const page = await boot(state);
    assert(page.data.statusLabel === "麦克风未授权", "revoked or denied microphone");
    page.onStart();
    assert(currentManager.starts.length === 0, "denied microphone does not record");
    page.onOpenSetting();
    await flush();
    assert(page.data.statusLabel === "麦克风未授权", "settings without grant stays denied");
    assert(!listening(page), "closed settings is not listening");
    state.settingGrant = true;
    page.onOpenSetting();
    await flush();
    assert(page.data.statusLabel === "麦克风已允许", "settings grant copy");
    assert(!listening(page), "settings grant waits for another tap");
    page.onStart();
    currentManager.emitStart();
    assert(listening(page), "a later start can listen after reauthorization");
  });

  await flow("PAGE-17", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    const hides = global.wx.appHides.length;
    page.onLoad();
    assert(global.wx.appHides.length === hides, "second onLoad does not add another hide listener");
    page.onStart();
    currentManager.emitStart();
    currentManager.nextResult = "只记一次";
    page.onPause();
    assert(page.data.segments.length === 1, "one listener records one caption");
  });

  await flow("PAGE-18", async () => {
    const state = { appId: "wx-test-app", needPrivacy: false, record: true, save: false };
    const page = await boot(state);
    page.onStart();
    currentManager.emitStart();
    currentManager.nextResult = "不保存这句";
    page.onPause();
    await page.onStop();
    assert(global.wx.modals.length === 1, "stop asks before saving");
    assert(global.wx.storage["gne:history"] == null, "cancel does not save captions");
    state.save = true;
    page.onStart();
    currentManager.emitStart();
    currentManager.nextResult = "只保存文字";
    page.onPause();
    await page.onStop();
    const saved = JSON.stringify(global.wx.storage["gne:history"]);
    assert(saved.includes("只保存文字"), "confirm saves the caption text");
    assert(!saved.includes("wxfile"), "saved history has no temporary audio");
  });

  await flow("PAGE-19", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.start({ duration: 1, lang: "zh_CN" });
    assert(listening(page), "-30011 leaves the current listen in place");
  });

  await flow("PAGE-20", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.emitError(-30004);
    assert(page.data.statusLabel === "正在重新连接", "network retry is not 正在听");
    assert(!listening(page), "retry gap is not listening");
    await wait(360);
    currentManager.emitStart();
    assert(listening(page), "recovered recording can listen again");
  });

  await flow("PAGE-21", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.emitError(-30004);
    await wait(360);
    currentManager.emitError(-30004);
    await flush();
    assert(page.data.statusLabel === "网络异常", "second network failure is shown");
    assert(!listening(page), "failed network is not listening");
  });

  await flow("PAGE-22", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.emitError(-30001);
    assert(page.data.statusLabel === "麦克风未授权", "recording error copy");
    assert(!listening(page), "recording error is not listening");
  });

  await flow("PAGE-23", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.nextResult = "第一句";
    page.onPause();
    await flush();
    page.onStart();
    await flush();
    currentManager.emitStart();
    const starts = currentManager.starts.length;
    page.onStart();
    assert(currentManager.starts.length === starts, "start while listening does not start again");
    currentManager.nextResult = "第二句";
    page.onPause();
    const got = page.data.segments.map((item) => item.text).join("|");
    assert(got === "第一句|第二句", "two cycles keep both lines, got [" + got + "] status " + page.data.statusLabel);
    currentManager.nextResult = "";
    page.onStart();
    page.onPause();
    page.onStart();
    page.onPause();
    assert(page.data.segments.length === 2, "empty extra cycles do not invent captions");
  });

  await flow("PAGE-24", async () => {
    const state = { appId: "wx-test-app", needPrivacy: false, record: true };
    const page = await boot(state);
    page.onStart();
    currentManager.emitStart();
    page.onPause();
    const starts = currentManager.starts.length;
    state.needPrivacy = true;
    page.onShow();
    await flush();
    page.onStart();
    await flush();
    assert(page.data.privacyNeeded === true, "privacy is required again");
    assert(currentManager.starts.length === starts, "revoked privacy does not record");
    assert(!listening(page), "revoked privacy is not listening");
  });

  await flow("PAGE-25", async () => {
    const page = await boot({ appId: "wx-test-app", needPrivacy: false, record: true });
    page.onStart();
    currentManager.emitStart();
    currentManager.emitError(-30006);
    await wait(360);
    currentManager.emitError(-30006);
    await flush();
    assert(page.data.statusLabel === "识别超时", "timeout copy");
    assert(!listening(page), "timeout is not listening");
  });
}

function testStaticUi() {
  const caption = fs.readFileSync(path.join(miniRoot, "pages/index/index.wxss"), "utf8");
  const history = fs.readFileSync(path.join(miniRoot, "pages/history/history.wxss"), "utf8");
  const engine = fs.readFileSync(path.join(miniRoot, "engines/wechat-si.js"), "utf8");
  const page = fs.readFileSync(path.join(miniRoot, "pages/index/index.js"), "utf8");
  assert(caption.includes("min-height: 112rpx"), "main controls declare a large tap height");
  assert(caption.includes("overflow-wrap: anywhere"), "long captions can wrap");
  assert(history.includes("min-height: 96rpx"), "history buttons declare a large tap height");
  assert(!engine.includes("uploadFile"), "engine does not upload audio");
  assert(!engine.includes("getFileSystemManager"), "engine does not store the recording file");
  assert(!page.includes("uploadFile"), "page does not upload audio");
  passedIds.push("UI-01");
  passedIds.push("UI-02");
  passedIds.push("UI-03");
}

testOfficialCodes();
await testEngineContract();
await testPages();
testStaticUi();
console.log("contract check ok");
console.log("contract assertions passed: " + assertions);
console.log("contract flows passed: " + passedIds.length);
console.log("contract flow ids: " + passedIds.join(" "));
console.log("contract check is a Node simulation, not WeChat DevTools or a phone");
