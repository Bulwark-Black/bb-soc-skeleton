"use strict";

// Load after adapter-contract.js and before bootstrap.js. Replace readPage with
// application-owned data access; keep the returned value inside contract v1.
(function installProviderTemplate(global) {
  const runtime = global.SocConsoleAdapterRuntime;
  if (!runtime) throw new Error("Load adapter-contract.js before provider-template.js.");

  global.SOC_CONSOLE_ADAPTER = {
    schemaVersion: "1",
    id: "application-template",
    capabilities: {
      readPages: true,
      runCommands: false,
      uploads: false,
      subscriptions: false,
      persistence: false
    },
    readPage(request) {
      const normalizedRequest = runtime.validateRequest(request);
      // A real read provider should branch on normalizedRequest.route plus its
      // allowlisted query. Query-selected Tuning, Rules, and Phishing detail
      // layouts use the stable data-only IDs and preferred types documented in
      // docs/ADAPTER-CONTRACT.md#specialized-query-branch-slots. Supplying one
      // of those panels hydrates presentation only; it must not enable a
      // structural command control. Analytics uses validated `chart` panels;
      // safe cross-board pivots use typed internal `link` cells; Expected
      // Sources and health drills use table `disclosures`. Do not return SVG,
      // HTML, callbacks, external URLs, or prebuilt controls.
      return Promise.resolve(runtime.validateEnvelope({
        schemaVersion: "1",
        route: normalizedRequest.route,
        state: "empty",
        title: "No operational data supplied",
        summary: "Connect this adapter to application-owned, authorized data access.",
        panels: []
      }, normalizedRequest.route));
    }
  };
}(window));
