"use strict";

// Versioned, data-only adapter boundary for downstream implementations. This
// module does not perform requests, persistence, uploads, or command execution.
(function installAdapterContract(global) {
  const VERSION = "1";
  const PAGE_STATES = Object.freeze(["loading", "ready", "empty", "error", "unavailable", "forbidden"]);
  const PANEL_TYPES = Object.freeze(["notice", "metrics", "table", "timeline", "bars", "chart", "text", "empty"]);
  const CELL_TYPES = Object.freeze(["text", "number", "badge", "time", "link"]);
  const TONES = Object.freeze(["neutral", "info", "ok", "warn", "bad"]);
  const CAPABILITY_KEYS = Object.freeze(["readPages", "runCommands", "uploads", "subscriptions", "persistence"]);
  const REQUEST_REASONS = Object.freeze(["initial", "navigation", "refresh"]);
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
      if (typeof key !== "string") throw new TypeError(`${label} must use string keys.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must use data properties.`);
      if (MARKUP_KEYS.has(key.replace(/[^a-z]/gi, "").toLowerCase())) {
        throw new TypeError(`${label} must contain data, not markup.`);
      }
      if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is not part of contract v${VERSION}.`);
    }
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Reflect.ownKeys(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function requiredText(value, label, maximum = 500) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
    }
    return value;
  }

  function optionalText(value, label, maximum = 2000) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > maximum) {
      throw new TypeError(`${label} must be a string of at most ${maximum} characters.`);
    }
    return value;
  }

  function finiteNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
    return value;
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
    if (segments.some((segment) => segment === "." || segment === ".." || !/^[a-z0-9_-]+$/i.test(segment))) {
      throw new TypeError(`${label} must be traversal-free.`);
    }
    return candidate;
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
    if (!match
      || month < 1 || month > 12
      || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 23 || offsetMinute > 59
      || Number.isNaN(Date.parse(value))) {
      throw new TypeError(`${label} must be an RFC 3339 date-time.`);
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

  function normalizeQuery(value, label) {
    const query = value === undefined ? {} : value;
    assertRecord(query, label);
    const queryKeys = Reflect.ownKeys(query);
    if (queryKeys.length > 20) throw new TypeError(`${label} must contain at most 20 entries.`);
    const normalizedQuery = {};
    queryKeys.forEach((key) => {
      if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
        throw new TypeError(`${label} contains an invalid key.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label} must use data properties.`);
      if (typeof query[key] !== "string" || query[key].length > 256) {
        throw new TypeError(`${label}.${key} must be a string of at most 256 characters.`);
      }
      normalizedQuery[key] = query[key];
    });
    return normalizedQuery;
  }

  function tone(value, label, fallback) {
    const candidate = value === undefined ? fallback : value;
    if (!TONES.includes(candidate)) throw new TypeError(`${label} must be one of: ${TONES.join(", ")}.`);
    return candidate;
  }

  function validateRequest(value) {
    assertRecord(value, "request");
    assertAllowedKeys(value, ["schemaVersion", "route", "query", "reason"], "request");
    if (value.schemaVersion !== VERSION) throw new TypeError(`request.schemaVersion must be ${VERSION}.`);
    const normalizedQuery = normalizeQuery(value.query, "request.query");
    const reason = value.reason === undefined ? "navigation" : value.reason;
    if (!REQUEST_REASONS.includes(reason)) {
      throw new TypeError(`request.reason must be one of: ${REQUEST_REASONS.join(", ")}.`);
    }
    return deepFreeze({
      schemaVersion: VERSION,
      route: route(value.route, "request.route"),
      query: normalizedQuery,
      reason
    });
  }

  function normalizeCell(value, label) {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 2000) throw new TypeError(`${label} must be a string of at most 2000 characters.`);
      return value;
    }
    if (typeof value === "number") return finiteNumber(value, label);
    assertRecord(value, label);
    const type = value.type;
    if (!CELL_TYPES.includes(type)) throw new TypeError(`${label}.type must be one of: ${CELL_TYPES.join(", ")}.`);
    if (type === "text") {
      assertAllowedKeys(value, ["type", "text"], label);
      return { type, text: requiredText(value.text, `${label}.text`, 1000) };
    }
    if (type === "number") {
      assertAllowedKeys(value, ["type", "value", "unit"], label);
      const result = { type, value: finiteNumber(value.value, `${label}.value`) };
      const unit = optionalText(value.unit, `${label}.unit`, 32);
      if (unit !== undefined) result.unit = unit;
      return result;
    }
    if (type === "badge") {
      assertAllowedKeys(value, ["type", "label", "tone"], label);
      return {
        type,
        label: requiredText(value.label, `${label}.label`, 80),
        tone: tone(value.tone, `${label}.tone`, "neutral")
      };
    }
    if (type === "link") {
      assertAllowedKeys(value, ["type", "label", "route", "query"], label);
      const result = {
        type,
        label: requiredText(value.label, `${label}.label`, 200),
        route: route(value.route, `${label}.route`),
        query: normalizeQuery(value.query, `${label}.query`)
      };
      return result;
    }
    assertAllowedKeys(value, ["type", "value", "display"], label);
    const result = { type, value: timestamp(value.value, `${label}.value`) };
    const display = optionalText(value.display, `${label}.display`, 100);
    if (display !== undefined) result.display = display;
    return result;
  }

  function panelBase(panel, label, allowed) {
    assertRecord(panel, label);
    assertAllowedKeys(panel, allowed, label);
    return {
      id: identifier(panel.id, `${label}.id`),
      type: panel.type
    };
  }

  function addOptionalPanelCopy(result, panel, label) {
    const title = optionalText(panel.title, `${label}.title`, 200);
    const description = optionalText(panel.description, `${label}.description`, 1000);
    if (title !== undefined) result.title = title;
    if (description !== undefined) result.description = description;
  }

  function normalizeNotice(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "body", "tone"]);
    result.title = requiredText(panel.title, `${label}.title`, 200);
    result.body = requiredText(panel.body, `${label}.body`, 2000);
    result.tone = tone(panel.tone, `${label}.tone`, "info");
    return result;
  }

  function normalizeMetrics(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "description", "items"]);
    addOptionalPanelCopy(result, panel, label);
    if (!Array.isArray(panel.items) || panel.items.length > 32) throw new TypeError(`${label}.items must be an array of at most 32 metrics.`);
    const itemLabels = new Set();
    result.items = panel.items.map((item, index) => {
      const itemLabel = `${label}.items[${index}]`;
      assertRecord(item, itemLabel);
      assertAllowedKeys(item, ["label", "value", "detail", "tone"], itemLabel);
      if (typeof item.value !== "string" && typeof item.value !== "number") {
        throw new TypeError(`${itemLabel}.value must be a string or finite number.`);
      }
      if (typeof item.value === "number") finiteNumber(item.value, `${itemLabel}.value`);
      if (typeof item.value === "string" && item.value.length > 200) {
        throw new TypeError(`${itemLabel}.value must be at most 200 characters.`);
      }
      const normalizedLabel = requiredText(item.label, `${itemLabel}.label`, 120);
      if (itemLabels.has(normalizedLabel)) throw new TypeError(`${label}.items must use unique labels.`);
      itemLabels.add(normalizedLabel);
      const normalized = {
        label: normalizedLabel,
        value: item.value,
        tone: tone(item.tone, `${itemLabel}.tone`, "neutral")
      };
      const detail = optionalText(item.detail, `${itemLabel}.detail`, 300);
      if (detail !== undefined) normalized.detail = detail;
      return normalized;
    });
    return result;
  }

  function normalizeTable(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "description", "caption", "columns", "rows", "disclosures"]);
    addOptionalPanelCopy(result, panel, label);
    result.caption = requiredText(panel.caption, `${label}.caption`, 300);
    if (!Array.isArray(panel.columns) || panel.columns.length < 1 || panel.columns.length > 30) {
      throw new TypeError(`${label}.columns must contain between 1 and 30 columns.`);
    }
    const columnKeys = new Set();
    result.columns = panel.columns.map((column, index) => {
      const columnLabel = `${label}.columns[${index}]`;
      assertRecord(column, columnLabel);
      assertAllowedKeys(column, ["key", "label", "align"], columnLabel);
      const key = identifier(column.key, `${columnLabel}.key`);
      if (columnKeys.has(key)) throw new TypeError(`${label}.columns must use unique keys.`);
      columnKeys.add(key);
      const align = column.align === undefined ? "left" : column.align;
      if (!["left", "center", "right"].includes(align)) throw new TypeError(`${columnLabel}.align must be left, center, or right.`);
      return { key, label: requiredText(column.label, `${columnLabel}.label`, 120), align };
    });
    if (!Array.isArray(panel.rows) || panel.rows.length > 200) throw new TypeError(`${label}.rows must be an array of at most 200 rows.`);
    result.rows = panel.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== result.columns.length) {
        throw new TypeError(`${label}.rows[${rowIndex}] must contain one cell for each column.`);
      }
      return row.map((cell, cellIndex) => normalizeCell(cell, `${label}.rows[${rowIndex}][${cellIndex}]`));
    });
    if (panel.disclosures !== undefined) {
      if (!Array.isArray(panel.disclosures) || panel.disclosures.length !== result.rows.length) {
        throw new TypeError(`${label}.disclosures must contain one entry for each row.`);
      }
      result.disclosures = panel.disclosures.map((disclosure, rowIndex) => {
        const disclosureLabel = `${label}.disclosures[${rowIndex}]`;
        if (disclosure === null) return null;
        assertRecord(disclosure, disclosureLabel);
        assertAllowedKeys(disclosure, ["label", "items"], disclosureLabel);
        if (!Array.isArray(disclosure.items) || disclosure.items.length < 1 || disclosure.items.length > 8) {
          throw new TypeError(`${disclosureLabel}.items must contain between 1 and 8 entries.`);
        }
        const normalized = {
          label: disclosure.label === undefined ? "Details" : requiredText(disclosure.label, `${disclosureLabel}.label`, 120),
          items: disclosure.items.map((item, itemIndex) => {
            const itemLabel = `${disclosureLabel}.items[${itemIndex}]`;
            assertRecord(item, itemLabel);
            assertAllowedKeys(item, ["label", "text"], itemLabel);
            return {
              label: requiredText(item.label, `${itemLabel}.label`, 120),
              text: requiredText(item.text, `${itemLabel}.text`, 2000)
            };
          })
        };
        return normalized;
      });
    }
    return result;
  }

  function normalizeTimeline(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "description", "items"]);
    addOptionalPanelCopy(result, panel, label);
    if (!Array.isArray(panel.items) || panel.items.length > 100) throw new TypeError(`${label}.items must be an array of at most 100 events.`);
    result.items = panel.items.map((item, index) => {
      const itemLabel = `${label}.items[${index}]`;
      assertRecord(item, itemLabel);
      assertAllowedKeys(item, ["at", "label", "detail", "tone"], itemLabel);
      const normalized = {
        at: timestamp(item.at, `${itemLabel}.at`),
        label: requiredText(item.label, `${itemLabel}.label`, 300),
        tone: tone(item.tone, `${itemLabel}.tone`, "neutral")
      };
      const detail = optionalText(item.detail, `${itemLabel}.detail`, 1000);
      if (detail !== undefined) normalized.detail = detail;
      return normalized;
    });
    return result;
  }

  function normalizeBars(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "description", "items"]);
    addOptionalPanelCopy(result, panel, label);
    if (!Array.isArray(panel.items) || panel.items.length > 100) throw new TypeError(`${label}.items must be an array of at most 100 bars.`);
    result.items = panel.items.map((item, index) => {
      const itemLabel = `${label}.items[${index}]`;
      assertRecord(item, itemLabel);
      assertAllowedKeys(item, ["label", "value", "max", "tone"], itemLabel);
      const maximum = item.max === undefined ? 100 : finiteNumber(item.max, `${itemLabel}.max`);
      const numericValue = finiteNumber(item.value, `${itemLabel}.value`);
      if (maximum <= 0 || numericValue < 0 || numericValue > maximum) {
        throw new TypeError(`${itemLabel} must satisfy 0 <= value <= max and max > 0.`);
      }
      return {
        label: requiredText(item.label, `${itemLabel}.label`, 120),
        value: numericValue,
        max: maximum,
        tone: tone(item.tone, `${itemLabel}.tone`, "info")
      };
    });
    return result;
  }

  function normalizeChart(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "description", "unit", "buckets", "series"]);
    addOptionalPanelCopy(result, panel, label);
    const unit = optionalText(panel.unit, `${label}.unit`, 40);
    if (unit !== undefined) result.unit = unit;
    if (!Array.isArray(panel.buckets) || panel.buckets.length > 336) {
      throw new TypeError(`${label}.buckets must be an array of at most 336 RFC 3339 date-times.`);
    }
    result.buckets = panel.buckets.map((bucket, index) => timestamp(bucket, `${label}.buckets[${index}]`));
    for (let index = 1; index < result.buckets.length; index += 1) {
      if (Date.parse(result.buckets[index]) <= Date.parse(result.buckets[index - 1])) {
        throw new TypeError(`${label}.buckets must be strictly increasing.`);
      }
    }
    if (!Array.isArray(panel.series) || panel.series.length > 32) {
      throw new TypeError(`${label}.series must be an array of at most 32 series.`);
    }
    const labels = new Set();
    result.series = panel.series.map((series, seriesIndex) => {
      const seriesLabel = `${label}.series[${seriesIndex}]`;
      assertRecord(series, seriesLabel);
      assertAllowedKeys(series, ["label", "values", "tone"], seriesLabel);
      const normalizedLabel = requiredText(series.label, `${seriesLabel}.label`, 120);
      if (labels.has(normalizedLabel)) throw new TypeError(`${label}.series must use unique labels.`);
      labels.add(normalizedLabel);
      if (!Array.isArray(series.values) || series.values.length !== result.buckets.length) {
        throw new TypeError(`${seriesLabel}.values must contain one value for each bucket.`);
      }
      const values = series.values.map((value, valueIndex) => {
        const normalized = finiteNumber(value, `${seriesLabel}.values[${valueIndex}]`);
        if (normalized < 0) throw new TypeError(`${seriesLabel}.values[${valueIndex}] must be non-negative.`);
        return normalized;
      });
      return {
        label: normalizedLabel,
        values,
        tone: tone(series.tone, `${seriesLabel}.tone`, "neutral")
      };
    });
    return result;
  }

  function normalizeText(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "body", "tone"]);
    const title = optionalText(panel.title, `${label}.title`, 200);
    if (title !== undefined) result.title = title;
    result.body = requiredText(panel.body, `${label}.body`, 4000);
    result.tone = tone(panel.tone, `${label}.tone`, "neutral");
    return result;
  }

  function normalizeEmpty(panel, label) {
    const result = panelBase(panel, label, ["id", "type", "title", "body"]);
    result.title = requiredText(panel.title, `${label}.title`, 200);
    result.body = requiredText(panel.body, `${label}.body`, 2000);
    return result;
  }

  const panelNormalizers = Object.freeze({
    notice: normalizeNotice,
    metrics: normalizeMetrics,
    table: normalizeTable,
    timeline: normalizeTimeline,
    bars: normalizeBars,
    chart: normalizeChart,
    text: normalizeText,
    empty: normalizeEmpty
  });

  function normalizePanel(panel, index) {
    assertRecord(panel, `envelope.panels[${index}]`);
    if (!PANEL_TYPES.includes(panel.type)) {
      throw new TypeError(`envelope.panels[${index}].type must be one of: ${PANEL_TYPES.join(", ")}.`);
    }
    return panelNormalizers[panel.type](panel, `envelope.panels[${index}]`);
  }

  function validateEnvelope(value, expectedRoute) {
    assertRecord(value, "envelope");
    assertAllowedKeys(value, ["schemaVersion", "route", "state", "title", "summary", "updatedAt", "panels"], "envelope");
    if (value.schemaVersion !== VERSION) throw new TypeError(`envelope.schemaVersion must be ${VERSION}.`);
    const normalizedRoute = route(value.route, "envelope.route");
    if (expectedRoute !== undefined && normalizedRoute !== route(expectedRoute, "expectedRoute")) {
      throw new TypeError("envelope.route does not match the requested route.");
    }
    if (!PAGE_STATES.includes(value.state)) {
      throw new TypeError(`envelope.state must be one of: ${PAGE_STATES.join(", ")}.`);
    }
    if (!Array.isArray(value.panels) || value.panels.length > 64) {
      throw new TypeError("envelope.panels must be an array of at most 64 panels.");
    }
    const panels = value.panels.map(normalizePanel);
    const ids = new Set();
    panels.forEach((panel) => {
      if (ids.has(panel.id)) throw new TypeError("envelope.panels must use unique ids.");
      ids.add(panel.id);
    });
    const normalized = {
      schemaVersion: VERSION,
      route: normalizedRoute,
      state: value.state,
      title: requiredText(value.title, "envelope.title", 200),
      panels
    };
    const summary = optionalText(value.summary, "envelope.summary", 1000);
    if (summary !== undefined) normalized.summary = summary;
    if (value.updatedAt !== undefined && value.updatedAt !== null) {
      normalized.updatedAt = timestamp(value.updatedAt, "envelope.updatedAt");
    }
    return deepFreeze(normalized);
  }

  function normalizeCapabilities(value) {
    assertRecord(value, "provider.capabilities");
    assertAllowedKeys(value, CAPABILITY_KEYS, "provider.capabilities");
    const normalized = {};
    CAPABILITY_KEYS.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new TypeError(`provider.capabilities.${key} is required.`);
      }
      const candidate = value[key];
      if (typeof candidate !== "boolean") throw new TypeError(`provider.capabilities.${key} must be a boolean.`);
      normalized[key] = candidate;
    });
    if (!normalized.readPages) throw new TypeError("provider.capabilities.readPages must be true.");
    return deepFreeze(normalized);
  }

  function validateProvider(value) {
    assertRecord(value, "provider");
    assertAllowedKeys(value, ["schemaVersion", "id", "capabilities", "readPage", "runCommand", "subscribe", "dispose"], "provider");
    if (value.schemaVersion !== VERSION) throw new TypeError(`provider.schemaVersion must be ${VERSION}.`);
    const capabilities = normalizeCapabilities(value.capabilities);
    if (typeof value.readPage !== "function") throw new TypeError("provider.readPage must be a function.");
    if (capabilities.runCommands !== (typeof value.runCommand === "function")) {
      throw new TypeError("provider.runCommand must exist exactly when provider.capabilities.runCommands is true.");
    }
    if (capabilities.subscriptions !== (typeof value.subscribe === "function")) {
      throw new TypeError("provider.subscribe must exist exactly when provider.capabilities.subscriptions is true.");
    }
    if (value.dispose !== undefined && typeof value.dispose !== "function") throw new TypeError("provider.dispose must be a function when supplied.");

    const provider = {
      schemaVersion: VERSION,
      id: identifier(value.id, "provider.id"),
      capabilities,
      readPage: value.readPage.bind(value)
    };
    if (capabilities.runCommands) provider.runCommand = value.runCommand.bind(value);
    if (capabilities.subscriptions) provider.subscribe = value.subscribe.bind(value);
    if (value.dispose) provider.dispose = value.dispose.bind(value);
    return Object.freeze(provider);
  }

  function createEmptyProvider(envelopes) {
    const supplied = envelopes === undefined ? [] : envelopes;
    if (!Array.isArray(supplied) || supplied.length > 100) {
      throw new TypeError("createEmptyProvider expects an array of at most 100 page envelopes.");
    }
    const pages = new Map();
    supplied.forEach((envelope) => {
      const normalized = validateEnvelope(envelope);
      if (pages.has(normalized.route)) throw new TypeError("createEmptyProvider routes must be unique.");
      pages.set(normalized.route, normalized);
    });
    return validateProvider({
      schemaVersion: VERSION,
      id: "soc-console-empty",
      capabilities: {
        readPages: true,
        runCommands: false,
        uploads: false,
        subscriptions: false,
        persistence: false
      },
      readPage(request) {
        const normalizedRequest = validateRequest(request);
        const page = pages.get(normalizedRequest.route);
        if (page) return Promise.resolve(page);
        return Promise.resolve(validateEnvelope({
          schemaVersion: VERSION,
          route: normalizedRequest.route,
          state: "empty",
          title: "No data supplied",
          summary: "The application adapter has not supplied an envelope for this route.",
          panels: [{
            id: "route-not-configured",
            type: "empty",
            title: "Route not configured",
            body: "Add a version 1 page envelope for this route when constructing the provider."
          }]
        }, normalizedRequest.route));
      }
    });
  }

  function resolveProvider(globalName = "SOC_CONSOLE_ADAPTER") {
    if (typeof globalName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
      throw new TypeError("Adapter global name must be a JavaScript global identifier.");
    }
    const candidate = global[globalName];
    return candidate === undefined || candidate === null ? null : validateProvider(candidate);
  }

  global.SocConsoleAdapterRuntime = Object.freeze({
    VERSION,
    PAGE_STATES,
    PANEL_TYPES,
    CELL_TYPES,
    TONES,
    CAPABILITY_KEYS,
    REQUEST_REASONS,
    validateRequest,
    validateEnvelope,
    validateProvider,
    createEmptyProvider,
    resolveProvider
  });
}(window));
