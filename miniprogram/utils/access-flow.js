// Pure gate for privacy consent and scope.record.
// These decisions do not call WeChat and do not mean a phone has allowed the microphone.
// Error classes follow the public privacy guide:
// errno 112 / "not declared in the privacy agreement",
// "appid privacy api banned",
// errno 103 and 104, and "privacy permission is not authorized".
// Sources and the parts that are still uncertain are in docs/MINIPROGRAM.md.

const COPY = {
  privacyNeeded: {
    state: "error",
    label: "请先同意",
    detail: "需要先同意隐私保护指引，才能使用麦克风。请点「同意并开始」。如果点了没有反应，指引可能还在审核。"
  },
  privacyRefused: {
    state: "error",
    label: "还未同意",
    detail: "刚才没有同意隐私保护指引，所以还不能听。请再点「同意并开始」。如果刚刚拒绝过，请等约 10 秒再点，否则微信可能不弹窗。"
  },
  declined: {
    state: "error",
    label: "还未同意",
    detail: "你还没有同意隐私保护指引，所以不会使用麦克风。想听的时候，再点「同意并开始」。"
  },
  undeclared: {
    state: "error",
    label: "指引未生效",
    detail: "微信还不允许使用麦克风：生效中的隐私保护指引没有「访问你的麦克风」。若指引正在审核或刚保存，请等它生效后再试。手机系统里给微信开了麦克风，也不等于这个小程序已经获准。"
  },
  banned: {
    state: "error",
    label: "暂不能听",
    detail: "微信停用了这个小程序的麦克风。请确认已填写隐私保护指引，并且没有选择「未采集隐私」。"
  },
  micDenied: {
    state: "error",
    label: "麦克风未授权",
    detail: "这个小程序还不能用麦克风。请点「去打开设置」，打开后再点开始。"
  },
  settingsStillDenied: {
    state: "error",
    label: "麦克风未授权",
    detail: "设置里还没有打开麦克风。打开后再回来点开始。"
  },
  settingsFailed: {
    state: "error",
    label: "没有打开设置",
    detail: "这次没有打开设置。请再点一次「去打开设置」。"
  },
  micUnknown: {
    state: "error",
    label: "没有弹出授权",
    detail: "这次没有弹出麦克风授权，还没有开始听。请再点一次「开始」。如果仍然没有，请让家人确认隐私保护指引已经生效。"
  },
  unsupported: {
    state: "error",
    label: "需要升级微信",
    detail: "当前微信版本不能申请麦克风。请升级微信后再试。"
  },
  contractFailed: {
    state: "error",
    label: "暂时打不开",
    detail: "暂时打不开隐私保护指引。可能还在审核，或公众平台还没配置好。"
  },
  allowedIdle: {
    state: "idle",
    label: "麦克风已允许",
    detail: "请再点一次开始。现在还没有在听。"
  },
  opening: {
    state: "pending",
    label: "正在打开麦克风",
    detail: "请稍等。只有真正开始收音，才会显示「正在听」。"
  },
  paused: {
    state: "paused",
    label: "已暂停",
    detail: "点「继续」接着听。"
  },
  left: {
    state: "paused",
    label: "已暂停",
    detail: "锁屏或离开后已停止收音，请再点开始。"
  }
};

function classifyAuthorizeError(error) {
  const errno = error && error.errno != null ? Number(error.errno) : NaN;
  const msg = String((error && (error.errMsg || error.message)) || "").toLowerCase();
  if (errno === 112 || msg.indexOf("not declared in the privacy agreement") !== -1) return "undeclared";
  if (msg.indexOf("appid privacy api banned") !== -1) return "banned";
  if (errno === 103 || errno === 104 || msg.indexOf("privacy permission is not authorized") !== -1) {
    return "privacy-refused";
  }
  if (msg.indexOf("auth deny") !== -1 || msg.indexOf("auth denied") !== -1) return "auth-deny";
  return "unknown";
}

function createAccessGate(hooks) {
  const call = hooks || {};
  function onStatus(copy) {
    if (call.onStatus) call.onStatus(copy);
  }
  function onView(patch) {
    if (call.onView) call.onView(patch);
  }
  function onPhase(phase) {
    if (call.onPhase) call.onPhase(phase);
  }

  let recordGranted;
  let needPrivacy;
  let canAuthorize = true;
  let visible = true;
  let phase = "idle";
  let wantsStart = false;
  let acceptStart = false;
  let pendingAuthorize = false;

  function showPrivacyPrompt() {
    onView({ privacyNeeded: true, micDenied: false, privacyBlocked: false });
    onStatus(COPY.privacyNeeded);
  }

  function showMicDenied() {
    onView({ micDenied: true, privacyNeeded: false, privacyBlocked: false });
    onStatus(COPY.micDenied);
  }

  function tryStart() {
    if (!wantsStart || !visible || phase === "stopping" || phase === "opening" || phase === "listening") {
      return;
    }
    phase = "opening";
    acceptStart = true;
    onPhase("opening");
    onStatus(COPY.opening);
    if (call.onStartEngine) call.onStartEngine();
  }

  function requestAuthorize() {
    if (!canAuthorize) {
      wantsStart = false;
      onStatus(COPY.unsupported);
      return;
    }
    pendingAuthorize = true;
    if (call.onRequestAuthorize) call.onRequestAuthorize();
  }

  function beginOrAuthorize() {
    if (recordGranted === false) {
      wantsStart = false;
      showMicDenied();
      return;
    }
    wantsStart = true;
    if (recordGranted === true) {
      tryStart();
      return;
    }
    requestAuthorize();
  }

  function blocked(kind) {
    const copy = kind === "banned" ? COPY.banned : COPY.undeclared;
    onView({ privacyBlocked: true, privacyNeeded: false, micDenied: false });
    onStatus(copy);
  }

  return {
    getPhase() {
      return phase;
    },
    isOpening() {
      return phase === "opening" && acceptStart;
    },
    setCanAuthorize(value) {
      canAuthorize = Boolean(value);
    },
    setVisible(next) {
      visible = Boolean(next);
      if (!visible) this.leave();
    },
    noteQuery(info) {
      const query = info || {};
      if (query.privacyKnown) needPrivacy = query.needPrivacy === true;
      if (query.recordKnown) recordGranted = query.recordGranted;
      if (query.canAuthorize != null) canAuthorize = Boolean(query.canAuthorize);
      if (phase === "listening" || phase === "opening" || phase === "stopping") return;
      if (needPrivacy === true) {
        showPrivacyPrompt();
        return;
      }
      if (query.privacyKnown && query.needPrivacy === false) {
        onView({ privacyNeeded: false });
      }
      if (recordGranted === false) showMicDenied();
    },
    userStart() {
      if (phase === "listening" || phase === "opening" || phase === "stopping" || pendingAuthorize) return;
      if (needPrivacy === true) {
        showPrivacyPrompt();
        return;
      }
      beginOrAuthorize();
    },
    agree() {
      if (phase === "listening" || phase === "opening" || phase === "stopping" || pendingAuthorize) return;
      // The agree button event is the user's consent. Microphone scope is still separate.
      needPrivacy = false;
      onView({ privacyNeeded: false, privacyBlocked: false });
      beginOrAuthorize();
    },
    authorizeFinished(error, granted) {
      pendingAuthorize = false;
      if (granted === true) recordGranted = true;
      if (granted === false) recordGranted = false;
      if (!error) {
        if (!wantsStart || !visible || phase === "stopping") {
          wantsStart = false;
          onView({ micDenied: false, privacyNeeded: false, privacyBlocked: false });
          onStatus(COPY.allowedIdle);
          return;
        }
        tryStart();
        return;
      }
      wantsStart = false;
      const kind = classifyAuthorizeError(error);
      if (kind === "banned" || kind === "undeclared") {
        blocked(kind);
        return;
      }
      if (granted === false || kind === "auth-deny") {
        recordGranted = false;
        showMicDenied();
        return;
      }
      if (kind === "privacy-refused") {
        needPrivacy = true;
        onView({ privacyNeeded: true, micDenied: false, privacyBlocked: false });
        onStatus(COPY.privacyRefused);
        return;
      }
      onView({
        micDenied: false,
        privacyNeeded: needPrivacy === true,
        privacyBlocked: false
      });
      onStatus(COPY.micUnknown);
    },
    recordingStarted() {
      if (phase === "listening") return true;
      if (!acceptStart || phase !== "opening") return false;
      acceptStart = false;
      phase = "listening";
      onPhase("listening");
      return true;
    },
    pause(reason) {
      if (phase !== "listening" && phase !== "opening") return false;
      wantsStart = false;
      acceptStart = false;
      pendingAuthorize = false;
      phase = "paused";
      onPhase("paused");
      if (call.onStopEngine) call.onStopEngine();
      onStatus(reason === "leave" ? COPY.left : COPY.paused);
      return true;
    },
    leave() {
      visible = false;
      if (phase === "listening" || phase === "opening") return this.pause("leave");
      return false;
    },
    markStopping() {
      wantsStart = false;
      acceptStart = false;
      pendingAuthorize = false;
      phase = "stopping";
      onPhase("stopping");
    },
    failEngine(code) {
      acceptStart = false;
      wantsStart = false;
      pendingAuthorize = false;
      if (phase === "stopping") return;
      if (code === "interrupted") {
        phase = "paused";
        onPhase("paused");
        return;
      }
      phase = "idle";
      onPhase("idle");
    },
    reset() {
      wantsStart = false;
      acceptStart = false;
      pendingAuthorize = false;
      phase = "idle";
      onPhase("idle");
    },
    declinePrivacy() {
      wantsStart = false;
      acceptStart = false;
      pendingAuthorize = false;
      if (phase === "listening" || phase === "opening") {
        this.pause("user");
      }
      needPrivacy = true;
      onView({ privacyNeeded: true, micDenied: false, privacyBlocked: false });
      onStatus(COPY.declined);
    },
    settingsFinished(result) {
      const value = result || {};
      if (!value.opened) {
        onStatus(COPY.settingsFailed);
        return;
      }
      if (value.recordGranted === true) {
        recordGranted = true;
        onView({ micDenied: false });
        if (needPrivacy === true) {
          showPrivacyPrompt();
          return;
        }
        onStatus(COPY.allowedIdle);
        return;
      }
      recordGranted = false;
      onView({ micDenied: true, privacyNeeded: false, privacyBlocked: false });
      onStatus(COPY.settingsStillDenied);
    },
    contractFailed() {
      onView({ privacyBlocked: true });
      onStatus(COPY.contractFailed);
    }
  };
}

module.exports = {
  COPY,
  classifyAuthorizeError,
  createAccessGate
};
