"use strict";

// Browser-side authentication integration boundary. The host application owns
// the OIDC exchange, server-side session, authorization policy, and redirects.
// This module accepts only a minimal display projection and internal return path.
(function installAuthContract(global) {
  const VERSION = "1";
  const SENSITIVE_KEYS = new Set([
    "accesstoken", "refreshtoken", "idtoken", "token", "claims", "subject",
    "sub", "sessionid", "cookie", "credentials", "authorization", "secret",
    "password"
  ]);

  function isRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  function assertRecord(value, label) {
    if (!isRecord(value)) throw new TypeError(`${label} must be a plain object.`);
  }

  function assertAllowedKeys(value, allowed, label) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.includes(key)) {
        throw new TypeError(`${label} contains an unsupported key.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError(`${label} must use data properties.`);
      }
      if (SENSITIVE_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) {
        throw new TypeError(`${label} must not expose sensitive authentication material.`);
      }
    }
  }

  function requiredText(value, label, maximum) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
    }
    return value;
  }

  function identifier(value, label) {
    const candidate = requiredText(value, label, 80);
    if (!/^[a-z][a-z0-9-]*$/.test(candidate)) {
      throw new TypeError(`${label} must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`);
    }
    return candidate;
  }

  function validateReturnTo(value) {
    const candidate = requiredText(value, "returnTo", 512);
    if (!candidate.startsWith("#/") || candidate.includes("\\") || candidate.includes("\r") || candidate.includes("\n")) {
      throw new TypeError("returnTo must be an internal application hash route.");
    }
    if (candidate.slice(1).includes("#")) throw new TypeError("returnTo must contain one hash marker.");
    const question = candidate.indexOf("?");
    const pathname = (question < 0 ? candidate.slice(1) : candidate.slice(1, question));
    const query = question < 0 ? "" : candidate.slice(question + 1);
    if (pathname !== "/" && (pathname.includes("//") || pathname.endsWith("/"))) {
      throw new TypeError("returnTo must use canonical route separators.");
    }
    const segments = pathname === "/" ? [] : pathname.slice(1).split("/");
    if (segments.some((segment) => segment === "." || segment === ".." || !/^[a-z0-9_-]+$/i.test(segment))) {
      throw new TypeError("returnTo must be traversal-free.");
    }
    if (question >= 0 && !query) throw new TypeError("returnTo must not contain an empty query.");
    if (query) {
      const pairs = query.split("&");
      if (pairs.length > 20) throw new TypeError("returnTo may contain at most 20 query entries.");
      const seenKeys = new Set();
      for (const pair of pairs) {
        const separator = pair.indexOf("=");
        const rawKey = separator < 0 ? pair : pair.slice(0, separator);
        const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
        let key;
        let decodedValue;
        try {
          key = decodeURIComponent(rawKey.replace(/\+/g, " "));
          decodedValue = decodeURIComponent(rawValue.replace(/\+/g, " "));
        } catch {
          throw new TypeError("returnTo contains invalid query encoding.");
        }
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || decodedValue.length > 256 || seenKeys.has(key)) {
          throw new TypeError("returnTo contains an invalid query entry.");
        }
        seenKeys.add(key);
      }
    }
    return candidate;
  }

  function validateSession(value) {
    assertRecord(value, "session");
    assertAllowedKeys(value, ["authenticated", "display", "capabilities"], "session");
    if (typeof value.authenticated !== "boolean") throw new TypeError("session.authenticated must be a boolean.");
    if (!value.authenticated && (value.display !== undefined || value.capabilities !== undefined)) {
      throw new TypeError("An unauthenticated session must not expose identity or authorization data.");
    }
    const normalized = { authenticated: value.authenticated };
    if (value.display !== undefined) {
      assertRecord(value.display, "session.display");
      assertAllowedKeys(value.display, ["name", "initials"], "session.display");
      const name = requiredText(value.display.name, "session.display.name", 120);
      const initials = requiredText(value.display.initials, "session.display.initials", 4);
      if (!/^[\p{L}\p{N}]{1,4}$/u.test(initials)) throw new TypeError("session.display.initials must contain one to four letters or digits.");
      normalized.display = { name, initials };
    }
    if (value.capabilities !== undefined) {
      if (!Array.isArray(value.capabilities) || value.capabilities.length > 50) {
        throw new TypeError("session.capabilities must be an array of at most 50 strings.");
      }
      const seen = new Set();
      normalized.capabilities = value.capabilities.map((capability, index) => {
        const candidate = requiredText(capability, `session.capabilities[${index}]`, 100);
        if (!/^[a-z][a-z0-9:._-]*$/.test(candidate) || seen.has(candidate)) {
          throw new TypeError("session.capabilities must contain unique, normalized capability names.");
        }
        seen.add(candidate);
        return candidate;
      });
    }
    if (normalized.display) Object.freeze(normalized.display);
    if (normalized.capabilities) Object.freeze(normalized.capabilities);
    return Object.freeze(normalized);
  }

  function normalizeNavigationRequest(value) {
    assertRecord(value, "navigation request");
    assertAllowedKeys(value, ["returnTo"], "navigation request");
    return Object.freeze({ returnTo: validateReturnTo(value.returnTo) });
  }

  function validateProvider(value) {
    assertRecord(value, "auth provider");
    assertAllowedKeys(value, ["schemaVersion", "id", "getSession", "login", "logout"], "auth provider");
    if (value.schemaVersion !== VERSION) throw new TypeError(`auth provider.schemaVersion must be ${VERSION}.`);
    for (const method of ["getSession", "login", "logout"]) {
      if (typeof value[method] !== "function") throw new TypeError(`auth provider.${method} must be a function.`);
    }
    const source = value;
    const getSession = source.getSession.bind(source);
    const login = source.login.bind(source);
    const logout = source.logout.bind(source);
    return Object.freeze({
      schemaVersion: VERSION,
      id: identifier(source.id, "auth provider.id"),
      getSession() {
        return Promise.resolve().then(() => getSession()).then(validateSession);
      },
      login(request) {
        return Promise.resolve().then(() => login(normalizeNavigationRequest(request))).then(() => undefined);
      },
      logout(request) {
        return Promise.resolve().then(() => logout(normalizeNavigationRequest(request))).then(() => undefined);
      }
    });
  }

  function resolveProvider(globalName = "SOC_CONSOLE_AUTH") {
    if (typeof globalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
      throw new TypeError("Auth global name must be a JavaScript global identifier.");
    }
    const candidate = global[globalName];
    return candidate === undefined || candidate === null ? null : validateProvider(candidate);
  }

  global.SocConsoleAuthRuntime = Object.freeze({
    VERSION,
    validateReturnTo,
    validateSession,
    validateProvider,
    resolveProvider
  });
}(window));
