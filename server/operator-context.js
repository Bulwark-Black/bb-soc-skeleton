"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const operators = new AsyncLocalStorage();

function operatorId(userId) {
  if (typeof userId !== "string" || !userId || userId.length > 256) throw new TypeError("Operator identity is required.");
  return "operator:" + crypto.createHash("sha256").update(userId).digest("hex");
}

function runAsOperator(userId, callback) { return operators.run(operatorId(userId), callback); }
function runAsService(serviceId, callback) {
  if (typeof serviceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(serviceId)) throw new TypeError("Service identity is invalid.");
  return operators.run("service:" + serviceId, callback);
}
function currentOperator() { return operators.getStore() || "loopback:operator"; }

module.exports = { operatorId, runAsOperator, runAsService, currentOperator };
