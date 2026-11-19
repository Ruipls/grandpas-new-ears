import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { runInThisContext } from "vm";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miniRoot = path.join(root, "miniprogram");
const cjsCache = new Map();

function loadCjs(file) {
  const resolved = path.resolve(file);
  if (cjsCache.has(resolved)) return cjsCache.get(resolved).exports;
  const module = { exports: {} };
  cjsCache.set(resolved, module);
  const code = fs.readFileSync(resolved, "utf8");
  const dirname = path.dirname(resolved);
  function cjsRequire(request) {
    if (!request.startsWith(".")) {
      throw new Error("unexpected import in mini program code: " + request);
    }
    const target = path.resolve(dirname, request);
    return loadCjs(target.endsWith(".js") ? target : target + ".js");
  }
  const wrapper = "(function (exports, require, module, __filename, __dirname) {\n" + code + "\n})";
  runInThisContext(wrapper, { filename: resolved })(module.exports, cjsRequire, module, resolved, dirname);
  return module.exports;
}

let assertions = 0;

function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readJson(rel) {
  try {
    return JSON.parse(read(rel));
  } catch (error) {
    throw new Error(rel + " is not valid JSON: " + error.message);
  }
}

function walk(dir, files) {
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  });
  return files;
}

function checkBraces(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let count = 0;
  for (const ch of text) {
    if (ch === "{") count += 1;
    if (ch === "}") count -= 1;
    if (count < 0) throw new Error(file + " has an extra }");
  }
  if (count !== 0) throw new Error(file + " has an unclosed {");
}

function checkWxml(file) {
  const text = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const tokens = text.match(/<\/?[A-Za-z][\w-]*/g) || [];
  const stack = [];
  tokens.forEach((token) => {
    const name = token.replace(/^<\/?/, "");
    if (token.startsWith("</")) {
      const top = stack.pop();
      if (top !== name) {
        throw new Error(file + " expected </" + top + "> but found </" + name + ">");
      }
      return;
    }
    stack.push(name);
  });
  if (stack.length) throw new Error(file + " has unclosed tags: " + stack.join(", "));
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

function checkProjectShape() {
  const app = readJson("miniprogram/app.json");
  assert(app.pages[0] === "pages/index/index", "caption page must be first");
  assert(app.pages.includes("pages/history/history"), "history page is missing");
  app.pages.forEach((page) => {
    ["js", "json", "wxml", "wxss"].forEach((ext) => {
      const rel = path.join("miniprogram", page + "." + ext);
      assert(fs.existsSync(path.join(root, rel)), "missing " + rel);
    });
  });
  assert(app.__usePrivacyCheck__ === true, "privacy check should be enabled");
  assert(app.plugins.WechatSI.provider === "wx069ba97219f66d99", "WechatSI provider mismatch");
  assert(/^\d+\.\d+\.\d+$/.test(app.plugins.WechatSI.version), "plugin version must be explicit");

  ["project.config.json", "miniprogram/project.config.json"].forEach((rel) => {
    const config = readJson(rel);
    assert(config.appid === "touristappid", rel + " appid must stay touristappid until Rui fills it");
    assert(config.compileType === "miniprogram", rel + " compileType");
    assert(String(config.description || "").includes("AppID"), rel + " needs an AppID note");
  });
  const rootConfig = readJson("project.config.json");
  const innerConfig = readJson("miniprogram/project.config.json");
  assert(rootConfig.miniprogramRoot === "miniprogram/", "root project must point at miniprogram/");
  assert(!innerConfig.miniprogramRoot, "inner project must not nest miniprogramRoot");

  const sitemap = readJson("miniprogram/sitemap.json");
  assert(sitemap.rules.some((rule) => rule.action === "disallow"), "sitemap should disallow indexing");

  const page = read("miniprogram/pages/index/index.js");
  const markup = read("miniprogram/pages/index/index.wxml");
  const permission = read("miniprogram/utils/permission.js");
  const access = read("miniprogram/utils/access-flow.js");
  assert(page.includes("createSpeechEngine"), "caption screen must use the engine interface");
  assert(page.includes("createAccessGate"), "caption screen must use the access gate");
  assert(!page.includes("requirePlugin"), "caption screen must not load the plugin directly");
  assert(!page.includes("wechat-si"), "caption screen must not name the provider");
  assert(!page.includes("getRecorderManager"), "caption screen must not own the recorder");
  assert(!page.includes("requirePrivacyAuthorize"), "caption screen must not simulate privacy authorize");
  assert(!permission.includes("requirePrivacyAuthorize"), "permission helper must not simulate privacy authorize");
  ["setKeepScreenOn", "正在听", "已暂停", "网络异常", "麦克风未授权", "requestRecordAuthorize", "正在重新连接", "assessRuntime", "onPending"].forEach((needle) => {
    assert(page.includes(needle), "caption screen missing " + needle);
  });
  assert(read("miniprogram/utils/readiness.js").includes("还没有 AppID"), "missing AppID copy");
  assert(read("miniprogram/utils/readiness.js").includes("插件不可用"), "missing plugin copy");
  const requestFn = page.slice(page.indexOf("requestAuthorize()"), page.indexOf("onStart()"));
  assert(requestFn.includes("requestRecordAuthorize(wx"), "tap must call authorize directly");
  assert(!requestFn.includes("await"), "authorize request must stay on the tap stack");
  assert(permission.includes('scope: "scope.record"'), "record scope");
  ["指引未生效", "请先同意", "麦克风已允许", "正在打开麦克风", "还未同意", "暂不能听"].forEach((needle) => {
    assert(access.includes(needle), "access flow missing " + needle);
  });
  const labels = read("miniprogram/utils/format.js");
  ["普通话", "English", "粤语", "超大", "巨大"].forEach((needle) => {
    assert(labels.includes(needle), "format.js missing " + needle);
  });
  ["讲话语言", "字号", "高对比", "去打开设置", "正在说", "同意并开始", "agreePrivacyAuthorization", "agree-privacy-btn", "查看隐私保护指引", "暂不同意"].forEach((needle) => {
    assert(markup.includes(needle), "caption markup missing " + needle);
  });
  assert(read("miniprogram/pages/history/history.js").includes("清空"), "history needs clear-all");

  const doc = read("docs/MINIPROGRAM.md");
  ["touristappid", "同声传译", "wx069ba97219f66d99", "隐私", "备案", "待核实", "npm run check", "同意并开始", "112", "模拟"].forEach((needle) => {
    assert(doc.includes(needle), "MINIPROGRAM.md missing " + needle);
  });
}

function checkEngine() {
  const { createWechatSIEngine, classifyWechatSIError, DEFAULT_DURATION_MS } = loadCjs(path.join(miniRoot, "engines/wechat-si.js"));
  const { createSpeechEngine } = loadCjs(path.join(miniRoot, "engines/index.js"));
  const { normalizeCaption } = loadCjs(path.join(miniRoot, "utils/format.js"));

  assert(normalizeCaption("  你好   世界 ") === "你好 世界", "caption whitespace");
  assert(classifyWechatSIError(-30011) === "ignore", "-30011");
  assert(classifyWechatSIError(-30004) === "network", "-30004");
  assert(classifyWechatSIError(-30001) === "mic", "-30001");
  assert(classifyWechatSIError(-30002) === "interrupted", "-30002");
  assert(classifyWechatSIError(-40001) === "limited", "-40001");
  assert(DEFAULT_DURATION_MS === 30000, "duration");

  const facade = createSpeechEngine();
  assert(typeof facade.start === "function", "start");
  assert(typeof facade.stop === "function", "stop");
  assert(typeof facade.onInterim === "function", "onInterim");
  assert(typeof facade.onFinal === "function", "onFinal");
  assert(typeof facade.onError === "function", "onError");
  assert(typeof facade.onStarted === "function", "onStarted");
  assert(typeof facade.onPending === "function", "onPending");

  return createWechatSIEngine;
}

async function testRecognition(createWechatSIEngine) {
  const scheduler = createScheduler();
  const fake = {
    starts: [],
    nextResult: "",
    start(options) {
      this.starts.push(options);
      if (this.onStart) this.onStart({});
    },
    stop() {
      if (this.onStop) this.onStop({ result: this.nextResult });
    }
  };
  const finals = [];
  const interims = [];
  const errors = [];
  let startedCount = 0;
  const engine = createWechatSIEngine({
    loadManager: () => fake,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0
  });
  engine.onFinal((text) => finals.push(text));
  engine.onInterim((text) => interims.push(text));
  engine.onError((error) => errors.push(error.code));
  engine.onStarted(() => {
    startedCount += 1;
  });

  await engine.start({ lang: "en_US" });
  assert(startedCount === 1, "recording start is reported once");
  assert(fake.starts[0].lang === "en_US", "english lang");
  assert(fake.starts[0].duration === 30000, "start duration");
  assert(fake.starts[0].audioSource === undefined, "plugin start must not set audioSource");
  fake.onRecognize({ result: "you " });
  fake.onRecognize({ result: "hello" });
  assert(interims.join("|") === "you|hello", "interim replaces, not appends inside one event");

  fake.onError({ retcode: -30011, msg: "busy" });
  assert(errors.length === 0, "-30011 must not surface");
  fake.onStop({ result: "hello" });
  assert(finals[0] === "hello", "duration end emits final");
  assert(scheduler.size === 1, "duration end queues a restart");
  scheduler.flush();
  assert(fake.starts.length === 2, "restart while still listening");
  assert(startedCount === 2, "automatic restart reports recording start again");

  fake.nextResult = "tail";
  const stopped = engine.stop();
  scheduler.flush();
  await stopped;
  assert(finals[finals.length - 1] === "tail", "user stop keeps the last result");
  assert(fake.starts.length === 2, "user stop does not restart");
  assert(startedCount === 2, "user stop does not report another recording start");
  assert(scheduler.size === 0, "no pending restart after stop");

  await engine.start({ lang: "ja-JP" });
  assert(fake.starts[fake.starts.length - 1].lang === "zh_CN", "unsupported lang falls back to 普通话");
  fake.onError({ retcode: -30002, msg: "paused" });
  assert(errors[errors.length - 1] === "interrupted", "interrupt");
  const startsBeforeInterruptFlush = fake.starts.length;
  scheduler.flush();
  assert(fake.starts.length === startsBeforeInterruptFlush, "interrupt does not restart");

  const networkScheduler = createScheduler();
  let networkStarts = 0;
  const networkErrors = [];
  const networkFake = {
    start() {
      networkStarts += 1;
      if (this.onStart) this.onStart({});
      if (networkStarts >= 2 && this.onError) this.onError({ retcode: -30004, msg: "net" });
    },
    stop() {}
  };
  const networkEngine = createWechatSIEngine({
    loadManager: () => networkFake,
    schedule: networkScheduler.schedule,
    cancel: networkScheduler.cancel,
    restartDelay: 0
  });
  networkEngine.onError((error) => networkErrors.push(error.code));
  await networkEngine.start({ lang: "zh_CN" });
  networkFake.onError({ retcode: -30004, msg: "net" });
  assert(networkErrors.length === 0, "first network error retries quietly");
  networkScheduler.flush();
  assert(networkStarts === 2, "one network retry");
  assert(networkErrors[0] === "network", "second network error is shown");
  assert(networkScheduler.size === 0, "network retry stops after one failure");

  const timeoutScheduler = createScheduler();
  let timeoutStarts = 0;
  const timeoutFinals = [];
  const timeoutFake = {
    start() {
      timeoutStarts += 1;
      if (this.onStart) this.onStart({});
    },
    stop() {}
  };
  const timeoutEngine = createWechatSIEngine({
    loadManager: () => timeoutFake,
    schedule: timeoutScheduler.schedule,
    cancel: timeoutScheduler.cancel,
    restartDelay: 0,
    stopTimeout: 0
  });
  timeoutEngine.onFinal((text) => timeoutFinals.push(text));
  await timeoutEngine.start({ lang: "zh_CN" });
  timeoutFake.onRecognize({ result: "半句" });
  const timeoutDone = timeoutEngine.stop();
  timeoutScheduler.flush();
  await timeoutDone;
  assert(timeoutFinals[0] === "半句", "stop timeout keeps the interim line");
  const restarted = timeoutEngine.start({ lang: "zh_CN" });
  assert(timeoutStarts === 1, "do not start again before the stale stop arrives");
  timeoutFake.onStop({ result: "迟到" });
  timeoutScheduler.flush();
  await restarted;
  assert(timeoutFinals.length === 1, "stale onStop is ignored");
  assert(timeoutStarts === 2, "listening can start after the stale stop");

  const missing = createWechatSIEngine({
    loadManager() {
      throw new Error("plugin missing");
    }
  });
  const missingErrors = [];
  missing.onError((error) => missingErrors.push(error.code));
  await missing.start({ lang: "zh_CN" }).then(() => {
    throw new Error("missing plugin should reject start");
  }, (error) => {
    assert(error.code === "unavailable", "missing plugin code");
  });
  assert(missingErrors.length === 0, "start() rejection is enough for the first failure");

  const lateScheduler = createScheduler();
  let lateStarted = 0;
  const lateFake = {
    start() {},
    stop() {}
  };
  const lateEngine = createWechatSIEngine({
    loadManager: () => lateFake,
    schedule: lateScheduler.schedule,
    cancel: lateScheduler.cancel,
    stopTimeout: 0
  });
  lateEngine.onStarted(() => {
    lateStarted += 1;
  });
  await lateEngine.start({ lang: "zh_CN" });
  const lateStopped = lateEngine.stop();
  lateScheduler.flush();
  await lateStopped;
  lateFake.onStart({});
  assert(lateStarted === 0, "a start callback after stop is not treated as listening");
}

function lastStatus(statuses) {
  assert(statuses.length > 0, "expected a status");
  return statuses[statuses.length - 1];
}

function createDeferredWx() {
  const state = {
    authorizeCalls: 0,
    pending: null,
    record: undefined,
    needPrivacy: false,
    privacyFail: false
  };
  const wxApi = {
    authorize(options) {
      state.authorizeCalls += 1;
      state.pending = options;
    },
    getSetting(options) {
      const auth = {};
      if (state.record === true) auth["scope.record"] = true;
      if (state.record === false) auth["scope.record"] = false;
      options.success({ authSetting: auth });
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
    openSetting(options) {
      options.success({
        authSetting: { "scope.record": state.record === true }
      });
    },
    openPrivacyContract(options) {
      options.fail({ errMsg: "openPrivacyContract:fail" });
    }
  };
  return { state, wxApi };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

let createAccessGate;
let queryRecord;
let requestRecordAuthorize;

function wireGate(wxApi) {
  const starts = [];
  const stops = [];
  const statuses = [];
  const views = [];
  const gate = createAccessGate({
    onStatus(copy) {
      statuses.push(copy);
    },
    onView(patch) {
      views.push(patch);
    },
    onRequestAuthorize() {
      requestRecordAuthorize(wxApi, {
        success() {
          gate.authorizeFinished(null, true);
        },
        fail(error) {
          queryRecord(wxApi).then((record) => {
            gate.authorizeFinished(error, record.recordGranted);
          });
        }
      });
    },
    onStartEngine() {
      starts.push(gate.getPhase());
    },
    onStopEngine() {
      stops.push(gate.getPhase());
    }
  });
  return { gate, starts, stops, statuses, views };
}

async function testAccessGate() {
  const flow = loadCjs(path.join(miniRoot, "utils/access-flow.js"));
  const permissionApi = loadCjs(path.join(miniRoot, "utils/permission.js"));
  createAccessGate = flow.createAccessGate;
  queryRecord = permissionApi.queryRecord;
  requestRecordAuthorize = permissionApi.requestRecordAuthorize;
  const classifyAuthorizeError = flow.classifyAuthorizeError;
  const queryPrivacy = permissionApi.queryPrivacy;
  const openRecordSettings = permissionApi.openRecordSettings;

  assert(classifyAuthorizeError({
    errno: 112,
    errMsg: "authorize:fail api scope is not declared in the privacy agreement"
  }) === "undeclared", "errno 112");
  assert(classifyAuthorizeError({ errno: "112", errMsg: "authorize:fail" }) === "undeclared", "string errno 112");
  assert(classifyAuthorizeError({ errMsg: "authorize:fail appid privacy api banned" }) === "banned", "banned");
  assert(classifyAuthorizeError({ errno: 104, errMsg: "authorize:fail privacy permission is not authorized" }) === "privacy-refused", "errno 104");
  assert(classifyAuthorizeError({ errno: 103, errMsg: "authorize:fail auth deny" }) === "privacy-refused", "errno 103 stays privacy, not a settings-only denial");
  assert(classifyAuthorizeError({ errMsg: "authorize:fail auth deny" }) === "auth-deny", "scope denial");
  assert(classifyAuthorizeError({ errMsg: "authorize:fail unknown" }) === "unknown", "unknown authorize failure");

  const missingPrivacy = await queryPrivacy({});
  assert(missingPrivacy.privacySupported === false, "old base library has no privacy query");
  assert(missingPrivacy.privacyKnown === false, "missing privacy query is not a grant");
  const failedPrivacy = await queryPrivacy({
    getPrivacySetting(options) {
      options.fail({ errMsg: "getPrivacySetting:fail" });
    }
  });
  assert(failedPrivacy.failed === true && failedPrivacy.privacyKnown === false, "failed privacy query is not treated as agreed");
  const unknownRecord = await queryRecord({
    getSetting(options) {
      options.success({ authSetting: {} });
    }
  });
  assert(unknownRecord.recordKnown === true && unknownRecord.recordGranted === undefined, "absent scope is not a denial");

  let seenScope = "";
  let seenError = null;
  requestRecordAuthorize({
    authorize(options) {
      seenScope = options.scope;
      options.fail({ errno: 112, errMsg: "authorize:fail api scope is not declared in the privacy agreement" });
    }
  }, {
    fail(error) {
      seenError = error;
    }
  });
  assert(seenScope === "scope.record", "authorize asks for the microphone scope immediately");
  assert(classifyAuthorizeError(seenError) === "undeclared", "sync authorize failure is classified");

  const deferred = createDeferredWx();
  const first = wireGate(deferred.wxApi);
  first.gate.noteQuery({
    privacyKnown: true,
    needPrivacy: false,
    recordKnown: true,
    recordGranted: undefined,
    canAuthorize: true
  });
  first.gate.userStart();
  assert(deferred.state.authorizeCalls === 1, "start asks for microphone authorization");
  assert(first.starts.length === 0, "authorization failure path has not started yet");
  deferred.state.pending.fail({
    errno: 112,
    errMsg: "authorize:fail api scope is not declared in the privacy agreement"
  });
  await settle();
  assert(first.starts.length === 0, "undeclared privacy does not start listening");
  assert(lastStatus(first.statuses).label === "指引未生效", "undeclared privacy copy");
  assert(first.views.some((view) => view.micDenied === false && view.privacyBlocked === true), "undeclared privacy is not a microphone denial");
  first.gate.userStart();
  deferred.state.pending.fail({
    errno: 112,
    errMsg: "authorize:fail api scope is not declared in the privacy agreement"
  });
  await settle();
  assert(first.starts.length === 0, "retry after errno 112 still does not start");
  assert(first.gate.pause("user") === false, "pause while idle does not restart");
  assert(first.stops.length === 0, "idle pause does not stop a session that never started");

  const bannedWx = createDeferredWx();
  const bannedGate = wireGate(bannedWx.wxApi);
  bannedGate.gate.userStart();
  bannedWx.state.pending.fail({ errMsg: "authorize:fail appid privacy api banned" });
  await settle();
  assert(bannedGate.starts.length === 0, "banned privacy api does not start");
  assert(lastStatus(bannedGate.statuses).label === "暂不能听", "banned copy");

  const refusedWx = createDeferredWx();
  const refused = wireGate(refusedWx.wxApi);
  refused.gate.userStart();
  refusedWx.state.pending.fail({
    errno: 104,
    errMsg: "authorize:fail privacy permission is not authorized"
  });
  await settle();
  assert(refused.starts.length === 0, "privacy refusal does not start");
  assert(lastStatus(refused.statuses).label === "还未同意", "privacy refusal copy");
  assert(refused.views.some((view) => view.privacyNeeded === true && view.micDenied === false), "privacy refusal keeps an agree entry");
  refused.gate.declinePrivacy();
  assert(refused.starts.length === 0, "decline does not start");
  assert(refusedWx.state.authorizeCalls === 1, "decline does not ask for the microphone again");

  const needed = wireGate(createDeferredWx().wxApi);
  needed.gate.noteQuery({
    privacyKnown: true,
    needPrivacy: true,
    recordKnown: true,
    recordGranted: undefined,
    canAuthorize: true
  });
  assert(lastStatus(needed.statuses).label === "请先同意", "known privacy requirement is visible before listening");
  const callsBefore = needed.starts.length;
  needed.gate.userStart();
  assert(needed.starts.length === callsBefore, "ordinary start does not skip the agree button");
  needed.gate.agree();
  assert(needed.starts.length === 0, "agree alone is not recording");

  const grantedWx = createDeferredWx();
  const granted = wireGate(grantedWx.wxApi);
  granted.gate.noteQuery({
    privacyKnown: true,
    needPrivacy: true,
    recordKnown: true,
    recordGranted: undefined,
    canAuthorize: true
  });
  granted.gate.agree();
  assert(grantedWx.state.authorizeCalls === 1, "agree then requests the microphone");
  assert(granted.gate.getPhase() === "idle", "agree does not mark listening before authorization");
  grantedWx.state.pending.success();
  assert(granted.starts.length === 1, "authorization success may ask the engine to start");
  assert(granted.starts[0] === "opening", "engine start is still only opening");
  assert(granted.gate.getPhase() === "opening", "phase stays opening until the recorder callback");
  assert(lastStatus(granted.statuses).label === "正在打开麦克风", "opening copy is not 正在听");
  assert(granted.statuses.every((item) => item.label !== "麦克风已允许"), "a start in progress is not described as already allowed");
  assert(granted.gate.recordingStarted() === true, "recorder callback accepts this open");
  assert(granted.gate.getPhase() === "listening", "listening begins at the recorder callback");
  assert(granted.gate.recordingStarted() === true, "a later recorder callback keeps the same listening session");
  granted.gate.userStart();
  assert(granted.starts.length === 1, "tapping start while listening does not start again");

  const hiddenWx = createDeferredWx();
  const hidden = wireGate(hiddenWx.wxApi);
  hidden.gate.userStart();
  hidden.gate.setVisible(false);
  hiddenWx.state.pending.success();
  assert(hidden.starts.length === 0, "authorization finishing while hidden does not start");
  assert(lastStatus(hidden.statuses).label === "麦克风已允许", "hidden success tells the person to tap again");
  hidden.gate.setVisible(true);
  assert(hidden.starts.length === 0, "coming back does not resume by itself");
  hidden.gate.userStart();
  assert(hidden.starts.length === 1, "the next tap can start after a real grant");

  const resume = wireGate(createDeferredWx().wxApi);
  resume.gate.noteQuery({
    privacyKnown: true,
    needPrivacy: false,
    recordKnown: true,
    recordGranted: true,
    canAuthorize: true
  });
  resume.gate.userStart();
  assert(resume.starts.length === 1, "known grant starts without another authorize call");
  assert(resume.gate.recordingStarted() === true, "known grant still waits for the recorder");
  assert(resume.gate.pause("user") === true, "pause while listening");
  assert(resume.stops.length === 1, "pause stops the engine once");
  assert(resume.gate.getPhase() === "paused", "pause stays paused");
  assert(resume.gate.recordingStarted() === false, "a late recorder callback after pause is ignored");
  assert(resume.starts.length === 1, "pause does not start again");
  resume.gate.noteQuery({
    privacyKnown: true,
    needPrivacy: false,
    recordKnown: true,
    recordGranted: false,
    canAuthorize: true
  });
  resume.gate.userStart();
  assert(resume.starts.length === 1, "retry after a denial does not start");
  assert(lastStatus(resume.statuses).label === "麦克风未授权", "denial keeps the settings path");

  const opening = wireGate(createDeferredWx().wxApi);
  opening.gate.noteQuery({
    privacyKnown: true,
    needPrivacy: false,
    recordKnown: true,
    recordGranted: true,
    canAuthorize: true
  });
  opening.gate.userStart();
  assert(opening.gate.getPhase() === "opening", "open before the recorder callback");
  assert(opening.gate.pause("user") === true, "pause can cancel opening");
  assert(opening.stops.length === 1, "cancel opening stops the engine");
  assert(opening.gate.recordingStarted() === false, "opening cancelled before the callback");
  assert(opening.starts.length === 1, "cancelled opening does not start a second time");
  opening.gate.failEngine("network");
  assert(opening.starts.length === 1, "a network error does not start listening again");
  assert(opening.gate.getPhase() === "idle", "a network error leaves the gate idle until the next tap");

  const settings = wireGate(createDeferredWx().wxApi);
  const closed = await openRecordSettings({});
  assert(closed.opened === false, "missing openSetting is not success");
  settings.gate.settingsFinished(closed);
  assert(lastStatus(settings.statuses).label === "没有打开设置", "settings failure copy");
  assert(settings.starts.length === 0, "failed settings does not start");
  settings.gate.settingsFinished({ opened: true, recordGranted: false });
  assert(lastStatus(settings.statuses).label === "麦克风未授权", "settings still denied");
  assert(settings.starts.length === 0, "returning without the microphone does not start");
  settings.gate.settingsFinished({ opened: true, recordGranted: true });
  assert(lastStatus(settings.statuses).label === "麦克风已允许", "settings grant copy");
  assert(settings.gate.getPhase() === "idle", "settings grant stays idle");
  assert(settings.starts.length === 0, "settings grant waits for another tap");

  const unsupported = wireGate(createDeferredWx().wxApi);
  unsupported.gate.setCanAuthorize(false);
  unsupported.gate.userStart();
  assert(lastStatus(unsupported.statuses).label === "需要升级微信", "missing authorize api");
  assert(unsupported.starts.length === 0, "unsupported WeChat does not start");
}

function checkSyntax() {
  walk(miniRoot, []).filter((file) => file.endsWith(".js")).forEach((file) => {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  });
  walk(miniRoot, []).concat([path.join(root, "project.config.json")]).forEach((file) => {
    if (file.endsWith(".json")) JSON.parse(fs.readFileSync(file, "utf8"));
    if (file.endsWith(".wxss")) checkBraces(file);
    if (file.endsWith(".wxml")) checkWxml(file);
  });
}

checkProjectShape();
const createWechatSIEngine = checkEngine();
await testRecognition(createWechatSIEngine);
await testAccessGate();
checkSyntax();
console.log("miniprogram check ok");
console.log("assertions passed: " + assertions);
console.log("access gate simulation ok (not a phone test)");
