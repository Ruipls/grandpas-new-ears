const { createSpeechEngine } = require("../../engines/index");
const { loadSettings, saveSettings, appendHistory } = require("../../utils/storage");
const {
  LANGUAGES,
  FONT_SCALES,
  isLanguage,
  isFontScale,
  languageLabel,
  formatClock,
  formatDuration,
  createId,
  commitCaption
} = require("../../utils/format");
const { applyNavigationTheme } = require("../../utils/theme");
const { createAccessGate } = require("../../utils/access-flow");
const { assessRuntime } = require("../../utils/readiness");
const {
  queryPrivacy,
  queryRecord,
  requestRecordAuthorize,
  openRecordSettings,
  openPrivacyContract
} = require("../../utils/permission");

Page({
  data: {
    languages: LANGUAGES,
    fonts: FONT_SCALES,
    sourceLanguage: "zh_CN",
    fontScale: "large",
    contrast: "soft",
    statusState: "idle",
    statusLabel: "待机",
    statusDetail: "点「开始」就能看见字幕。",
    segments: [],
    partialText: "",
    anchor: "",
    listening: false,
    paused: false,
    opening: false,
    sessionActive: false,
    stopping: false,
    micDenied: false,
    privacyNeeded: false,
    privacyBlocked: false
  },

  onLoad() {
    if (this._booted) return;
    this._booted = true;
    const settings = loadSettings();
    this.sessionStartedAt = null;
    this.segments = [];
    this._unloaded = false;
    this._stopPromise = null;
    this._interimTimer = null;
    this._pendingInterim = "";
    this.engine = createSpeechEngine();
    this.gate = createAccessGate({
      onStatus: (copy) => this.applyCopy(copy),
      onView: (patch) => {
        if (!this._unloaded) this.setData(patch);
      },
      onPhase: (phase) => this.applyPhase(phase),
      onRequestAuthorize: () => this.requestAuthorize(),
      onStartEngine: () => this.beginEngine(),
      onStopEngine: () => this.stopEngine()
    });
    this.gate.setCanAuthorize(typeof wx.authorize === "function");
    this.bindEngine();
    this._appHide = () => {
      if (this.gate) this.gate.setVisible(false);
    };
    if (wx.onAppHide) wx.onAppHide(this._appHide);
    this.setData({
      sourceLanguage: settings.sourceLanguage,
      fontScale: settings.fontScale,
      contrast: settings.contrast
    });
    applyNavigationTheme(settings.contrast);
  },

  onShow() {
    if (this.gate) this.gate.setVisible(true);
    this.refreshAccess();
    applyNavigationTheme(this.data.contrast);
  },

  onHide() {
    if (this.gate) this.gate.setVisible(false);
  },

  onUnload() {
    this._unloaded = true;
    if (this._interimTimer) {
      clearTimeout(this._interimTimer);
      this._interimTimer = null;
    }
    if (this._appHide && wx.offAppHide) wx.offAppHide(this._appHide);
    this.setKeepScreen(false);
    if (this.engine) this.engine.stop();
  },

  bindEngine() {
    this.engine.onInterim((text) => {
      if (this._unloaded || !this.data.listening || this.data.paused) return;
      this._pendingInterim = text || "";
      if (this._interimTimer) return;
      this._interimTimer = setTimeout(() => {
        this._interimTimer = null;
        if (this._unloaded || !this.data.listening || this.data.paused) return;
        this.setData({ partialText: this._pendingInterim }, () => this.scrollToEnd());
      }, 120);
    });

    this.engine.onFinal((text, meta) => {
      if (this._unloaded || this._closedSession) return;
      this._provisional = Boolean(meta && meta.provisional);
      this.appendSegment(text);
    });

    this.engine.onRevise((text) => {
      if (this._unloaded || this._closedSession) return;
      this.replaceProvisional(text);
    });

    this.engine.onError((error) => {
      if (this._unloaded) return;
      this.showEngineError(error);
    });

    this.engine.onStarted(() => {
      if (this._unloaded || !this.gate) return;
      if (!this.gate.recordingStarted()) return;
      this.setData({
        listening: true,
        opening: false,
        paused: false,
        micDenied: false,
        privacyNeeded: false,
        privacyBlocked: false
      });
      this.setKeepScreen(true);
      this.setStatus("listening", "正在听", languageLabel(this.data.sourceLanguage));
    });

    this.engine.onPending((reason) => {
      if (this._unloaded || this.data.paused || this.data.stopping || this._closedSession) return;
      this.setData({ listening: false, opening: true });
      this.setKeepScreen(true);
      if (reason === "retry") {
        this.setStatus("pending", "正在重新连接", "刚才中断了，正在再试一次。现在没有在听。");
        return;
      }
      this.setStatus("pending", "正在接上", "上一小段已经结束。下一小段要等录音真正开始，才会显示正在听。");
    });
  },

  refreshAccess() {
    Promise.all([queryPrivacy(wx), queryRecord(wx)]).then((results) => {
      if (this._unloaded || !this.gate) return;
      const privacy = results[0];
      const record = results[1];
      this.gate.noteQuery({
        privacyKnown: privacy.privacyKnown,
        privacyFailed: privacy.failed === true,
        needPrivacy: privacy.needPrivacy,
        recordKnown: record.recordKnown,
        recordGranted: record.recordGranted,
        canAuthorize: typeof wx.authorize === "function"
      });
    });
  },

  requestAuthorize() {
    requestRecordAuthorize(wx, {
      success: () => {
        if (this._unloaded || !this.gate) return;
        this.gate.authorizeFinished(null, true);
      },
      fail: (error) => {
        queryRecord(wx).then((record) => {
          if (this._unloaded || !this.gate) return;
          this.gate.authorizeFinished(error, record.recordGranted);
        });
      }
    });
  },

  allowStart() {
    const ready = assessRuntime(wx);
    if (ready.ok) return true;
    this.setStatus(ready.state, ready.label, ready.detail);
    return false;
  },

  onStart() {
    if (!this.gate || !this.allowStart()) return;
    this.gate.userStart();
  },

  onAgreePrivacy() {
    if (!this.gate || !this.allowStart()) return;
    this.gate.agree();
  },

  onDeclinePrivacy() {
    if (!this.gate) return;
    this.gate.declinePrivacy();
  },

  async beginEngine() {
    if (this._stopPromise) await this._stopPromise;
    if (this._unloaded || !this.gate || !this.gate.isOpening()) return;
    this._closedSession = false;
    if (!this.sessionStartedAt) {
      this.sessionStartedAt = new Date();
      this.segments = [];
      this.setData({
        sessionActive: true,
        segments: [],
        partialText: ""
      });
    }
    try {
      await this.engine.start({ lang: this.data.sourceLanguage });
    } catch (error) {
      if (this._unloaded) return;
      if (!this.segments.length) {
        this.sessionStartedAt = null;
        this.setData({ sessionActive: false });
      }
      this.showEngineError(error);
    }
  },

  onPause() {
    if (!this.gate || this.data.stopping) return;
    this.gate.pause("user");
  },

  async onStop() {
    if (this.data.stopping || !this.data.sessionActive) return;
    if (this.gate) this.gate.markStopping();
    this.setKeepScreen(false);
    await this.stopEngine();

    if (!this.segments.length) {
      this.resetSession();
      return;
    }

    const duration = formatDuration(Date.now() - this.sessionStartedAt.getTime());
    const summary = "共 " + this.segments.length + " 条字幕，时长 " + duration + "。要保存在这台手机上吗？";
    wx.showModal({
      title: "结束本次对话",
      content: summary,
      confirmText: "保存",
      cancelText: "不保存",
      success: (res) => {
        if (res.confirm) this.saveCurrentSession();
        this.resetSession();
      },
      fail: () => {
        this.resetSession();
      }
    });
  },

  onPickLanguage(event) {
    const lang = event.currentTarget.dataset.lang;
    if (this.data.stopping || !isLanguage(lang) || lang === this.data.sourceLanguage) return;
    const settings = this.persistSettings({ sourceLanguage: lang });
    this.setData({ sourceLanguage: settings.sourceLanguage });
    if (!this.data.listening || this.data.paused) return;
    this.setStatus("listening", "正在听", languageLabel(lang));
    this.stopEngine().then(() => {
      if (this._unloaded || !this.data.listening || this.data.paused) return;
      return this.engine.start({ lang: lang });
    }).catch((error) => {
      this.showEngineError(error);
    });
  },

  onPickFont(event) {
    const fontScale = event.currentTarget.dataset.font;
    if (this.data.stopping || !isFontScale(fontScale) || fontScale === this.data.fontScale) return;
    const settings = this.persistSettings({ fontScale: fontScale });
    this.setData({ fontScale: settings.fontScale });
  },

  onToggleContrast() {
    if (this.data.stopping) return;
    const contrast = this.data.contrast === "high" ? "soft" : "high";
    const settings = this.persistSettings({ contrast: contrast });
    this.setData({ contrast: settings.contrast });
  },

  onOpenHistory() {
    if (this.data.stopping) return;
    wx.navigateTo({ url: "/pages/history/history" });
  },

  onOpenSetting() {
    openRecordSettings(wx).then((result) => {
      if (this._unloaded || !this.gate) return;
      this.gate.settingsFinished(result);
    });
  },

  onOpenContract() {
    openPrivacyContract(wx).then((result) => {
      if (this._unloaded || !this.gate || result.opened) return;
      this.gate.contractFailed();
    });
  },

  applyCopy(copy) {
    if (!copy) return;
    this.setStatus(copy.state, copy.label, copy.detail);
  },

  applyPhase(phase) {
    if (this._unloaded) return;
    if (phase === "opening") {
      this.setData({ opening: true, listening: false, paused: false });
      this.setKeepScreen(true);
      return;
    }
    if (phase === "listening") {
      this.setData({
        opening: false,
        listening: true,
        paused: false,
        micDenied: false,
        privacyNeeded: false,
        privacyBlocked: false
      });
      this.setKeepScreen(true);
      return;
    }
    if (phase === "paused") {
      this.setData({ opening: false, listening: false, paused: true });
      this.setKeepScreen(false);
      return;
    }
    if (phase === "stopping") {
      this.setData({
        opening: false,
        listening: false,
        paused: false,
        stopping: true
      });
      this.setKeepScreen(false);
      return;
    }
    this.setData({
      opening: false,
      listening: false,
      paused: false,
      stopping: false
    });
    this.setKeepScreen(false);
  },

  stopEngine() {
    if (!this.engine) return Promise.resolve();
    if (this._stopPromise) return this._stopPromise;
    let pending;
    pending = this.engine.stop().then(() => {
      if (this._stopPromise === pending) this._stopPromise = null;
    }, () => {
      if (this._stopPromise === pending) this._stopPromise = null;
    });
    this._stopPromise = pending;
    return pending;
  },

  appendSegment(text) {
    if (this._interimTimer) {
      clearTimeout(this._interimTimer);
      this._interimTimer = null;
    }
    const previous = this.segments[this.segments.length - 1];
    const clean = commitCaption(previous && previous.text, text);
    if (!clean) {
      this.setData({ partialText: "" });
      return;
    }
    const createdAt = new Date().toISOString();
    this.segments = this.segments.concat([{
      id: createId(),
      text: clean,
      createdAt: createdAt,
      clock: formatClock(createdAt)
    }]);
    this.setData({
      segments: this.segments,
      partialText: ""
    }, () => this.scrollToEnd());
  },

  replaceProvisional(text) {
    if (this._interimTimer) {
      clearTimeout(this._interimTimer);
      this._interimTimer = null;
    }
    const clean = commitCaption("", text);
    if (!clean) {
      this.setData({ partialText: "" });
      return;
    }
    const last = this.segments[this.segments.length - 1];
    if (this._provisional && last) {
      last.text = clean;
      this._provisional = false;
      this.segments = this.segments.slice();
      this.setData({
        segments: this.segments,
        partialText: ""
      }, () => this.scrollToEnd());
      return;
    }
    this._provisional = false;
    this.appendSegment(clean);
  },

  saveCurrentSession() {
    if (!this.segments.length || !this.sessionStartedAt) return;
    appendHistory({
      id: createId(),
      startedAt: this.sessionStartedAt.toISOString(),
      endedAt: new Date().toISOString(),
      sourceLanguage: this.data.sourceLanguage,
      durationMs: Date.now() - this.sessionStartedAt.getTime(),
      segments: this.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        createdAt: segment.createdAt
      }))
    });
  },

  resetSession() {
    this.sessionStartedAt = null;
    this.segments = [];
    this._pendingInterim = "";
    this._provisional = false;
    this._closedSession = true;
    if (this.gate) this.gate.reset();
    this.setKeepScreen(false);
    this.setData({
      sessionActive: false,
      listening: false,
      paused: false,
      opening: false,
      stopping: false,
      segments: [],
      partialText: "",
      micDenied: false
    });
    this.setStatus("idle", "待机", "点「开始」就能看见字幕。");
  },

  persistSettings(partial) {
    const settings = saveSettings({
      sourceLanguage: partial.sourceLanguage || this.data.sourceLanguage,
      fontScale: partial.fontScale || this.data.fontScale,
      contrast: partial.contrast || this.data.contrast
    });
    applyNavigationTheme(settings.contrast);
    return settings;
  },

  showEngineError(error) {
    const code = error && error.code;
    this.setKeepScreen(false);
    if (this.gate) this.gate.failEngine(code);
    if (code === "interrupted") {
      this.setStatus("paused", "已暂停", "收音被打断了。请再点开始。");
      return;
    }
    if (code === "network") {
      this.setStatus("error", "网络异常", "请检查网络后，再点开始。现在没有在听。");
      return;
    }
    if (code === "timeout") {
      this.setStatus("error", "识别超时", "这次没有在限定时间内听完。请再点开始。现在没有在听。");
      return;
    }
    if (code === "transmission") {
      this.setStatus("error", "没有听完整", "刚才的声音没有传完。请再点开始。现在没有在听。");
      return;
    }
    if (code === "start-timeout") {
      this.setStatus("error", "没有开始听", "录音没有开始。请再点一次。如果总是这样，请让家人确认插件和隐私指引。");
      return;
    }
    if (code === "mic") {
      this.setStatus("error", "录音出错", "录音接口出错。这不一定是没授权。请再点开始。如果之前点过拒绝，再去设置里打开麦克风。现在没有在听。");
      return;
    }
    if (code === "limited") {
      this.setStatus("error", "请稍等", "识别次数太多，请稍后再试。");
      return;
    }
    if (code === "unavailable") {
      this.setStatus("error", "暂不可用", "语音识别还没准备好。请让家人按说明检查小程序插件和基础库。");
      return;
    }
    this.setStatus("error", "识别失败", "这次没有听成。请再点开始试一次。");
  },

  setStatus(stateName, label, detail) {
    if (this._unloaded) return;
    this.setData({
      statusState: stateName,
      statusLabel: label,
      statusDetail: detail
    });
  },

  setKeepScreen(on) {
    if (!wx.setKeepScreenOn) return;
    wx.setKeepScreenOn({
      keepScreenOn: Boolean(on),
      fail() {}
    });
  },

  scrollToEnd() {
    if (this._unloaded) return;
    this.setData({ anchor: "" });
    const apply = () => {
      if (!this._unloaded) this.setData({ anchor: "caption-end" });
    };
    if (wx.nextTick) wx.nextTick(apply);
    else setTimeout(apply, 30);
  }
});
