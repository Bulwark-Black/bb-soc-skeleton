"use strict";
// Nodemailer owns SMTP framing, dot-stuffing, TLS and authentication. This
// adapter adds a durable DATA boundary and never treats Message-ID as deduplication.
const net = require("node:net");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const SMTPConnection = require("nodemailer/lib/smtp-connection");
const MailComposer = require("nodemailer/lib/mail-composer");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function smtpConfiguration(value, { allowInsecureLoopback = false } = {}) {
  if (!plain(value) || Object.keys(value).some(key => !["host", "port", "security", "servername"].includes(key))
      || typeof value.host !== "string" || value.host.length > 253
      || !(net.isIP(value.host) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value.host))
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || !["tls", "starttls", ...(allowInsecureLoopback && ["127.0.0.1", "::1"].includes(value.host) ? ["test-loopback"] : [])].includes(value.security))
    throw new TypeError("SMTP requires an explicit host, port and verified TLS or STARTTLS.");
  const servername = value.servername || (net.isIP(value.host) ? undefined : value.host);
  if (value.security !== "test-loopback" && (!servername || typeof servername !== "string" || servername.length > 253
      || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(servername) || net.isIP(servername)))
    throw new TypeError("SMTP certificate verification requires a DNS servername, including when connecting to an IP.");
  return Object.freeze({ host: value.host.toLowerCase(), port: value.port, security: value.security, ...(servername ? { servername: servername.toLowerCase() } : {}) });
}
function connectionOptions(server) {
  return { host: server.host, port: server.port, secure: server.security === "tls",
    requireTLS: server.security === "starttls", ignoreTLS: server.security === "test-loopback", opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: server.servername },
    name: "monitor.invalid", logger: false, debug: false, transactionLog: false,
    connectionTimeout: 10000, greetingTimeout: 5000, socketTimeout: 10000, dnsTimeout: 5000 };
}
async function compileSmtpMessage({ from, to, subject, text, messageId, date }) {
  const raw = await new MailComposer({ from, to, subject, text, messageId, date,
    textEncoding: "base64", newline: "windows", disableFileAccess: true, disableUrlAccess: true }).compile().build();
  if (raw.length > 131072) throw new TypeError("SMTP message exceeds the bounded notification size.");
  return raw.toString("utf8");
}
function classifySmtpError(error, dataStarted, stage) {
  const code = Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599
    && new RegExp("^" + error.responseCode + "(?:[ -]|$)").test(error.response || "") ? error.responseCode : null;
  const explicitRejection = code !== null;
  const certificateError = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(String(error?.originalCode || error?.code || ""));
  const preDataTransient = !dataStarted && !certificateError && ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code);
  return { accepted: false, retryable: explicitRejection ? code < 500 : preDataTransient,
    safeToRetry: explicitRejection || !dataStarted, ambiguous: dataStarted && !explicitRejection,
    smtpStatus: code, stage, errorCode: explicitRejection ? "smtp-rejected-" + code : certificateError ? "smtp-tls-verification-failed"
      : dataStarted ? "smtp-data-outcome-unknown" : "smtp-before-data-failed",
    responseDigest: typeof error?.response === "string" ? hash(error.response.slice(0, 8192)) : null };
}
function session({ server, credentials, envelope, raw, messageId, beforeData, verifyOnly = false },
  { Connection = SMTPConnection, allowInsecureLoopback = false, timeoutMs = 20000 } = {}) {
  server = smtpConfiguration(server, { allowInsecureLoopback });
  if (!plain(credentials) || typeof credentials.user !== "string" || typeof credentials.pass !== "string"
      || !credentials.user || !credentials.pass) throw new TypeError("SMTP credentials are required.");
  if (!verifyOnly && (!plain(envelope) || !Array.isArray(envelope.to) || envelope.to.length !== 1
      || typeof raw !== "string" || Buffer.byteLength(raw) > 131072 || typeof beforeData !== "function"))
    throw new TypeError("SMTP requires one frozen recipient, bounded MIME and a durable DATA callback.");
  return new Promise(resolve => {
    const connection = new Connection(connectionOptions(server));
    let done = false, dataStarted = false, stage = "connection", stream;
    const finish = result => {
      if (done) return; done = true; clearTimeout(timer);
      stream?.destroy();
      connection.close();
      resolve(result);
    };
    const failed = error => finish(classifySmtpError(error, dataStarted, stage));
    const timer = setTimeout(() => failed(Object.assign(new Error("SMTP deadline"), { code: "ETIMEDOUT" })), timeoutMs);
    connection.on("error", failed);
    connection.on("end", () => { if (!done) failed(Object.assign(new Error("SMTP ended"), { code: "ECONNECTION" })); });
    try { connection.connect(() => {
      if (done) return;
      stage = "authentication";
      connection.login({ user: credentials.user, pass: credentials.pass }, error => {
        if (done) return;
        if (error) return failed(error);
        if (verifyOnly) return finish({ verified: true, accepted: false, stage: "authenticated", message: "Connection, TLS and authentication succeeded; sender/recipient acceptance and delivery are not proven." });
        stage = "envelope";
        // Nodemailer does not read this stream until the relay has accepted
        // DATA. Commit the marker before releasing any message bytes.
        stream = new Readable({ read() {
          if (done || dataStarted) return;
          try { beforeData(); } catch {
            finish({ accepted: false, retryable: false, safeToRetry: true, ambiguous: false, smtpStatus: null, stage: "before-data", errorCode: "smtp-data-boundary-refused" });
            return;
          }
          dataStarted = true; stage = "data";
          this.push(Buffer.from(raw, "utf8")); this.push(null);
        } });
        stream.on("error", failed);
        connection.send(envelope, stream, (error, info) => {
          if (done) return;
          if (error) return failed(error);
          const valid = dataStarted && typeof info?.response === "string" && /^250(?:[ -]|$)/.test(info.response)
            && info.accepted?.length === 1 && info.accepted[0] === envelope.to[0] && !info.rejected?.length;
          if (!valid) return finish({ accepted: false, retryable: false, safeToRetry: false, ambiguous: true,
            smtpStatus: null, stage: "data", errorCode: "smtp-acceptance-unproven" });
          const responseDigest = hash(info.response.slice(0, 8192));
          finish({ accepted: true, retryable: false, ambiguous: false, smtpStatus: 250, stage: "accepted",
            // This is local receipt evidence binding the validated relay reply;
            // it is not a fabricated relay queue identifier or inbox receipt.
            receiptId: "smtp-receipt-" + hash(JSON.stringify([messageId, envelope, responseDigest])),
            responseDigest });
        });
      });
    }); } catch (error) { failed(error); }
  });
}
function sendSmtp(input, options) { return session(input, options); }
function verifySmtp(input, options) { return session({ ...input, verifyOnly: true }, options); }
module.exports = { smtpConfiguration, connectionOptions, compileSmtpMessage, classifySmtpError, sendSmtp, verifySmtp };
