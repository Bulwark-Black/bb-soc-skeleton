"use strict";

// Dependency-free browser bridge for an adopter-owned Better Auth client.
// Load public/auth-contract.js first, then install the returned provider as
// window.SOC_CONSOLE_AUTH before loading public/bootstrap.js.
(function installBetterAuthBridge(global) {
  const PROVIDER_ID = "better-auth";

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function assertOptions(value) {
    if (!isRecord(value)) throw new TypeError("Better Auth bridge options must be an object.");
    const allowed = new Set(["authClient", "beginLogin", "callbackPath", "projectSession"]);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) {
        throw new TypeError("Better Auth bridge options contain an unsupported key.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError("Better Auth bridge options must use data properties.");
      }
    }
  }

  function assertMethod(value, name) {
    if (typeof value !== "function") throw new TypeError(`Better Auth ${name} must be a function.`);
  }

  function initialsFor(name) {
    const initials = name
      .trim()
      .split(/\s+/u)
      .map((part) => Array.from(part).find((character) => /[\p{L}\p{N}]/u.test(character)) || "")
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase();
    return Array.from(initials).slice(0, 4).join("");
  }

  function defaultProjection(sessionData) {
    if (!isRecord(sessionData) || !isRecord(sessionData.user)) {
      throw new TypeError("Better Auth returned an invalid authenticated session.");
    }
    const projection = { authenticated: true };
    const name = sessionData.user.name;
    if (typeof name === "string" && name.trim() && name.length <= 120) {
      const normalizedName = name.trim();
      const initials = initialsFor(normalizedName);
      if (initials) projection.display = { name: normalizedName, initials };
    }
    return projection;
  }

  function createProvider(options) {
    assertOptions(options);
    const authRuntime = global.SocConsoleAuthRuntime;
    if (!authRuntime || typeof authRuntime.validateProvider !== "function") {
      throw new TypeError("Load the SOC console authentication contract before the Better Auth bridge.");
    }

    const authClient = options.authClient;
    if (!isRecord(authClient)) throw new TypeError("A Better Auth client is required.");
    assertMethod(authClient.getSession, "client getSession");
    assertMethod(authClient.signOut, "client signOut");
    assertMethod(options.beginLogin, "beginLogin");
    if (options.projectSession !== undefined) assertMethod(options.projectSession, "projectSession");

    const getSession = authClient.getSession.bind(authClient);
    const signOut = authClient.signOut.bind(authClient);
    const beginLogin = options.beginLogin;
    const projectSession = options.projectSession || defaultProjection;
    const callbackPath = options.callbackPath === undefined ? "/" : options.callbackPath;

    function callbackURL(returnTo) {
      const internalRoute = authRuntime.validateReturnTo(returnTo);
      if (typeof callbackPath !== "string" || !callbackPath.startsWith("/") || callbackPath.startsWith("//")) {
        throw new TypeError("Better Auth callbackPath must be a same-origin absolute path.");
      }
      const callback = new URL(callbackPath, global.location.origin);
      if (callback.origin !== global.location.origin || callback.hash) {
        throw new TypeError("Better Auth callbackPath must be same-origin and must not contain a hash.");
      }
      callback.hash = internalRoute.slice(1);
      return callback.href;
    }

    return authRuntime.validateProvider({
      schemaVersion: "1",
      id: PROVIDER_ID,
      async getSession() {
        let response;
        try {
          response = await getSession();
        } catch {
          throw new Error("Authentication session is unavailable.");
        }
        if (!isRecord(response) || response.error) {
          throw new Error("Authentication session is unavailable.");
        }
        if (response.data === null || response.data === undefined) return { authenticated: false };
        const projection = await projectSession(response.data);
        return authRuntime.validateSession(projection);
      },
      async login({ returnTo }) {
        let response;
        try {
          response = await beginLogin(Object.freeze({
            callbackURL: callbackURL(returnTo),
            returnTo
          }));
        } catch {
          throw new Error("Authentication sign-in could not be started.");
        }
        if (isRecord(response) && response.error) {
          throw new Error("Authentication sign-in could not be started.");
        }
      },
      async logout({ returnTo }) {
        const destination = callbackURL(returnTo);
        let response;
        try {
          response = await signOut();
        } catch {
          throw new Error("Authentication sign-out failed.");
        }
        if (isRecord(response) && response.error) throw new Error("Authentication sign-out failed.");
        global.location.assign(destination);
      }
    });
  }

  global.SocConsoleBetterAuthBridge = Object.freeze({ createProvider });
}(window));
