"use strict";

// Versioned, data-only connector control boundary. This module validates data
// and wraps adopter-supplied methods; it performs no requests, persistence,
// uploads, secret resolution, enrollment, or connector execution itself.
(function installConnectorContract(root, factory) {
  const runtime = factory(root);
  if (root) root.SocConsoleConnectorRuntime = runtime;
  if (typeof module === "object" && module && module.exports) module.exports = runtime;
}(
  typeof window === "object" && window ? window :
    (typeof globalThis === "object" ? globalThis : null),
  function createConnectorContract(global) {
    const VERSION = "1";
    const DOCUMENT_TYPES = Object.freeze([
      "connector-manifest",
      "source-registration",
      "source-health-snapshot",
      "connector-command-request",
      "connector-command-result",
      "connector-control-snapshot"
    ]);
    const CONNECTOR_SCOPES = Object.freeze(["application", "host", "service"]);
    const RECORD_KINDS = Object.freeze([
      "alert.delivery",
      "asset.snapshot",
      "audit.event",
      "authentication.event",
      "backup.status",
      "case.record",
      "compliance.record",
      "database.schema",
      "endpoint.event",
      "evidence.receipt",
      "file.integrity",
      "finding",
      "governance.attestation",
      "governance.risk",
      "honeypot.event",
      "identity.access",
      "intel.indicator",
      "intel.sync",
      "log.event",
      "network.event",
      "offboarding.record",
      "phishing.report",
      "remediation.record",
      "retention.snapshot",
      "rule.definition",
      "scan.result",
      "software.package",
      "source.heartbeat",
      "vulnerability.finding"
    ]);
    const PAYLOAD_FIELD_MODES = Object.freeze(["required", "optional", "forbidden"]);
    const CONFIG_VALUE_TYPES = Object.freeze([
      "string", "integer", "number", "boolean", "duration-seconds", "endpoint-url", "enum"
    ]);
    const CREDENTIAL_KINDS = Object.freeze([
      "api-key", "bearer-token", "basic-auth", "certificate", "oauth-client",
      "service-account", "ssh-key", "custom"
    ]);
    const CREDENTIAL_STORES = Object.freeze(["environment", "host-managed", "secret-manager", "vault"]);
    const HEALTH_STATES = Object.freeze(["unknown", "pending", "healthy", "degraded", "stale", "offline", "error", "disabled"]);
    const HEALTH_REASONS = Object.freeze([
      "none", "awaiting-first-delivery", "late", "connector-error", "authentication-required",
      "configuration-invalid", "permission-denied", "rate-limited", "disabled"
    ]);
    const SOURCE_STATES = Object.freeze(["draft", "configured", "tested", "active", "disabled", "paused", "archived", "removed"]);
    const COMMANDS = Object.freeze([
      "app.register", "host.enroll", "source.setup", "source.test", "source.activate",
      "source.update", "source.pause", "source.resume", "source.archive", "source.remove", "source.revoke", "source.rotate"
    ]);
    const COMMAND_STATUSES = Object.freeze(["succeeded", "failed", "rejected", "conflict"]);
    const APP_STATES = Object.freeze(["registered", "disabled"]);
    const HOST_STATES = Object.freeze(["pending", "enrolled", "disabled"]);
    const CONNECTOR_INSTANCE_STATES = Object.freeze(["configured", "tested", "active", "disabled", "paused", "archived", "removed"]);
    const CHANGE_ACTIONS = Object.freeze([
      "app.registered", "app.disabled", "host.enrolled", "host.disabled",
      "connector-instance.configured", "connector-instance.tested", "connector-instance.activated", "connector-instance.disabled",
      "source.configured", "source.tested", "source.activated", "source.disabled",
      "source.updated", "source.paused", "source.resumed", "source.archived", "source.removed", "source.revoked", "source.rotated"
    ]);
    const CHANGE_STATUSES = Object.freeze(["succeeded", "failed", "rejected", "conflict"]);
    const ERROR_CODES = Object.freeze([
      "validation-failed", "not-authorized", "not-found", "already-exists",
      "revision-conflict", "credential-reference-unavailable", "connector-unavailable",
      "provider-unavailable", "test-failed", "activation-blocked", "internal-error"
    ]);
    const SNAPSHOT_REASONS = Object.freeze(["initial", "refresh", "command"]);
    const BLOCKED_CONFIG_SUFFIXES = Object.freeze([
      "secret", "password", "passwd", "token", "apikey", "privatekey", "credential",
      "credentials", "authorization", "cookie", "sessionid", "clientsecret", "accesskey"
    ]);
    const MARKUP_KEYS = new Set(["html", "innerhtml", "outerhtml", "srcdoc"]);

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
        if (MARKUP_KEYS.has(key.replace(/[^a-z]/gi, "").toLowerCase())) {
          throw new TypeError(`${label} must contain data, not markup.`);
        }
      }
    }

    function assertArray(value, label, minimum, maximum) {
      if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
        const range = minimum === 0 ? `at most ${maximum}` : `between ${minimum} and ${maximum}`;
        throw new TypeError(`${label} must be an array containing ${range} entries.`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError(`${label} must be a dense array of data values.`);
        }
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError(`${label} must not contain custom properties.`);
        }
      }
    }

    function deepFreeze(value) {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
      Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
      return Object.freeze(value);
    }

    function requiredText(value, label, maximum) {
      if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} must be non-empty text of at most ${maximum} characters without control characters.`);
      }
      return value;
    }

    function optionalText(value, label, maximum) {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} must be text of at most ${maximum} characters without control characters.`);
      }
      return value;
    }

    function enumValue(value, values, label) {
      if (!values.includes(value)) throw new TypeError(`${label} must be one of: ${values.join(", ")}.`);
      return value;
    }

    function booleanValue(value, label) {
      if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
      return value;
    }

    function unsignedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new TypeError(`${label} must be an integer between 0 and ${maximum}.`);
      }
      return value;
    }

    function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
      }
      return value;
    }

    function finiteNumber(value, label) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
      }
      return value;
    }

    function timestamp(value, label) {
      const match = typeof value === "string"
        ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
        : null;
      const year = match ? Number(match[1]) : NaN;
      const month = match ? Number(match[2]) : NaN;
      const day = match ? Number(match[3]) : NaN;
      const hour = match ? Number(match[4]) : NaN;
      const minute = match ? Number(match[5]) : NaN;
      const second = match ? Number(match[6]) : NaN;
      const offsetHour = match && match[7] !== undefined ? Number(match[7]) : 0;
      const offsetMinute = match && match[8] !== undefined ? Number(match[8]) : 0;
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
        || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
        || Number.isNaN(Date.parse(value))) {
        throw new TypeError(`${label} must be an RFC 3339 date-time.`);
      }
      return value;
    }

    function nullableTimestamp(value, label) {
      return value === null ? null : timestamp(value, label);
    }

    function identifier(value, label) {
      const candidate = requiredText(value, label, 80);
      if (!/^[a-z][a-z0-9-]*$/.test(candidate)) {
        throw new TypeError(`${label} must start with a lowercase letter and contain lowercase letters, digits, or hyphens.`);
      }
      return candidate;
    }

    function typeName(value, label) {
      const candidate = requiredText(value, label, 80);
      if (!/^[a-z][a-z0-9.-]*$/.test(candidate)) {
        throw new TypeError(`${label} must be a normalized lowercase type name.`);
      }
      return candidate;
    }

    function versionName(value, label) {
      const candidate = requiredText(value, label, 40);
      if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(candidate)) {
        throw new TypeError(`${label} must be a normalized version string.`);
      }
      return candidate;
    }

    function resourceId(value, label) {
      const candidate = requiredText(value, label, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)) {
        throw new TypeError(`${label} must be an opaque identifier without whitespace, path separators, or query syntax.`);
      }
      return candidate;
    }

    function credentialReferenceId(value, label) {
      const candidate = requiredText(value, label, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(candidate) || candidate.includes("..")) {
        throw new TypeError(`${label} must be an opaque credential reference, never a credential value or path.`);
      }
      return candidate;
    }

    function route(value, label) {
      const candidate = requiredText(value, label, 180);
      if (!candidate.startsWith("/") || candidate.includes("\\") || candidate.includes("?") || candidate.includes("#")) {
        throw new TypeError(`${label} must be an absolute application route without a query or fragment.`);
      }
      if (candidate !== "/" && (candidate.includes("//") || candidate.endsWith("/"))) {
        throw new TypeError(`${label} must use canonical route separators.`);
      }
      const segments = candidate === "/" ? [] : candidate.slice(1).split("/");
      if (segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9_-]+$/.test(segment))) {
        throw new TypeError(`${label} must be traversal-free.`);
      }
      return candidate;
    }

    function uniqueTextArray(value, label, minimum, maximum, validator) {
      assertArray(value, label, minimum, maximum);
      const seen = new Set();
      return value.map((entry, index) => {
        const normalized = validator(entry, `${label}[${index}]`);
        if (seen.has(normalized)) throw new TypeError(`${label} must contain unique values.`);
        seen.add(normalized);
        return normalized;
      });
    }

    function assertNonSecretConfigKey(value, label) {
      const key = identifier(value, label);
      const normalized = key.replace(/[^a-z0-9]/g, "");
      if (BLOCKED_CONFIG_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        throw new TypeError(`${label} names sensitive material; put it in credentialReferences instead.`);
      }
      return key;
    }

    function normalizeConfigValue(value, label) {
      if (typeof value === "string") return optionalText(value, label, 1000);
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return finiteNumber(value, label);
      if (Array.isArray(value)) {
        assertArray(value, label, 0, 32);
        return value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 200));
      }
      throw new TypeError(`${label} must be a non-secret string, finite number, boolean, or string array.`);
    }

    function normalizeConfig(value, label) {
      assertRecord(value, label);
      const keys = Reflect.ownKeys(value);
      if (keys.length > 40) throw new TypeError(`${label} may contain at most 40 entries.`);
      const result = {};
      for (const key of keys) {
        if (typeof key !== "string") throw new TypeError(`${label} must use string keys.`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must use data properties.`);
        const normalizedKey = assertNonSecretConfigKey(key, `${label} key`);
        result[normalizedKey] = normalizeConfigValue(value[key], `${label}.${normalizedKey}`);
      }
      return result;
    }

    function normalizeCredentialReferences(value, label) {
      assertArray(value, label, 0, 32);
      const seen = new Set();
      return value.map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        assertRecord(entry, itemLabel);
        assertAllowedKeys(entry, ["slot", "store", "referenceId"], itemLabel);
        const slot = identifier(entry.slot, `${itemLabel}.slot`);
        if (seen.has(slot)) throw new TypeError(`${label} must contain at most one reference per credential slot.`);
        seen.add(slot);
        return {
          slot,
          store: enumValue(entry.store, CREDENTIAL_STORES, `${itemLabel}.store`),
          referenceId: credentialReferenceId(entry.referenceId, `${itemLabel}.referenceId`)
        };
      });
    }

    function normalizeConfigField(field, label) {
      assertRecord(field, label);
      assertAllowedKeys(field, ["key", "label", "valueType", "required", "description", "options", "minimum", "maximum"], label);
      const valueType = enumValue(field.valueType, CONFIG_VALUE_TYPES, `${label}.valueType`);
      const result = {
        key: assertNonSecretConfigKey(field.key, `${label}.key`),
        label: requiredText(field.label, `${label}.label`, 120),
        valueType,
        required: booleanValue(field.required, `${label}.required`)
      };
      const description = optionalText(field.description, `${label}.description`, 500);
      if (description !== undefined) result.description = description;
      const numericType = ["integer", "number", "duration-seconds"].includes(valueType);
      if (!numericType && (field.minimum !== undefined || field.maximum !== undefined)) {
        throw new TypeError(`${label}.minimum and maximum are supported only for numeric value types.`);
      }
      if (numericType) {
        for (const key of ["minimum", "maximum"]) {
          if (field[key] === undefined) continue;
          const boundLabel = `${label}.${key}`;
          const bound = valueType === "number"
            ? finiteNumber(field[key], boundLabel)
            : Number.isSafeInteger(field[key]) ? field[key] : (() => { throw new TypeError(`${boundLabel} must be a safe integer.`); })();
          if (valueType === "duration-seconds" && (bound < 1 || bound > 31536000)) {
            throw new TypeError(`${boundLabel} must be between 1 and 31536000.`);
          }
          result[key] = bound;
        }
        if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) {
          throw new TypeError(`${label}.minimum must not exceed maximum.`);
        }
      }
      if (valueType === "enum") {
        assertArray(field.options, `${label}.options`, 1, 32);
        const seen = new Set();
        result.options = field.options.map((option, index) => {
          const optionLabel = `${label}.options[${index}]`;
          assertRecord(option, optionLabel);
          assertAllowedKeys(option, ["value", "label"], optionLabel);
          const optionValue = identifier(option.value, `${optionLabel}.value`);
          if (seen.has(optionValue)) throw new TypeError(`${label}.options must use unique values.`);
          seen.add(optionValue);
          return { value: optionValue, label: requiredText(option.label, `${optionLabel}.label`, 120) };
        });
      } else if (field.options !== undefined) {
        throw new TypeError(`${label}.options is supported only when valueType is enum.`);
      }
      return result;
    }

    function normalizeCredentialSlot(slot, label) {
      assertRecord(slot, label);
      assertAllowedKeys(slot, ["key", "label", "kind", "required", "description"], label);
      const result = {
        key: identifier(slot.key, `${label}.key`),
        label: requiredText(slot.label, `${label}.label`, 120),
        kind: enumValue(slot.kind, CREDENTIAL_KINDS, `${label}.kind`),
        required: booleanValue(slot.required, `${label}.required`)
      };
      const description = optionalText(slot.description, `${label}.description`, 500);
      if (description !== undefined) result.description = description;
      return result;
    }

    function validateConnectorManifest(value) {
      assertRecord(value, "connector manifest");
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "connectorType", "connectorVersion", "displayName",
        "description", "scope", "supportedSourceKinds", "payload", "targets", "configFields",
        "credentialSlots", "healthPolicy"
      ], "connector manifest");
      if (value.schemaVersion !== VERSION) throw new TypeError(`connector manifest.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "connector-manifest") throw new TypeError("connector manifest.documentType must be connector-manifest.");

      assertRecord(value.payload, "connector manifest.payload");
      assertAllowedKeys(value.payload, ["schemaId", "schemaVersion", "recordKinds", "lines", "content"], "connector manifest.payload");
      const recordKinds = uniqueTextArray(
        value.payload.recordKinds,
        "connector manifest.payload.recordKinds",
        1,
        RECORD_KINDS.length,
        (entry, label) => enumValue(entry, RECORD_KINDS, label)
      );
      const payload = {
        schemaId: typeName(value.payload.schemaId, "connector manifest.payload.schemaId"),
        schemaVersion: versionName(value.payload.schemaVersion, "connector manifest.payload.schemaVersion"),
        recordKinds,
        lines: enumValue(value.payload.lines, PAYLOAD_FIELD_MODES, "connector manifest.payload.lines"),
        content: enumValue(value.payload.content, PAYLOAD_FIELD_MODES, "connector manifest.payload.content")
      };

      assertArray(value.targets, "connector manifest.targets", 1, 64);
      const targetRoutes = new Set();
      const targets = value.targets.map((target, index) => {
        const label = `connector manifest.targets[${index}]`;
        assertRecord(target, label);
        assertAllowedKeys(target, ["route", "surfaces", "recordKinds"], label);
        const targetRoute = route(target.route, `${label}.route`);
        if (targetRoutes.has(targetRoute)) throw new TypeError("connector manifest.targets must use one entry per route.");
        targetRoutes.add(targetRoute);
        const targetKinds = uniqueTextArray(
          target.recordKinds,
          `${label}.recordKinds`,
          1,
          RECORD_KINDS.length,
          (entry, itemLabel) => enumValue(entry, RECORD_KINDS, itemLabel)
        );
        if (targetKinds.some((kind) => !recordKinds.includes(kind))) {
          throw new TypeError(`${label}.recordKinds must be declared by connector manifest.payload.recordKinds.`);
        }
        return {
          route: targetRoute,
          surfaces: uniqueTextArray(target.surfaces, `${label}.surfaces`, 1, 32, identifier),
          recordKinds: targetKinds
        };
      });

      assertArray(value.configFields, "connector manifest.configFields", 0, 40);
      const configKeys = new Set();
      const configFields = value.configFields.map((field, index) => {
        const normalized = normalizeConfigField(field, `connector manifest.configFields[${index}]`);
        if (configKeys.has(normalized.key)) throw new TypeError("connector manifest.configFields must use unique keys.");
        configKeys.add(normalized.key);
        return normalized;
      });

      assertArray(value.credentialSlots, "connector manifest.credentialSlots", 0, 32);
      const credentialKeys = new Set();
      const credentialSlots = value.credentialSlots.map((slot, index) => {
        const normalized = normalizeCredentialSlot(slot, `connector manifest.credentialSlots[${index}]`);
        if (credentialKeys.has(normalized.key)) throw new TypeError("connector manifest.credentialSlots must use unique keys.");
        credentialKeys.add(normalized.key);
        return normalized;
      });
      for (const key of configKeys) {
        if (credentialKeys.has(key)) throw new TypeError("Configuration fields and credential slots must use distinct keys.");
      }

      assertRecord(value.healthPolicy, "connector manifest.healthPolicy");
      assertAllowedKeys(value.healthPolicy, [
        "deliveryMode", "expectedIntervalSeconds", "staleAfterSeconds", "offlineAfterSeconds", "emptyPayloadIsHealthy"
      ], "connector manifest.healthPolicy");
      const expectedIntervalSeconds = positiveInteger(
        value.healthPolicy.expectedIntervalSeconds,
        "connector manifest.healthPolicy.expectedIntervalSeconds",
        31536000
      );
      const staleAfterSeconds = positiveInteger(
        value.healthPolicy.staleAfterSeconds,
        "connector manifest.healthPolicy.staleAfterSeconds",
        31536000
      );
      const offlineAfterSeconds = positiveInteger(
        value.healthPolicy.offlineAfterSeconds,
        "connector manifest.healthPolicy.offlineAfterSeconds",
        31536000
      );
      if (staleAfterSeconds < expectedIntervalSeconds || offlineAfterSeconds < staleAfterSeconds) {
        throw new TypeError("connector manifest.healthPolicy must satisfy expectedIntervalSeconds <= staleAfterSeconds <= offlineAfterSeconds.");
      }

      const result = {
        schemaVersion: VERSION,
        documentType: "connector-manifest",
        connectorType: typeName(value.connectorType, "connector manifest.connectorType"),
        connectorVersion: versionName(value.connectorVersion, "connector manifest.connectorVersion"),
        displayName: requiredText(value.displayName, "connector manifest.displayName", 120),
        scope: enumValue(value.scope, CONNECTOR_SCOPES, "connector manifest.scope"),
        supportedSourceKinds: uniqueTextArray(
          value.supportedSourceKinds,
          "connector manifest.supportedSourceKinds",
          1,
          32,
          typeName
        ),
        payload,
        targets,
        configFields,
        credentialSlots,
        healthPolicy: {
          deliveryMode: enumValue(value.healthPolicy.deliveryMode, ["push", "poll"], "connector manifest.healthPolicy.deliveryMode"),
          expectedIntervalSeconds,
          staleAfterSeconds,
          offlineAfterSeconds,
          emptyPayloadIsHealthy: booleanValue(value.healthPolicy.emptyPayloadIsHealthy, "connector manifest.healthPolicy.emptyPayloadIsHealthy")
        }
      };
      const description = optionalText(value.description, "connector manifest.description", 1000);
      if (description !== undefined) result.description = description;
      return deepFreeze(result);
    }

    function validateEndpoint(value, label) {
      if (typeof URL !== "function") throw new TypeError(`${label} cannot be validated in this runtime.`);
      let candidate;
      try {
        candidate = new URL(value);
      } catch {
        throw new TypeError(`${label} must be an absolute HTTP or HTTPS endpoint URL.`);
      }
      if (!["http:", "https:"].includes(candidate.protocol) || candidate.username || candidate.password || candidate.search || candidate.hash) {
        throw new TypeError(`${label} must be an HTTP or HTTPS endpoint without credentials, a query, or a fragment.`);
      }
      return value;
    }

    function validatePublicPage(value, label) {
      validateEndpoint(value, label);
      if (!value.startsWith("https://")) throw new TypeError(`${label} must use HTTPS.`);
      return value;
    }

    function validateConfigAgainstManifest(config, manifest, label) {
      const definitions = new Map(manifest.configFields.map((field) => [field.key, field]));
      for (const key of Object.keys(config)) {
        if (!definitions.has(key)) throw new TypeError(`${label}.${key} is not declared by connector manifest.configFields.`);
      }
      for (const field of manifest.configFields) {
        const present = Object.prototype.hasOwnProperty.call(config, field.key);
        if (field.required && !present) throw new TypeError(`${label}.${field.key} is required by the connector manifest.`);
        if (!present) continue;
        const fieldLabel = `${label}.${field.key}`;
        const value = config[field.key];
        if (field.valueType === "string" && typeof value !== "string") throw new TypeError(`${fieldLabel} must be a string.`);
        if (field.valueType === "integer" && !Number.isSafeInteger(value)) throw new TypeError(`${fieldLabel} must be a safe integer.`);
        if (field.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`${fieldLabel} must be a finite number.`);
        if (field.valueType === "boolean" && typeof value !== "boolean") throw new TypeError(`${fieldLabel} must be a boolean.`);
        if (field.valueType === "duration-seconds") positiveInteger(value, fieldLabel, 31536000);
        if (field.minimum !== undefined && value < field.minimum) throw new TypeError(`${fieldLabel} must be at least ${field.minimum}.`);
        if (field.maximum !== undefined && value > field.maximum) throw new TypeError(`${fieldLabel} must be at most ${field.maximum}.`);
        if (field.valueType === "endpoint-url") {
          if (typeof value !== "string") throw new TypeError(`${fieldLabel} must be a string.`);
          validateEndpoint(value, fieldLabel);
        }
        if (field.valueType === "enum") {
          if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
            throw new TypeError(`${fieldLabel} must be one of the connector manifest option values.`);
          }
        }
      }
    }

    function validateCredentialReferencesAgainstManifest(references, manifest, label) {
      const definitions = new Map(manifest.credentialSlots.map((slot) => [slot.key, slot]));
      for (const reference of references) {
        if (!definitions.has(reference.slot)) throw new TypeError(`${label} contains a slot not declared by the connector manifest.`);
      }
      const referenced = new Set(references.map((reference) => reference.slot));
      for (const slot of manifest.credentialSlots) {
        if (slot.required && !referenced.has(slot.key)) throw new TypeError(`${label} is missing required slot ${slot.key}.`);
      }
    }

    function normalizeSourceRegistration(value, manifestValue, label = "source registration") {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "sourceId", "connectorInstanceId", "appId", "connectorType", "sourceKind",
        "displayName", "hostId", "environment", "state", "config", "credentialReferences", "revision", "createdAt", "updatedAt", "health"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "source-registration") throw new TypeError(`${label}.documentType must be source-registration.`);
      const result = {
        schemaVersion: VERSION,
        documentType: "source-registration",
        sourceId: resourceId(value.sourceId, `${label}.sourceId`),
        connectorInstanceId: resourceId(value.connectorInstanceId, `${label}.connectorInstanceId`),
        appId: resourceId(value.appId, `${label}.appId`),
        connectorType: typeName(value.connectorType, `${label}.connectorType`),
        sourceKind: typeName(value.sourceKind, `${label}.sourceKind`),
        displayName: requiredText(value.displayName, `${label}.displayName`, 120),
        state: enumValue(value.state, SOURCE_STATES, `${label}.state`),
        config: normalizeConfig(value.config, `${label}.config`),
        credentialReferences: normalizeCredentialReferences(value.credentialReferences, `${label}.credentialReferences`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      if (result.sourceId === result.connectorInstanceId) {
        throw new TypeError(`${label}.sourceId and connectorInstanceId must identify different resources.`);
      }
      if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
        throw new TypeError(`${label}.updatedAt must not precede createdAt.`);
      }
      if (value.hostId !== undefined) result.hostId = resourceId(value.hostId, `${label}.hostId`);
      if (value.environment !== undefined) result.environment = typeName(value.environment, `${label}.environment`);
      if (value.health !== undefined) {
        result.health = normalizeSourceHealthSnapshot(value.health, `${label}.health`);
        if (result.health.sourceId !== result.sourceId || result.health.connectorInstanceId !== result.connectorInstanceId) {
          throw new TypeError(`${label}.health must identify the same source and connector instance.`);
        }
        if (result.health.revision !== result.revision) throw new TypeError(`${label}.health.revision must match ${label}.revision.`);
      }
      if (manifestValue !== undefined) {
        const manifest = validateConnectorManifest(manifestValue);
        if (result.connectorType !== manifest.connectorType) throw new TypeError(`${label}.connectorType does not match the connector manifest.`);
        if (!manifest.supportedSourceKinds.includes(result.sourceKind)) throw new TypeError(`${label}.sourceKind is not supported by the connector manifest.`);
        if (manifest.scope === "host" && result.hostId === undefined) throw new TypeError(`${label}.hostId is required for a host connector.`);
        validateConfigAgainstManifest(result.config, manifest, `${label}.config`);
        validateCredentialReferencesAgainstManifest(result.credentialReferences, manifest, `${label}.credentialReferences`);
      }
      return result;
    }

    function validateSourceRegistration(value, manifest) {
      return deepFreeze(normalizeSourceRegistration(value, manifest));
    }

    function normalizeSourceHealthSnapshot(value, label = "source health snapshot") {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "sourceId", "connectorInstanceId", "revision", "observedAt", "state",
        "reason", "lastAttemptAt", "lastSuccessAt", "nextExpectedAt", "counters", "message"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "source-health-snapshot") throw new TypeError(`${label}.documentType must be source-health-snapshot.`);
      assertRecord(value.counters, `${label}.counters`);
      assertAllowedKeys(value.counters, [
        "attempts", "successfulAttempts", "receivedRecords", "acceptedRecords", "rejectedRecords"
      ], `${label}.counters`);
      const counters = {
        attempts: unsignedInteger(value.counters.attempts, `${label}.counters.attempts`),
        successfulAttempts: unsignedInteger(value.counters.successfulAttempts, `${label}.counters.successfulAttempts`),
        receivedRecords: unsignedInteger(value.counters.receivedRecords, `${label}.counters.receivedRecords`),
        acceptedRecords: unsignedInteger(value.counters.acceptedRecords, `${label}.counters.acceptedRecords`),
        rejectedRecords: unsignedInteger(value.counters.rejectedRecords, `${label}.counters.rejectedRecords`)
      };
      if (counters.successfulAttempts > counters.attempts) throw new TypeError(`${label}.counters.successfulAttempts must not exceed attempts.`);
      if (counters.acceptedRecords + counters.rejectedRecords > counters.receivedRecords) {
        throw new TypeError(`${label}.counters acceptedRecords plus rejectedRecords must not exceed receivedRecords.`);
      }
      const observedAt = timestamp(value.observedAt, `${label}.observedAt`);
      const result = {
        schemaVersion: VERSION,
        documentType: "source-health-snapshot",
        sourceId: resourceId(value.sourceId, `${label}.sourceId`),
        connectorInstanceId: resourceId(value.connectorInstanceId, `${label}.connectorInstanceId`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        observedAt,
        state: enumValue(value.state, HEALTH_STATES, `${label}.state`),
        reason: enumValue(value.reason, HEALTH_REASONS, `${label}.reason`),
        lastAttemptAt: nullableTimestamp(value.lastAttemptAt, `${label}.lastAttemptAt`),
        lastSuccessAt: nullableTimestamp(value.lastSuccessAt, `${label}.lastSuccessAt`),
        nextExpectedAt: nullableTimestamp(value.nextExpectedAt, `${label}.nextExpectedAt`),
        counters
      };
      for (const key of ["lastAttemptAt", "lastSuccessAt"]) {
        if (result[key] !== null && Date.parse(result[key]) > Date.parse(observedAt)) {
          throw new TypeError(`${label}.${key} must not be later than observedAt.`);
        }
      }
      if (result.lastSuccessAt !== null && result.lastAttemptAt !== null
        && Date.parse(result.lastSuccessAt) > Date.parse(result.lastAttemptAt)) {
        throw new TypeError(`${label}.lastSuccessAt must not be later than lastAttemptAt.`);
      }
      if (result.state === "disabled" && result.reason !== "disabled") throw new TypeError(`${label}.reason must be disabled when state is disabled.`);
      if (result.state === "healthy" && result.reason !== "none") throw new TypeError(`${label}.reason must be none when state is healthy.`);
      const message = optionalText(value.message, `${label}.message`, 500);
      if (message !== undefined) result.message = message;
      return result;
    }

    function validateSourceHealthSnapshot(value) {
      return deepFreeze(normalizeSourceHealthSnapshot(value));
    }

    function normalizeCommandBase(value, label) {
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "connector-command-request") throw new TypeError(`${label}.documentType must be connector-command-request.`);
      return {
        schemaVersion: VERSION,
        documentType: "connector-command-request",
        requestId: resourceId(value.requestId, `${label}.requestId`),
        command: enumValue(value.command, COMMANDS, `${label}.command`),
        requestedAt: timestamp(value.requestedAt, `${label}.requestedAt`)
      };
    }

    function validateCommandRequest(value, manifestValue) {
      const label = "connector command request";
      assertRecord(value, label);
      assertAllowedKeys(value, ["schemaVersion", "documentType", "requestId", "command", "requestedAt", "input"], label);
      const result = normalizeCommandBase(value, label);
      const inputLabel = `${label}.input`;
      let manifest;
      if (manifestValue !== undefined) manifest = validateConnectorManifest(manifestValue);

      if (result.command === "app.register") {
        assertRecord(value.input, inputLabel);
        assertAllowedKeys(value.input, ["displayName", "hosts", "publicPages", "environments"], inputLabel);
        const hosts = uniqueTextArray(value.input.hosts === undefined ? [] : value.input.hosts, `${inputLabel}.hosts`, 0, 64, resourceId);
        assertArray(value.input.publicPages, `${inputLabel}.publicPages`, 0, 64);
        const publicPages = [];
        const seenPages = new Set();
        value.input.publicPages.forEach((entry, index) => {
          const page = validatePublicPage(requiredText(entry, `${inputLabel}.publicPages[${index}]`, 500), `${inputLabel}.publicPages[${index}]`);
          if (seenPages.has(page)) throw new TypeError(`${inputLabel}.publicPages must contain unique values.`);
          seenPages.add(page);
          publicPages.push(page);
        });
        result.input = {
          displayName: requiredText(value.input.displayName, `${inputLabel}.displayName`, 120),
          hosts,
          publicPages
        };
        if (value.input.environments !== undefined) result.input.environments = uniqueTextArray(value.input.environments, `${inputLabel}.environments`, 1, 32, typeName);
      } else if (result.command === "host.enroll") {
        assertRecord(value.input, inputLabel);
        assertAllowedKeys(value.input, ["appId", "hostId"], inputLabel);
        result.input = {
          appId: resourceId(value.input.appId, `${inputLabel}.appId`),
          hostId: resourceId(value.input.hostId, `${inputLabel}.hostId`)
        };
      } else if (result.command === "source.setup") {
        assertRecord(value.input, inputLabel);
        assertAllowedKeys(value.input, [
          "appId", "hostId", "environment", "connectorType", "sourceKind", "displayName", "config", "credentialReferences"
        ], inputLabel);
        result.input = {
          appId: resourceId(value.input.appId, `${inputLabel}.appId`),
          connectorType: typeName(value.input.connectorType, `${inputLabel}.connectorType`),
          sourceKind: typeName(value.input.sourceKind, `${inputLabel}.sourceKind`),
          displayName: requiredText(value.input.displayName, `${inputLabel}.displayName`, 120),
          config: normalizeConfig(value.input.config, `${inputLabel}.config`),
          credentialReferences: normalizeCredentialReferences(value.input.credentialReferences, `${inputLabel}.credentialReferences`)
        };
        if (value.input.hostId !== undefined) result.input.hostId = resourceId(value.input.hostId, `${inputLabel}.hostId`);
        if (value.input.environment !== undefined) result.input.environment = typeName(value.input.environment, `${inputLabel}.environment`);
        if (manifest && !manifest.supportedSourceKinds.includes(result.input.sourceKind)) {
          throw new TypeError(`${inputLabel}.sourceKind is not supported by the connector manifest.`);
        }
        if (manifest && manifest.scope === "host" && result.input.hostId === undefined) {
          throw new TypeError(`${inputLabel}.hostId is required for a host connector.`);
        }
      } else {
        assertRecord(value.input, inputLabel);
        const extraKeys = result.command === "source.test" ? ["sample"] : result.command === "source.update" ? ["displayName", "config", "credentialReferences"] : [];
        assertAllowedKeys(value.input, ["sourceId", "connectorInstanceId", "expectedRevision", ...extraKeys], inputLabel);
        result.input = {
          sourceId: resourceId(value.input.sourceId, `${inputLabel}.sourceId`),
          connectorInstanceId: resourceId(value.input.connectorInstanceId, `${inputLabel}.connectorInstanceId`),
          expectedRevision: unsignedInteger(value.input.expectedRevision, `${inputLabel}.expectedRevision`)
        };
        if (result.input.sourceId === result.input.connectorInstanceId) throw new TypeError(`${inputLabel}.sourceId and connectorInstanceId must identify different resources.`);
        if (result.command === "source.test" && value.input.sample !== undefined) {
          assertRecord(value.input.sample, `${inputLabel}.sample`);
          assertAllowedKeys(value.input.sample, ["message", "channel", "severity"], `${inputLabel}.sample`);
          result.input.sample = { message: requiredText(value.input.sample.message, `${inputLabel}.sample.message`, 2000) };
          if (value.input.sample.channel !== undefined) result.input.sample.channel = requiredText(value.input.sample.channel, `${inputLabel}.sample.channel`, 120);
          if (value.input.sample.severity !== undefined) result.input.sample.severity = enumValue(value.input.sample.severity, ["critical", "high", "medium", "low", "info", "unknown"], `${inputLabel}.sample.severity`);
        }
        if (result.command === "source.update") {
          if (value.input.displayName !== undefined) result.input.displayName = requiredText(value.input.displayName, `${inputLabel}.displayName`, 120);
          if (value.input.config !== undefined) result.input.config = normalizeConfig(value.input.config, `${inputLabel}.config`);
          if (value.input.credentialReferences !== undefined) result.input.credentialReferences = normalizeCredentialReferences(value.input.credentialReferences, `${inputLabel}.credentialReferences`);
          if (!extraKeys.some((key) => value.input[key] !== undefined)) throw new TypeError(`${inputLabel} must include a source change.`);
        }
      }
      if (manifest && result.command === "source.setup") {
        if (result.input.connectorType !== manifest.connectorType) throw new TypeError(`${inputLabel}.connectorType does not match the connector manifest.`);
        validateConfigAgainstManifest(result.input.config, manifest, `${inputLabel}.config`);
        validateCredentialReferencesAgainstManifest(result.input.credentialReferences, manifest, `${inputLabel}.credentialReferences`);
      }
      return deepFreeze(result);
    }

    function normalizeCommandError(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, ["code", "message", "field", "retryable"], label);
      const result = {
        code: enumValue(value.code, ERROR_CODES, `${label}.code`),
        message: requiredText(value.message, `${label}.message`, 500),
        retryable: booleanValue(value.retryable, `${label}.retryable`)
      };
      if (value.field !== undefined) {
        const field = requiredText(value.field, `${label}.field`, 160);
        if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(field)) throw new TypeError(`${label}.field must be a normalized field path.`);
        result.field = field;
      }
      return result;
    }

    function normalizeOneTimeCredential(value, label, expectedPurpose) {
      assertRecord(value, label);
      assertAllowedKeys(value, ["value", "expiresAt", "purpose"], label);
      if (value.purpose !== expectedPurpose) throw new TypeError(`${label}.purpose must be ${expectedPurpose}.`);
      return {
        value: requiredText(value.value, `${label}.value`, 512),
        expiresAt: timestamp(value.expiresAt, `${label}.expiresAt`),
        purpose: expectedPurpose
      };
    }

    function normalizeCommandOutput(command, value, label) {
      assertRecord(value, label);
      if (command === "app.register") {
        assertAllowedKeys(value, ["appId", "state"], label);
        if (value.state !== "registered") throw new TypeError(`${label}.state must be registered.`);
        return { appId: resourceId(value.appId, `${label}.appId`), state: "registered" };
      }
      if (command === "host.enroll") {
        assertAllowedKeys(value, ["appId", "hostId", "state", "oneTimeCredential"], label);
        if (value.state !== "enrolled") throw new TypeError(`${label}.state must be enrolled.`);
        const result = {
          appId: resourceId(value.appId, `${label}.appId`),
          hostId: resourceId(value.hostId, `${label}.hostId`),
          state: "enrolled"
        };
        if (value.oneTimeCredential !== undefined) {
          result.oneTimeCredential = normalizeOneTimeCredential(
            value.oneTimeCredential,
            `${label}.oneTimeCredential`,
            "connection-check"
          );
        }
        return result;
      }
      const states = {
        "source.setup": "configured",
        "source.test": "tested",
        "source.activate": "active", "source.update": "configured", "source.pause": "paused",
        "source.resume": "active", "source.archive": "archived", "source.remove": "removed",
        "source.revoke": "paused", "source.rotate": "active"
      };
      const allowed = command === "source.setup"
        ? ["appId", "sourceId", "connectorInstanceId", "revision", "state"]
        : ["source.activate", "source.rotate"].includes(command)
          ? ["sourceId", "connectorInstanceId", "revision", "state", "oneTimeCredential"]
          : ["sourceId", "connectorInstanceId", "revision", "state"];
      assertAllowedKeys(value, allowed, label);
      if (value.state !== states[command]) throw new TypeError(`${label}.state must be ${states[command]}.`);
      const result = {
        sourceId: resourceId(value.sourceId, `${label}.sourceId`),
        connectorInstanceId: resourceId(value.connectorInstanceId, `${label}.connectorInstanceId`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        state: states[command]
      };
      if (command === "source.setup") result.appId = resourceId(value.appId, `${label}.appId`);
      if (["source.activate", "source.rotate"].includes(command) && value.oneTimeCredential !== undefined) {
        result.oneTimeCredential = normalizeOneTimeCredential(
          value.oneTimeCredential,
          `${label}.oneTimeCredential`,
          "source-ingest"
        );
      }
      if (result.sourceId === result.connectorInstanceId) throw new TypeError(`${label}.sourceId and connectorInstanceId must identify different resources.`);
      return result;
    }

    function validateCommandResult(value, requestValue) {
      const label = "connector command result";
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "requestId", "command", "status", "completedAt", "output", "error"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "connector-command-result") throw new TypeError(`${label}.documentType must be connector-command-result.`);
      const status = enumValue(value.status, COMMAND_STATUSES, `${label}.status`);
      const result = {
        schemaVersion: VERSION,
        documentType: "connector-command-result",
        requestId: resourceId(value.requestId, `${label}.requestId`),
        command: enumValue(value.command, COMMANDS, `${label}.command`),
        status,
        completedAt: timestamp(value.completedAt, `${label}.completedAt`)
      };
      if (status === "succeeded") {
        if (value.error !== undefined) throw new TypeError(`${label}.error must be absent when status is succeeded.`);
        result.output = normalizeCommandOutput(result.command, value.output, `${label}.output`);
      } else {
        if (value.output !== undefined) throw new TypeError(`${label}.output must be absent unless status is succeeded.`);
        result.error = normalizeCommandError(value.error, `${label}.error`);
      }
      if (requestValue !== undefined) {
        const request = validateCommandRequest(requestValue);
        if (result.requestId !== request.requestId || result.command !== request.command) {
          throw new TypeError(`${label} must match the requestId and command of its request.`);
        }
        if (Date.parse(result.completedAt) < Date.parse(request.requestedAt)) {
          throw new TypeError(`${label}.completedAt must not precede the request timestamp.`);
        }
        if (result.output) {
          if (result.output.oneTimeCredential
            && Date.parse(result.output.oneTimeCredential.expiresAt) <= Date.parse(result.completedAt)) {
            throw new TypeError(`${label}.output.oneTimeCredential.expiresAt must be later than completedAt.`);
          }
          for (const key of ["appId", "hostId", "sourceId", "connectorInstanceId"]) {
            if (request.input[key] !== undefined && result.output[key] !== undefined
              && request.input[key] !== result.output[key]) {
              throw new TypeError(`${label}.output.${key} must match its request.`);
            }
          }
        }
      }
      return deepFreeze(result);
    }

    function normalizeAppRegistration(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "appId", "displayName", "hosts", "publicPages", "environments", "state", "revision", "createdAt", "updatedAt"
      ], label);
      const hosts = uniqueTextArray(value.hosts, `${label}.hosts`, 0, 64, resourceId);
      assertArray(value.publicPages, `${label}.publicPages`, 0, 64);
      const publicPages = [];
      const seenPages = new Set();
      value.publicPages.forEach((entry, index) => {
        const page = validatePublicPage(requiredText(entry, `${label}.publicPages[${index}]`, 500), `${label}.publicPages[${index}]`);
        if (seenPages.has(page)) throw new TypeError(`${label}.publicPages must contain unique values.`);
        seenPages.add(page);
        publicPages.push(page);
      });
      const result = {
        appId: resourceId(value.appId, `${label}.appId`),
        displayName: requiredText(value.displayName, `${label}.displayName`, 120),
        state: enumValue(value.state, APP_STATES, `${label}.state`),
        hosts,
        publicPages,
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) throw new TypeError(`${label}.updatedAt must not precede createdAt.`);
      if (value.environments !== undefined) result.environments = uniqueTextArray(value.environments, `${label}.environments`, 1, 32, typeName);
      return result;
    }

    function normalizeHostEnrollment(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "hostId", "appId", "displayName", "state", "connectionState", "lastProvenAt",
        "revision", "createdAt", "updatedAt"
      ], label);
      const result = {
        hostId: resourceId(value.hostId, `${label}.hostId`),
        appId: resourceId(value.appId, `${label}.appId`),
        displayName: requiredText(value.displayName, `${label}.displayName`, 120),
        state: enumValue(value.state, HOST_STATES, `${label}.state`),
        connectionState: enumValue(value.connectionState, ["unknown", "pending", "proven", "stale", "offline", "disabled"], `${label}.connectionState`),
        lastProvenAt: nullableTimestamp(value.lastProvenAt, `${label}.lastProvenAt`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) throw new TypeError(`${label}.updatedAt must not precede createdAt.`);
      if (result.lastProvenAt !== null && Date.parse(result.lastProvenAt) > Date.parse(result.updatedAt)) {
        throw new TypeError(`${label}.lastProvenAt must not be later than updatedAt.`);
      }
      return result;
    }

    function normalizeConnectorInstance(value, manifest, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "connectorInstanceId", "appId", "connectorType", "displayName", "state", "config",
        "credentialReferences", "revision", "createdAt", "updatedAt"
      ], label);
      const result = {
        connectorInstanceId: resourceId(value.connectorInstanceId, `${label}.connectorInstanceId`),
        appId: resourceId(value.appId, `${label}.appId`),
        connectorType: typeName(value.connectorType, `${label}.connectorType`),
        displayName: requiredText(value.displayName, `${label}.displayName`, 120),
        state: enumValue(value.state, CONNECTOR_INSTANCE_STATES, `${label}.state`),
        config: normalizeConfig(value.config, `${label}.config`),
        credentialReferences: normalizeCredentialReferences(value.credentialReferences, `${label}.credentialReferences`),
        revision: unsignedInteger(value.revision, `${label}.revision`),
        createdAt: timestamp(value.createdAt, `${label}.createdAt`),
        updatedAt: timestamp(value.updatedAt, `${label}.updatedAt`)
      };
      if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) throw new TypeError(`${label}.updatedAt must not precede createdAt.`);
      if (manifest) {
        if (result.connectorType !== manifest.connectorType) throw new TypeError(`${label}.connectorType does not match its manifest.`);
        validateConfigAgainstManifest(result.config, manifest, `${label}.config`);
        validateCredentialReferencesAgainstManifest(result.credentialReferences, manifest, `${label}.credentialReferences`);
      }
      return result;
    }

    function normalizeChange(value, label) {
      assertRecord(value, label);
      assertAllowedKeys(value, ["changeId", "resourceType", "resourceId", "action", "status", "at", "message"], label);
      const result = {
        changeId: resourceId(value.changeId, `${label}.changeId`),
        resourceType: enumValue(value.resourceType, ["app", "host", "connector-instance", "source"], `${label}.resourceType`),
        resourceId: resourceId(value.resourceId, `${label}.resourceId`),
        action: enumValue(value.action, CHANGE_ACTIONS, `${label}.action`),
        status: enumValue(value.status, CHANGE_STATUSES, `${label}.status`),
        at: timestamp(value.at, `${label}.at`)
      };
      if (!value.action.startsWith(`${result.resourceType}.`)) throw new TypeError(`${label}.action must match resourceType.`);
      const message = optionalText(value.message, `${label}.message`, 500);
      if (message !== undefined) result.message = message;
      return result;
    }

    function validateControlSnapshot(value) {
      const label = "connector control snapshot";
      assertRecord(value, label);
      assertAllowedKeys(value, [
        "schemaVersion", "documentType", "connectorTypes", "apps", "hosts", "connectorInstances",
        "setups", "sources", "changes", "revision"
      ], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (value.documentType !== "connector-control-snapshot") throw new TypeError(`${label}.documentType must be connector-control-snapshot.`);
      assertArray(value.connectorTypes, `${label}.connectorTypes`, 0, 100);
      const connectorTypes = value.connectorTypes.map(validateConnectorManifest);
      const manifestMap = new Map();
      connectorTypes.forEach((manifest) => {
        if (manifestMap.has(manifest.connectorType)) throw new TypeError(`${label}.connectorTypes must use unique connectorType values.`);
        manifestMap.set(manifest.connectorType, manifest);
      });

      assertArray(value.apps, `${label}.apps`, 0, 500);
      assertArray(value.hosts, `${label}.hosts`, 0, 500);
      assertArray(value.connectorInstances, `${label}.connectorInstances`, 0, 1000);
      assertArray(value.setups, `${label}.setups`, 0, 1000);
      assertArray(value.sources, `${label}.sources`, 0, 1000);
      assertArray(value.changes, `${label}.changes`, 0, 200);
      const appMap = new Map();
      const apps = value.apps.map((entry, index) => {
        const normalized = normalizeAppRegistration(entry, `${label}.apps[${index}]`);
        if (appMap.has(normalized.appId)) throw new TypeError(`${label}.apps must use unique appId values.`);
        appMap.set(normalized.appId, normalized);
        return normalized;
      });
      const hostMap = new Map();
      const hosts = value.hosts.map((entry, index) => {
        const normalized = normalizeHostEnrollment(entry, `${label}.hosts[${index}]`);
        const app = appMap.get(normalized.appId);
        if (!app) throw new TypeError(`${label}.hosts[${index}] references an unknown appId.`);
        if (!app.hosts.includes(normalized.hostId)) throw new TypeError(`${label}.hosts[${index}].hostId is not declared by its app.`);
        if (hostMap.has(normalized.hostId)) throw new TypeError(`${label}.hosts must use unique hostId values.`);
        hostMap.set(normalized.hostId, normalized);
        return normalized;
      });
      apps.forEach((app, appIndex) => {
        app.hosts.forEach((hostId) => {
          const host = hostMap.get(hostId);
          if (!host || host.appId !== app.appId) throw new TypeError(`${label}.apps[${appIndex}].hosts references an absent or differently owned host.`);
        });
      });
      const instanceMap = new Map();
      const connectorInstances = value.connectorInstances.map((entry, index) => {
        const entryLabel = `${label}.connectorInstances[${index}]`;
        const manifest = manifestMap.get(entry && entry.connectorType);
        if (!manifest) throw new TypeError(`${entryLabel} references an unknown connectorType.`);
        const normalized = normalizeConnectorInstance(entry, manifest, entryLabel);
        if (!appMap.has(normalized.appId)) throw new TypeError(`${entryLabel} references an unknown appId.`);
        if (instanceMap.has(normalized.connectorInstanceId)) throw new TypeError(`${label}.connectorInstances must use unique connectorInstanceId values.`);
        instanceMap.set(normalized.connectorInstanceId, normalized);
        return normalized;
      });

      const sourceIds = new Set();
      function normalizeSourceList(list, listLabel, allowedStates) {
        return list.map((entry, index) => {
          const entryLabel = `${listLabel}[${index}]`;
          const manifest = manifestMap.get(entry && entry.connectorType);
          if (!manifest) throw new TypeError(`${entryLabel} references an unknown connectorType.`);
          const normalized = normalizeSourceRegistration(entry, manifest, entryLabel);
          const instance = instanceMap.get(normalized.connectorInstanceId);
          if (!instance) throw new TypeError(`${entryLabel} references an unknown connectorInstanceId.`);
          if (normalized.appId !== instance.appId) throw new TypeError(`${entryLabel}.appId must match its connector instance.`);
          if (normalized.connectorType !== instance.connectorType) throw new TypeError(`${entryLabel}.connectorType must match its connector instance.`);
          if (normalized.hostId !== undefined) {
            const host = hostMap.get(normalized.hostId);
            if (!host || host.appId !== normalized.appId) throw new TypeError(`${entryLabel}.hostId must reference a host owned by its app.`);
          }
          if (normalized.environment !== undefined && !(appMap.get(normalized.appId).environments || ["default"]).includes(normalized.environment)) {
            throw new TypeError(`${entryLabel}.environment must be declared by its application.`);
          }
          if (!allowedStates.includes(normalized.state)) throw new TypeError(`${entryLabel}.state is not valid in this snapshot collection.`);
          if (sourceIds.has(normalized.sourceId)) throw new TypeError(`${label} must use unique sourceId values across setups and sources.`);
          sourceIds.add(normalized.sourceId);
          return normalized;
        });
      }
      const setups = normalizeSourceList(value.setups, `${label}.setups`, ["draft", "configured", "tested"]);
      const sources = normalizeSourceList(value.sources, `${label}.sources`, ["active", "disabled", "paused", "archived"]);
      const changeIds = new Set();
      const changes = value.changes.map((entry, index) => {
        const normalized = normalizeChange(entry, `${label}.changes[${index}]`);
        if (changeIds.has(normalized.changeId)) throw new TypeError(`${label}.changes must use unique changeId values.`);
        changeIds.add(normalized.changeId);
        return normalized;
      });
      return deepFreeze({
        schemaVersion: VERSION,
        documentType: "connector-control-snapshot",
        connectorTypes,
        apps,
        hosts,
        connectorInstances,
        setups,
        sources,
        changes,
        revision: unsignedInteger(value.revision, `${label}.revision`)
      });
    }

    function validateControlRequest(value) {
      const label = "connector control request";
      assertRecord(value, label);
      assertAllowedKeys(value, ["schemaVersion", "reason", "knownRevision"], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      const result = {
        schemaVersion: VERSION,
        reason: enumValue(value.reason, SNAPSHOT_REASONS, `${label}.reason`)
      };
      if (value.knownRevision !== undefined) result.knownRevision = unsignedInteger(value.knownRevision, `${label}.knownRevision`);
      return deepFreeze(result);
    }

    function validateProvider(value) {
      const label = "connector provider";
      assertRecord(value, label);
      assertAllowedKeys(value, ["schemaVersion", "id", "getSnapshot", "execute", "dispose"], label);
      if (value.schemaVersion !== VERSION) throw new TypeError(`${label}.schemaVersion must be ${VERSION}.`);
      if (typeof value.getSnapshot !== "function") throw new TypeError(`${label}.getSnapshot must be a function.`);
      if (typeof value.execute !== "function") throw new TypeError(`${label}.execute must be a function.`);
      if (value.dispose !== undefined && typeof value.dispose !== "function") throw new TypeError(`${label}.dispose must be a function when supplied.`);
      const source = value;
      const getSnapshot = source.getSnapshot.bind(source);
      const execute = source.execute.bind(source);
      const dispose = source.dispose === undefined ? null : source.dispose.bind(source);
      const result = {
        schemaVersion: VERSION,
        id: identifier(source.id, `${label}.id`),
        getSnapshot(request) {
          const normalized = validateControlRequest(request);
          return Promise.resolve().then(() => getSnapshot(normalized)).then(validateControlSnapshot);
        },
        execute(request) {
          const normalized = validateCommandRequest(request);
          return Promise.resolve().then(() => execute(normalized)).then((response) => validateCommandResult(response, normalized));
        }
      };
      if (dispose) {
        result.dispose = function disposeProvider() {
          return Promise.resolve().then(() => dispose()).then(() => undefined);
        };
      }
      return Object.freeze(result);
    }

    function resolveProvider(globalName = "SOC_CONSOLE_CONNECTORS") {
      if (typeof globalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
        throw new TypeError("Connector provider global name must be a JavaScript global identifier.");
      }
      const candidate = global ? global[globalName] : undefined;
      return candidate === undefined || candidate === null ? null : validateProvider(candidate);
    }

    function validateDocument(value, options) {
      assertRecord(value, "connector document");
      const settings = options === undefined ? {} : options;
      assertRecord(settings, "connector document options");
      assertAllowedKeys(settings, ["manifest", "request"], "connector document options");
      switch (value.documentType) {
        case "connector-manifest": return validateConnectorManifest(value);
        case "source-registration": return validateSourceRegistration(value, settings.manifest);
        case "source-health-snapshot": return validateSourceHealthSnapshot(value);
        case "connector-command-request": return validateCommandRequest(value, settings.manifest);
        case "connector-command-result": return validateCommandResult(value, settings.request);
        case "connector-control-snapshot": return validateControlSnapshot(value);
        default: throw new TypeError(`connector document.documentType must be one of: ${DOCUMENT_TYPES.join(", ")}.`);
      }
    }

    return Object.freeze({
      VERSION,
      DOCUMENT_TYPES,
      CONNECTOR_SCOPES,
      RECORD_KINDS,
      PAYLOAD_FIELD_MODES,
      CONFIG_VALUE_TYPES,
      CREDENTIAL_KINDS,
      CREDENTIAL_STORES,
      HEALTH_STATES,
      HEALTH_REASONS,
      SOURCE_STATES,
      COMMANDS,
      COMMAND_STATUSES,
      APP_STATES,
      HOST_STATES,
      CONNECTOR_INSTANCE_STATES,
      CHANGE_ACTIONS,
      CHANGE_STATUSES,
      ERROR_CODES,
      SNAPSHOT_REASONS,
      validateConnectorManifest,
      validateSourceRegistration,
      validateSourceHealthSnapshot,
      validateCommandRequest,
      validateCommandResult,
      validateControlRequest,
      validateControlSnapshot,
      validateProvider,
      resolveProvider,
      validateDocument
    });
  }
));
