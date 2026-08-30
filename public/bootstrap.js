"use strict";

// Composes the data-free UI with optional application-owned data and
// authentication adapters.
(function bootstrapSocConsole(global) {
  const documentRef = global.document;
  const root = documentRef.getElementById("content");
  const shellRoot = documentRef.getElementById("soc-console");

  function showMountFailure(error) {
    if (root) {
      const section = documentRef.createElement("section");
      section.className = "panel state-panel state-error";
      section.setAttribute("role", "alert");
      section.setAttribute("aria-labelledby", "mount-error-title");
      const title = documentRef.createElement("h1");
      title.id = "mount-error-title";
      title.textContent = "The interface could not start";
      const copy = documentRef.createElement("p");
      copy.textContent = "Check the public configuration and adapter contract, then reload this page.";
      section.append(title, copy);
      root.replaceChildren(section);
      root.focus({ preventScroll: true });
    }
    if (global.console && typeof global.console.error === "function") {
      global.console.error("SOC console bootstrap failed.");
    }
  }

  try {
    if (!root) throw new Error("The #content mount element is missing.");
    if (!global.SocConsole || typeof global.SocConsole.createApp !== "function") {
      throw new Error("SocConsole.createApp is unavailable.");
    }
    const runtime = global.SocConsoleAdapterRuntime;
    if (!runtime || typeof runtime.resolveProvider !== "function") {
      throw new Error("SocConsoleAdapterRuntime is unavailable.");
    }
    const authRuntime = global.SocConsoleAuthRuntime;
    if (!authRuntime || typeof authRuntime.resolveProvider !== "function") {
      throw new Error("SocConsoleAuthRuntime is unavailable.");
    }
    const connectorRuntime = global.SocConsoleConnectorRuntime;
    if (!connectorRuntime || typeof connectorRuntime.resolveProvider !== "function") {
      throw new Error("SocConsoleConnectorRuntime is unavailable.");
    }
    const administrationRuntime = global.SocConsoleAdministrationRuntime;
    if (!administrationRuntime || typeof administrationRuntime.resolveProvider !== "function") {
      throw new Error("SocConsoleAdministrationRuntime is unavailable.");
    }
    const config = global.SocConsoleConfig;
    if (!config || config.schemaVersion !== runtime.VERSION || config.schemaVersion !== authRuntime.VERSION
        || config.schemaVersion !== connectorRuntime.VERSION || config.schemaVersion !== administrationRuntime.VERSION) {
      throw new Error("The public configuration version is incompatible.");
    }
    const provider = runtime.resolveProvider(config.adapter.globalName);
    const auth = authRuntime.resolveProvider(config.auth.globalName);
    const commands = connectorRuntime.resolveProvider(config.connectors.globalName);
    const administration = administrationRuntime.resolveProvider(config.administration.globalName);
    const app = global.SocConsole.createApp({ root, shellRoot, provider, auth, commands, administration, config });
    if (!app || typeof app.mount !== "function") throw new Error("createApp must return a controller with mount().");
    global.SocConsoleApp = app;
    let readiness;
    try {
      readiness = Promise.resolve(app.mount()).then(() => app);
    } catch (error) {
      readiness = Promise.reject(error);
    }
    global.SocConsoleAppReady = readiness;
    readiness.catch(showMountFailure);
  } catch (error) {
    showMountFailure(error);
  }
}(window));
