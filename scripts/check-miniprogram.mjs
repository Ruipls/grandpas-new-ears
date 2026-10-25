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

function assert(condition, message) {
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
  assert(page.includes("createSpeechEngine"), "caption screen must use the engine interface");
  assert(!page.includes("requirePlugin"), "caption screen must not load the plugin directly");
  assert(!page.includes("wechat-si"), "caption screen must not name the provider");
  assert(!page.includes("getRecorderManager"), "caption screen must not own the recorder");
  ["scope.record", "setKeepScreenOn", "正在听", "已暂停", "网络异常", "麦克风未授权"].forEach((needle) => {
    assert(page.includes(needle), "caption screen missing " + needle);
  });
  const labels = read("miniprogram/utils/format.js");
  ["普通话", "English", "粤语", "超大", "巨大"].forEach((needle) => {
    assert(labels.includes(needle), "format.js missing " + needle);
  });
  ["讲话语言", "字号", "高对比", "去打开设置", "正在说"].forEach((needle) => {
    assert(markup.includes(needle), "caption markup missing " + needle);
  });
  assert(read("miniprogram/pages/history/history.js").includes("清空"), "history needs clear-all");

  const doc = read("docs/MINIPROGRAM.md");
  ["touristappid", "同声传译", "wx069ba97219f66d99", "隐私", "备案", "待核实"].forEach((needle) => {
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

  await engine.start({ lang: "en_US" });
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

  fake.nextResult = "tail";
  const stopped = engine.stop();
  scheduler.flush();
  await stopped;
  assert(finals[finals.length - 1] === "tail", "user stop keeps the last result");
  assert(fake.starts.length === 2, "user stop does not restart");
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
checkSyntax();
console.log("miniprogram check ok");
