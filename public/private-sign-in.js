"use strict";

(function privateSignIn(global) {
  const form = document.getElementById("private-sign-in-form");
  const status = document.getElementById("sign-in-status");
  const button = document.getElementById("sign-in-submit");
  const email = document.getElementById("operator-email");
  const password = document.getElementById("operator-password");
  const nextPassword = document.getElementById("operator-new-password");
  const params = new URLSearchParams(global.location.search);
  const changing = params.get("mode") === "password";
  const requested = params.get("returnTo") || "#/";
  const returnTo = /^#\/[a-zA-Z0-9_/?=&%.:-]*$/.test(requested) && requested.length <= 512 ? requested : "#/";
  if (changing) {
    document.getElementById("sign-in-title").textContent = "Change your password";
    document.getElementById("sign-in-description").textContent = "Enter your current password and a new password. Other sessions will be revoked.";
    document.getElementById("email-label").hidden = true;
    email.required = false;
    document.getElementById("new-password-label").hidden = false;
    nextPassword.required = true;
    button.textContent = "Update password";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = changing ? "Updating password…" : "Signing in…";
    try {
      const response = await global.fetch(changing ? "/api/auth/change-password" : "/api/auth/sign-in/email", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify(changing
          ? { currentPassword: password.value, newPassword: nextPassword.value, revokeOtherSessions: true }
          : { email: email.value.trim(), password: password.value, rememberMe: false })
      });
      password.value = "";
      nextPassword.value = "";
      if (!response.ok) {
        status.textContent = response.status === 429 ? "Too many attempts. Wait a minute and try again."
          : changing ? "Password could not be changed. Check your current password, new password length, and session."
            : "Sign-in failed. Check your email and password.";
        return;
      }
      global.location.replace("/" + returnTo);
    } catch {
      password.value = ""; nextPassword.value = "";
      status.textContent = "The private application could not be reached. Check your connection and retry.";
    } finally { button.disabled = false; }
  });
}(window));
