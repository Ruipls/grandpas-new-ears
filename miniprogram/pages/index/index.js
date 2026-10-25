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
  normalizeCaption
} = require("../../utils/format");
const { applyNavigationTheme } = require("../../utils/theme");
const { ensurePrivacyAuthorize, ensureRecordPermission } = require("../../utils/permission");

const LEAVE_HINT = "锁屏或离开后已停止收音，请再点开始。";

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
    sessionActive: false,
    stopping: false,
    micDenied: false,
    privacyNeeded: false
  },

  onLoad() {
    const settings = loadSettings();
    this.sessionStartedAt = null;
    this.segments = [];
    this._unloaded = false;
    this._stopPromise = null;
    this._startLock = false;
    this._interimTimer = null;
    this._pendingInterim = "";
    this.engine = createSpeechEngine();
    this.bindEngine();
    this._appHide = () => this.pauseForLeave();
    if (wx.onAppHide) wx.onAppHide(this._appHide);
    this.setData({
      sourceLanguage: settings.sourceLanguage,
      fontScale: settings.fontScale,
      contrast: settings.contrast
    });
    applyNavigationTheme(settings.contrast);
  },

  onShow() {
    applyNavigationTheme(this.data.contrast);
  },

  onHide() {
    this.pauseForLeave();
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

    this.engine.onFinal((text) => {
      if (this._unloaded) return;
      this.appendSegment(text);
    });

    this.engine.onError((error) => {
      if (this._unloaded) return;
      this.showEngineError(error);
    });
  },

  async onStart() {
    if (this._startLock || this.data.stopping) return;
    if (this.data.listening && !this.data.paused) return;
    this._startLock = true;
    try {
      if (this._stopPromise) await this._stopPromise;
      try {
        await ensurePrivacyAuthorize();
        await ensureRecordPermission();
      } catch (error) {
        this.handlePermissionError(error);
        return;
      }

      if (!this.sessionStartedAt) {
        this.sessionStartedAt = new Date();
        this.segments = [];
        this.setData({
          sessionActive: true,
          segments: [],
          partialText: ""
        });
      }

      this.setData({
        listening: true,
        paused: false,
        micDenied: false,
        privacyNeeded: false
      });
      this.setKeepScreen(true);
      this.setStatus("listening", "正在听", languageLabel(this.data.sourceLanguage));

      try {
        await this.engine.start({ lang: this.data.sourceLanguage });
      } catch (error) {
        this.showEngineError(error);
        if (!this.segments.length) {
          this.sessionStartedAt = null;
          this.setData({
            sessionActive: false,
            listening: false,
            paused: false
          });
        }
      }
    } finally {
      this._startLock = false;
    }
  },

  onPause() {
    if (this.data.stopping || !this.data.listening || this.data.paused) return;
    this.setData({ paused: true });
    this.setKeepScreen(false);
    this.setStatus("paused", "已暂停", "点「继续」接着听。");
    this.stopEngine();
  },

  async onStop() {
    if (this.data.stopping || !this.data.sessionActive) return;
    this.setData({
      stopping: true,
      listening: false,
      paused: false
    });
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
      this.setData({ listening: false, paused: false });
      this.setKeepScreen(false);
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
    wx.openSetting({
      success: (res) => {
        const allowed = res && res.authSetting && res.authSetting["scope.record"] === true;
        if (!allowed) return;
        this.setData({ micDenied: false });
        this.setStatus("idle", "待机", "麦克风已允许，请点开始。");
      }
    });
  },

  onReviewPrivacy() {
    if (wx.openPrivacyContract) wx.openPrivacyContract({});
    ensurePrivacyAuthorize().then(() => {
      if (this._unloaded) return;
      this.setData({ privacyNeeded: false });
      this.setStatus("idle", "待机", "已同意隐私说明，请点开始。");
    }).catch(() => {});
  },

  pauseForLeave() {
    if (this._unloaded || !this.data.listening || this.data.paused) return;
    this.setData({ paused: true });
    this.setKeepScreen(false);
    this.setStatus("paused", "已暂停", LEAVE_HINT);
    this.stopEngine();
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
    const clean = normalizeCaption(text);
    if (!clean) {
      this.setData({ partialText: "" });
      return;
    }
    const previous = this.segments[this.segments.length - 1];
    if (previous && previous.text === clean) {
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
    this.setKeepScreen(false);
    this.setData({
      sessionActive: false,
      listening: false,
      paused: false,
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

  handlePermissionError(error) {
    if (error && error.code === "privacy") {
      this.setData({ privacyNeeded: true, micDenied: false });
      this.setStatus("error", "请先同意", "需要同意隐私保护指引，才能使用麦克风。");
      return;
    }
    this.setData({ micDenied: true, privacyNeeded: false });
    this.setStatus("error", "麦克风未授权", "请打开设置，允许使用麦克风，然后回来再点开始。");
  },

  showEngineError(error) {
    const code = error && error.code;
    this.setKeepScreen(false);
    if (code === "interrupted") {
      this.setData({ listening: false, paused: true });
      this.setStatus("paused", "已暂停", "收音被打断了。请再点开始。");
      return;
    }
    this.setData({ listening: false, paused: false });
    if (code === "network") {
      this.setStatus("error", "网络异常", "请检查网络后，再点开始。");
      return;
    }
    if (code === "mic") {
      this.setData({ micDenied: true });
      this.setStatus("error", "麦克风未授权", "请打开设置，允许使用麦克风。如果已经允许，请看看麦克风是否被别的应用占用。");
      return;
    }
    if (code === "limited") {
      this.setStatus("error", "请稍等", "识别次数太多，请稍后再试。");
      return;
    }
    if (code === "unavailable") {
      this.setStatus("error", "暂不可用", "语音识别还没准备好。请让家人按说明检查小程序设置。");
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
