function queryPrivacy(wxApi) {
  return new Promise((resolve) => {
    if (!wxApi || typeof wxApi.getPrivacySetting !== "function") {
      resolve({
        privacyKnown: false,
        privacySupported: false,
        needPrivacy: false,
        contractName: ""
      });
      return;
    }
    wxApi.getPrivacySetting({
      success(res) {
        resolve({
          privacyKnown: true,
          privacySupported: true,
          needPrivacy: Boolean(res && res.needAuthorization),
          contractName: res && res.privacyContractName ? res.privacyContractName : ""
        });
      },
      fail() {
        resolve({
          privacyKnown: false,
          privacySupported: true,
          needPrivacy: false,
          contractName: "",
          failed: true
        });
      }
    });
  });
}

function queryRecord(wxApi) {
  return new Promise((resolve) => {
    if (!wxApi || typeof wxApi.getSetting !== "function") {
      resolve({ recordKnown: false, recordGranted: undefined });
      return;
    }
    wxApi.getSetting({
      success(res) {
        const auth = res && res.authSetting ? res.authSetting["scope.record"] : undefined;
        if (auth === true) resolve({ recordKnown: true, recordGranted: true });
        else if (auth === false) resolve({ recordKnown: true, recordGranted: false });
        else resolve({ recordKnown: true, recordGranted: undefined });
      },
      fail() {
        resolve({ recordKnown: false, recordGranted: undefined });
      }
    });
  });
}

function requestRecordAuthorize(wxApi, handlers) {
  const done = handlers || {};
  if (!wxApi || typeof wxApi.authorize !== "function") {
    if (done.fail) done.fail({ errMsg: "authorize:fail unsupported" });
    return;
  }
  wxApi.authorize({
    scope: "scope.record",
    success() {
      if (done.success) done.success();
    },
    fail(error) {
      if (done.fail) done.fail(error || { errMsg: "authorize:fail" });
    }
  });
}

function openRecordSettings(wxApi) {
  return new Promise((resolve) => {
    if (!wxApi || typeof wxApi.openSetting !== "function") {
      resolve({ opened: false, recordGranted: undefined });
      return;
    }
    wxApi.openSetting({
      success(res) {
        const auth = res && res.authSetting ? res.authSetting["scope.record"] : undefined;
        if (auth === true) resolve({ opened: true, recordGranted: true });
        else if (auth === false) resolve({ opened: true, recordGranted: false });
        else resolve({ opened: true, recordGranted: undefined });
      },
      fail() {
        resolve({ opened: false, recordGranted: undefined });
      }
    });
  });
}

function openPrivacyContract(wxApi) {
  return new Promise((resolve) => {
    if (!wxApi || typeof wxApi.openPrivacyContract !== "function") {
      resolve({ opened: false, unsupported: true });
      return;
    }
    wxApi.openPrivacyContract({
      success() {
        resolve({ opened: true });
      },
      fail() {
        resolve({ opened: false });
      }
    });
  });
}

module.exports = {
  queryPrivacy,
  queryRecord,
  requestRecordAuthorize,
  openRecordSettings,
  openPrivacyContract
};
