"use strict";

(function privateSignIn(global) {
  const element = id => document.getElementById(id);
  const form = element("private-sign-in-form"), status = element("sign-in-status"), button = element("sign-in-submit");
  const email = element("operator-email"), password = element("operator-password"), nextPassword = element("operator-new-password");
  const name = element("operator-name"), confirmation = element("operator-confirm-password"), retry = element("first-run-retry");
  const title = element("sign-in-title"), description = element("sign-in-description"), help = element("sign-in-help");
  const params = new URLSearchParams(global.location.search), changing = params.get("mode") === "password", security = params.get("mode") === "security";
  const factorForm = element("two-factor-form"), factorCode = element("two-factor-code"), factorPassword = element("two-factor-password");
  const factorPasswordForm = element("two-factor-password-form"), factorChange = element("two-factor-change"), factorVerify = element("two-factor-verify");
  const factorBackup = element("two-factor-use-backup"), factorCancel = element("two-factor-cancel"), factorSaved = element("two-factor-saved");
  const requested = params.get("returnTo") || "#/";
  const returnTo = /^#\/[a-zA-Z0-9_/?=&%.:-]*$/.test(requested) && requested.length <= 512 ? requested : "#/";
  let mode = "loading", busy = false, disposed = false, controller = null, factorEnabled = false, backupMode = false;
  const clearPasswords = () => { password.value = ""; nextPassword.value = ""; confirmation.value = ""; };
  const clearFactorSecrets = () => { factorPassword.value = ""; factorCode.value = ""; factorSaved.checked = false; for (const id of ["two-factor-key", "two-factor-uri", "two-factor-backup-codes"]) element(id).value = ""; };
  const signedInTarget = () => security ? "/sign-in?mode=security&returnTo=" + encodeURIComponent(returnTo) : "/" + returnTo;
  function show(nextMode) {
    mode = nextMode;
    const creating = mode === "create", changingPassword = mode === "change";
    form.hidden = !["create", "sign-in", "change"].includes(mode);
    element("name-label").hidden = !creating; name.required = creating;
    element("email-label").hidden = changingPassword; email.required = !changingPassword;
    element("new-password-label").hidden = !changingPassword; nextPassword.required = changingPassword;
    element("confirm-password-label").hidden = !creating; confirmation.required = creating;
    password.autocomplete = creating ? "new-password" : "current-password";
    element("first-run-local").hidden = mode !== "local";
    retry.hidden = !["unavailable", "local"].includes(mode); retry.disabled = busy;
    button.disabled = busy || form.hidden;
    element("account-security").hidden = mode !== "security";
    element("two-factor-enrollment").hidden = mode !== "enroll";
    factorForm.hidden = !["enroll", "challenge"].includes(mode);
    factorBackup.hidden = mode !== "challenge";
    for (const control of [factorChange, factorVerify, factorBackup, factorCancel]) control.disabled = busy;
    factorCode.maxLength = backupMode ? 11 : 6; factorCode.inputMode = backupMode ? "text" : "numeric";
    element("two-factor-code-label").textContent = backupMode ? "One-time backup code" : "Authenticator code";
    factorBackup.textContent = backupMode ? "Use an authenticator code" : "Use a backup code";
    if (creating) {
      title.textContent = "Create your administrator account";
      description.textContent = "This installation has no accounts yet. Create its first administrator to unlock your private SOC.";
      help.textContent = "Use a unique password of 15–128 characters. This account has full access to this installation. One-time setup closes after the first account is created; there are no shared default credentials or public sign-ups.";
      button.textContent = "Create administrator account";
    } else if (changingPassword) {
      title.textContent = "Change your password";
      description.textContent = "Enter your current password and a new password. Other sessions will be revoked.";
      help.textContent = "If you need a password reset, contact your installation owner.";
      button.textContent = "Update password";
    } else if (mode === "sign-in") {
      title.textContent = "Sign in to your SOC";
      description.textContent = "Use an operator account provisioned by the owner of this installation.";
      help.textContent = "No public registration or default credentials. If you need an account or a password reset, contact your installation owner.";
      button.textContent = "Sign in";
    } else if (mode === "security") {
      title.textContent = "Account security";
      description.textContent = "Better Auth protects your local and Tailnet sign-in. Add an authenticator as a second factor for your account.";
      element("two-factor-state").textContent = factorEnabled ? "Authenticator two-factor authentication is enabled for your account." : "Two-factor authentication is not enabled for your account yet.";
      factorChange.textContent = factorEnabled ? "Disable two-factor authentication" : "Set up authenticator";
      help.textContent = "Optional per account. No email or SMS codes and no trusted-device bypass. Keep the SOC private behind your Tailnet; 2FA does not make public exposure safe.";
    } else if (mode === "enroll") {
      title.textContent = "Finish authenticator setup";
      description.textContent = "Save your backup codes, then prove your authenticator is working. All existing sessions will be signed out when protection activates.";
      help.textContent = "This page does not save secrets in browser storage. A new sign-in will be required after verification.";
    } else if (mode === "challenge") {
      title.textContent = "Verify your second factor";
      description.textContent = "Enter the current six-digit code from your authenticator, or use one unused backup code. Password verification alone has not signed you in.";
      help.textContent = "The challenge expires after five minutes. Repeated failures are limited; start sign-in again if the challenge expires. Devices cannot skip this step.";
    } else {
      title.textContent = mode === "local" ? "Create the first account locally" : "Checking your installation";
      description.textContent = mode === "local" ? "One-time browser setup is available only through the installation's local loopback connection." : "The account form stays closed until the installation's setup state is verified.";
      help.textContent = "No shared default credentials. Additional accounts and password recovery are managed locally by the installation owner.";
    }
  }
  async function checkSecurity() {
    if (busy || disposed) return;
    busy = true; show("loading"); status.textContent = "Checking your account security…";
    let needsSignIn = false;
    try {
      const { value } = await request("/api/auth/two-factor/status", null, true);
      if (!value || Object.keys(value).sort().join(",") !== "enabled,method,schemaVersion,trustedDevicesAllowed" || value.schemaVersion !== "1" || typeof value.enabled !== "boolean" || value.method !== "totp" || value.trustedDevicesAllowed !== false) throw new Error("Invalid security status.");
      if (disposed) return;
      factorEnabled = value.enabled; show("security"); status.textContent = "";
    } catch (error) {
      if (disposed) return;
      needsSignIn = error.status === 401;
      if (!needsSignIn) { show("unavailable"); status.textContent = "Account security could not be verified. Check your connection and retry."; }
    } finally { busy = false; if (!disposed) { show(mode); if (needsSignIn) await checkSetup("Sign in before managing your account security."); } }
  }
  async function boundedJson(response) {
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) { await response.body?.cancel(); throw new Error("Invalid response."); }
    if (!response.body) throw new Error("Missing response.");
    const reader = response.body.getReader(), decoder = new TextDecoder(); let text = "", bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4096) throw new Error("Invalid response.");
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function request(url, value, parse) {
    controller = new AbortController();
    const activeController = controller, timeout = global.setTimeout(() => activeController.abort(), 20000);
    try {
      const response = await global.fetch(url, {
        method: value ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: activeController.signal, ...(value ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) } : {})
      });
      if (!response.ok) { await response.body?.cancel(); const error = new Error("Request refused."); error.status = response.status; throw error; }
      if (parse) return { status: response.status, value: await boundedJson(response) };
      await response.body?.cancel(); return { status: response.status };
    } finally { global.clearTimeout(timeout); if (controller === activeController) controller = null; }
  }
  async function checkSetup(message = "") {
    if (busy || disposed) return;
    busy = true; show("loading"); status.textContent = "Checking setup…";
    try {
      const { value } = await request("/api/v1/first-run", null, true);
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "browserSetupAllowed,schemaVersion,setupRequired" || value.schemaVersion !== "1" || typeof value.setupRequired !== "boolean" || typeof value.browserSetupAllowed !== "boolean") throw new Error("Invalid setup response.");
      if (disposed) return;
      show(value.setupRequired ? value.browserSetupAllowed ? "create" : "local" : "sign-in");
      status.textContent = message;
    } catch { if (!disposed) { show("unavailable"); status.textContent = "Setup status could not be verified. Check your connection and try again. No account has been created by this check."; } }
    finally { busy = false; if (!disposed) show(mode); }
  }
  retry.addEventListener("click", () => security ? checkSecurity() : checkSetup());
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || disposed || form.hidden || button.disabled) return;
    const creating = mode === "create", changingPassword = mode === "change";
    if (creating && (!name.value.trim() || name.value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(name.value) || !email.value.trim() || email.value.trim().length > 254 || password.value.length < 15 || password.value.length > 128 || /[\u0000-\u001f\u007f]/.test(password.value) || password.value !== confirmation.value)) {
      status.textContent = "Enter your name and email, then use a password of 15–128 characters that matches the confirmation. Control characters are not allowed."; return;
    }
    busy = true; button.disabled = true;
    status.textContent = creating ? "Creating your administrator account…" : changingPassword ? "Updating password…" : "Signing in…";
    let raced = false;
    try {
      const value = creating ? { name: name.value.trim(), email: email.value.trim(), password: password.value, confirmPassword: confirmation.value }
        : changingPassword ? { currentPassword: password.value, newPassword: nextPassword.value, revokeOtherSessions: true }
          : { email: email.value.trim(), password: password.value, rememberMe: false };
      const response = await request(creating ? "/api/v1/first-run" : changingPassword ? "/api/auth/change-password" : "/api/auth/sign-in/email", value, !changingPassword);
      clearPasswords();
      if (disposed) return;
      if (creating) {
        if (response.status !== 201 || !response.value || Object.keys(response.value).sort().join(",") !== "created,schemaVersion" || response.value.schemaVersion !== "1" || response.value.created !== true) throw new Error("Invalid setup receipt.");
        name.value = ""; show("sign-in");
        status.textContent = "Administrator account created. One-time setup is now closed. Sign in with your email and the password you just chose.";
        password.focus();
      } else if (!changingPassword && response.value?.twoFactorRedirect === true) {
        backupMode = false; show("challenge"); status.textContent = "Password accepted. Complete two-factor verification to sign in."; factorCode.focus();
      } else global.location.replace(changingPassword ? "/" + returnTo : signedInTarget());
    } catch (error) {
      clearPasswords();
      if (disposed) return;
      raced = creating && error.status === 409;
      status.textContent = error.status === 429 ? "Too many attempts. Wait a minute and try again."
        : creating ? "Account creation could not be confirmed. Check setup again before retrying; if the account exists, sign in with your chosen credentials."
          : changingPassword ? "Password could not be changed. Check your current password, new password length, and session."
            : "Sign-in failed. Check your connection, email and password.";
      if (creating) show("unavailable");
    } finally { busy = false; if (!disposed) { show(mode); if (raced) await checkSetup("Setup changed in another window. If your administrator account was created, sign in with its credentials."); } }
  });
  factorPasswordForm.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || disposed || mode !== "security") return;
    if (factorPassword.value.length < 15 || factorPassword.value.length > 128) { status.textContent = "Enter your current password of 15–128 characters."; return; }
    busy = true; show(mode); status.textContent = factorEnabled ? "Disabling two-factor authentication…" : "Preparing authenticator setup…";
    try {
      const { value } = await request("/api/auth/two-factor/" + (factorEnabled ? "disable" : "enable"), { password: factorPassword.value }, true);
      factorPassword.value = ""; if (disposed) return;
      if (factorEnabled) {
        if (value?.status !== true || value.reauthenticate !== true) throw new Error("Invalid security receipt.");
        clearFactorSecrets(); show("sign-in"); status.textContent = "Two-factor authentication is disabled. All sessions were signed out; sign in again.";
      } else {
        if (value?.method !== "totp" || typeof value.totpURI !== "string" || value.totpURI.length > 2048 || !value.totpURI.startsWith("otpauth://totp/") || !Array.isArray(value.backupCodes) || value.backupCodes.length !== 10 || !value.backupCodes.every(code => typeof code === "string" && /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(code))) throw new Error("Invalid enrollment response.");
        const key = new URLSearchParams(value.totpURI.split("?")[1]).get("secret");
        if (!key || !/^[A-Z2-7]+=*$/.test(key) || key.length > 128) throw new Error("Invalid authenticator key.");
        element("two-factor-key").value = key; element("two-factor-uri").value = value.totpURI;
        element("two-factor-backup-codes").value = value.backupCodes.join("\n");
        factorSaved.checked = false; backupMode = false; show("enroll"); status.textContent = "Setup prepared, but protection is not active yet.";
      }
    } catch (error) {
      factorPassword.value = ""; if (disposed) return;
      status.textContent = error.status === 429 ? "Too many attempts. Wait before trying again." : "Security change could not be confirmed. Check your current password and session; reload account security to verify its status.";
    } finally { busy = false; if (!disposed) show(mode); }
  });
  factorBackup.addEventListener("click", () => { if (busy || mode !== "challenge") return; backupMode = !backupMode; factorCode.value = ""; show(mode); factorCode.focus(); });
  factorCancel.addEventListener("click", () => {
    if (busy || disposed) return;
    const enrolling = mode === "enroll"; clearFactorSecrets(); backupMode = false;
    if (enrolling) void checkSecurity(); else { show("sign-in"); status.textContent = "Enter your email and password to start a new sign-in."; }
  });
  factorForm.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || disposed || factorForm.hidden) return;
    const enrolling = mode === "enroll", code = factorCode.value.trim();
    if (!(backupMode ? /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/ : /^\d{6}$/).test(code)) { status.textContent = backupMode ? "Enter one unused backup code, including its hyphen." : "Enter the current six-digit authenticator code."; return; }
    if (enrolling && !factorSaved.checked) { status.textContent = "Save your backup codes securely and confirm before activating two-factor authentication."; return; }
    busy = true; show(mode); status.textContent = "Verifying your code…";
    try {
      const { value } = await request("/api/auth/two-factor/" + (backupMode ? "verify-backup-code" : "verify-totp"), { code }, true);
      factorCode.value = ""; if (disposed) return;
      if (enrolling) {
        if (value?.status !== true || value.reauthenticate !== true) throw new Error("Invalid activation receipt.");
        clearFactorSecrets(); show("sign-in"); status.textContent = "Two-factor authentication is enabled. All sessions were signed out. Sign in with your password, then your authenticator code.";
      } else {
        if (!value?.user || typeof value.user.id !== "string") throw new Error("Invalid verification receipt.");
        clearFactorSecrets(); global.location.replace(signedInTarget());
      }
    } catch (error) {
      factorCode.value = ""; if (disposed) return;
      status.textContent = error.status === 429 ? "Too many attempts. Wait before trying again; an account lock can last 15 minutes." : "Code verification failed or could not be confirmed. Check the code and device clock. If sign-in expired, start again; if enrollment may have completed, reload account security.";
    } finally { busy = false; if (!disposed) show(mode); }
  });
  global.addEventListener("pagehide", () => { disposed = true; controller?.abort(); clearPasswords(); clearFactorSecrets(); });
  global.addEventListener("pageshow", event => { if (event.persisted) global.location.reload(); });
  if (changing) show("change"); else if (security) void checkSecurity(); else void checkSetup();
}(window));
