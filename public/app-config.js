"use strict";

// Public, non-sensitive runtime configuration. Deployments may define
// window.SOC_CONSOLE_PUBLIC_CONFIG before this script to replace presentation
// values. Configuration is read from memory only; this script performs no I/O.
(function configureSocConsole(global) {
  const VERSION = "1";
  const BLOCKED_KEY_SUFFIXES = [
    "secret",
    "password",
    "passwd",
    "token",
    "apikey",
    "privatekey",
    "credential",
    "authorization",
    "cookie",
    "sessionid"
  ];

  const defaults = {
    schemaVersion: VERSION,
    mode: "skeleton",
    brand: {
      name: "Bulwark Black SOC",
      product: "bulwark>soc",
      logoPath: "assets/mark.png"
    },
    adapter: {
      globalName: "SOC_CONSOLE_ADAPTER"
    },
    connectors: {
      globalName: "SOC_CONSOLE_CONNECTORS"
    },
    administration: {
      globalName: "SOC_CONSOLE_ADMINISTRATION"
    },
    auth: {
      globalName: "SOC_CONSOLE_AUTH",
      required: false
    },
    routing: {
      defaultRoute: "/"
    }
  };

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
    }
  }

  function assertNoSensitiveKeys(value, label, seen) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) throw new TypeError(`${label} must not contain cycles.`);
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${label} must use string keys.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must use data properties.`);
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (BLOCKED_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        throw new TypeError(`${label} must not contain sensitive configuration keys.`);
      }
      assertNoSensitiveKeys(value[key], `${label}.${key}`, seen);
    }
    seen.delete(value);
  }

  function requiredString(value, label, maximum) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
    }
    return value;
  }

  function localAssetPath(value, label) {
    const candidate = requiredString(value, label, 180);
    if (candidate.startsWith("/") || candidate.includes("\\") || candidate.includes("?") || candidate.includes("#")) {
      throw new TypeError(`${label} must be a relative local path without a query or fragment.`);
    }
    const parts = candidate.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
      throw new TypeError(`${label} must be traversal-free.`);
    }
    return candidate;
  }

  function route(value, label) {
    const candidate = requiredString(value, label, 180);
    if (!candidate.startsWith("/") || candidate.includes("\\") || candidate.includes("?") || candidate.includes("#")) {
      throw new TypeError(`${label} must be an absolute application route.`);
    }
    if (candidate !== "/" && (candidate.includes("//") || candidate.endsWith("/"))) {
      throw new TypeError(`${label} must use canonical route separators.`);
    }
    const parts = candidate === "/" ? [] : candidate.slice(1).split("/");
    if (parts.some((part) => part === "." || part === ".." || !/^[a-z0-9_-]+$/i.test(part))) {
      throw new TypeError(`${label} must be traversal-free.`);
    }
    return candidate;
  }

  function mergeAndValidate(input) {
    const override = input === undefined ? {} : input;
    assertRecord(override, "SOC_CONSOLE_PUBLIC_CONFIG");
    assertNoSensitiveKeys(override, "SOC_CONSOLE_PUBLIC_CONFIG", new Set());
    assertAllowedKeys(override, ["schemaVersion", "mode", "brand", "adapter", "connectors", "administration", "auth", "routing"], "SOC_CONSOLE_PUBLIC_CONFIG");

    const brand = override.brand === undefined ? {} : override.brand;
    const adapter = override.adapter === undefined ? {} : override.adapter;
    const connectors = override.connectors === undefined ? {} : override.connectors;
    const administration = override.administration === undefined ? {} : override.administration;
    const auth = override.auth === undefined ? {} : override.auth;
    const routing = override.routing === undefined ? {} : override.routing;
    assertRecord(brand, "SOC_CONSOLE_PUBLIC_CONFIG.brand");
    assertRecord(adapter, "SOC_CONSOLE_PUBLIC_CONFIG.adapter");
    assertRecord(connectors, "SOC_CONSOLE_PUBLIC_CONFIG.connectors");
    assertRecord(administration, "SOC_CONSOLE_PUBLIC_CONFIG.administration");
    assertRecord(auth, "SOC_CONSOLE_PUBLIC_CONFIG.auth");
    assertRecord(routing, "SOC_CONSOLE_PUBLIC_CONFIG.routing");
    assertAllowedKeys(brand, ["name", "product", "logoPath"], "SOC_CONSOLE_PUBLIC_CONFIG.brand");
    assertAllowedKeys(adapter, ["globalName"], "SOC_CONSOLE_PUBLIC_CONFIG.adapter");
    assertAllowedKeys(connectors, ["globalName"], "SOC_CONSOLE_PUBLIC_CONFIG.connectors");
    assertAllowedKeys(administration, ["globalName"], "SOC_CONSOLE_PUBLIC_CONFIG.administration");
    assertAllowedKeys(auth, ["globalName", "required"], "SOC_CONSOLE_PUBLIC_CONFIG.auth");
    assertAllowedKeys(routing, ["defaultRoute"], "SOC_CONSOLE_PUBLIC_CONFIG.routing");

    const schemaVersion = override.schemaVersion === undefined ? defaults.schemaVersion : override.schemaVersion;
    if (schemaVersion !== VERSION) throw new TypeError(`Unsupported configuration schema version: ${String(schemaVersion)}`);
    const mode = override.mode === undefined ? defaults.mode : override.mode;
    if (!["skeleton", "application"].includes(mode)) throw new TypeError("SOC_CONSOLE_PUBLIC_CONFIG.mode must be skeleton or application.");

    const globalName = adapter.globalName === undefined ? defaults.adapter.globalName : adapter.globalName;
    if (typeof globalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
      throw new TypeError("SOC_CONSOLE_PUBLIC_CONFIG.adapter.globalName must be a JavaScript global identifier.");
    }
    const authGlobalName = auth.globalName === undefined ? defaults.auth.globalName : auth.globalName;
    if (typeof authGlobalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(authGlobalName)) {
      throw new TypeError("SOC_CONSOLE_PUBLIC_CONFIG.auth.globalName must be a JavaScript global identifier.");
    }
    const connectorGlobalName = connectors.globalName === undefined ? defaults.connectors.globalName : connectors.globalName;
    if (typeof connectorGlobalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(connectorGlobalName)) {
      throw new TypeError("SOC_CONSOLE_PUBLIC_CONFIG.connectors.globalName must be a JavaScript global identifier.");
    }
    const administrationGlobalName = administration.globalName === undefined
      ? defaults.administration.globalName
      : administration.globalName;
    if (typeof administrationGlobalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(administrationGlobalName)) {
      throw new TypeError("SOC_CONSOLE_PUBLIC_CONFIG.administration.globalName must be a JavaScript global identifier.");
    }
    const authRequired = auth.required === undefined ? defaults.auth.required : auth.required;
    if (typeof authRequired !== "boolean") throw new TypeError("SOC_CONSOLE_PUBLIC_CONFIG.auth.required must be a boolean.");

    return {
      schemaVersion,
      mode,
      brand: {
        name: requiredString(brand.name === undefined ? defaults.brand.name : brand.name, "SOC_CONSOLE_PUBLIC_CONFIG.brand.name", 100),
        product: requiredString(brand.product === undefined ? defaults.brand.product : brand.product, "SOC_CONSOLE_PUBLIC_CONFIG.brand.product", 100),
        logoPath: localAssetPath(brand.logoPath === undefined ? defaults.brand.logoPath : brand.logoPath, "SOC_CONSOLE_PUBLIC_CONFIG.brand.logoPath")
      },
      adapter: { globalName },
      connectors: { globalName: connectorGlobalName },
      administration: { globalName: administrationGlobalName },
      auth: { globalName: authGlobalName, required: authRequired },
      routing: {
        defaultRoute: route(routing.defaultRoute === undefined ? defaults.routing.defaultRoute : routing.defaultRoute, "SOC_CONSOLE_PUBLIC_CONFIG.routing.defaultRoute")
      }
    };
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  global.SocConsoleConfig = deepFreeze(mergeAndValidate(global.SOC_CONSOLE_PUBLIC_CONFIG));
}(window));
