"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), net = require("node:net"), crypto = require("node:crypto");
const { smtpConfiguration, connectionOptions, compileSmtpMessage, sendSmtp, verifySmtp } = require("../server/native-monitor/smtp-transport");
const credentials = () => ({ user: "synthetic@example.invalid", pass: crypto.randomBytes(24).toString("base64url") });
async function relay(t, mode = "accepted") {
  const sockets = new Set(), commands = [], messages = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.write("220 loopback ESMTP\r\n"); let input = "", data = false;
    socket.on("data", chunk => {
      input += chunk.toString();
      if (data) {
        const end = input.indexOf("\r\n.\r\n"); if (end < 0) return;
        messages.push(input.slice(0, end)); input = input.slice(end + 5); data = false;
        if (mode === "drop") return socket.destroy();
        if (mode === "timeout") return;
        socket.write(mode === "temporary-data" ? "451 4.3.0 Temporary failure\r\n" : "250 2.0.0 Accepted queue-example\r\n");
      }
      let end;
      while (!data && (end = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 2);
        const command = line.split(" ")[0]; commands.push(command);
        if (command === "EHLO") socket.write("250-loopback\r\n250 AUTH PLAIN\r\n");
        else if (command === "AUTH") socket.write("235 2.7.0 Authenticated\r\n");
        else if (command === "MAIL") socket.write("250 2.1.0 Sender accepted\r\n");
        else if (command === "RCPT") socket.write(mode === "temporary-rcpt" ? "451 4.3.0 Recipient deferred\r\n" : "250 2.1.5 Recipient accepted\r\n");
        else if (command === "DATA") { data = true; socket.write("354 End with dot\r\n"); }
        else if (command === "QUIT") { socket.end("221 2.0.0 Bye\r\n"); }
        else socket.write("502 5.5.1 Not supported\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server: { host: "127.0.0.1", port: server.address().port, security: "test-loopback" }, commands, messages };
}
async function mail() {
  const value = { from: "monitor@example.invalid", to: ["team@example.invalid"], subject: "Synthetic fixture", text: ".dot-line\nSynthetic mail",
    messageId: "<fixture@example.invalid>", date: new Date("2026-10-18T12:00:00Z") };
  return { envelope: { from: value.from, to: value.to }, messageId: value.messageId, raw: await compileSmtpMessage(value) };
}
test("SMTP configuration enforces reviewed TLS and does not accept arbitrary Nodemailer options", () => {
  assert.throws(() => smtpConfiguration({ host: "mail.example.invalid", port: 587, security: "test-loopback" }), /verified TLS/);
  assert.throws(() => smtpConfiguration({ host: "127.0.0.1", port: 587, security: "starttls" }), /servername/);
  assert.throws(() => smtpConfiguration({ host: "mail.example.invalid", port: 587, security: "starttls", rejectUnauthorized: false }), /verified TLS/);
  const server = smtpConfiguration({ host: "mail.example.invalid", port: 587, security: "starttls" });
  const options = connectionOptions(server);
  assert.equal(options.requireTLS, true); assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.opportunisticTLS, false);
  assert.equal(options.debug, false); assert.equal(options.logger, false);
});
test("actual Nodemailer verifies without mail and validates relay acceptance after durable DATA callback", async t => {
  const local = await relay(t), content = await mail();
  const verified = await verifySmtp({ server: local.server, credentials: credentials() }, { allowInsecureLoopback: true });
  assert.equal(verified.verified, true); assert.equal(local.messages.length, 0); assert.equal(local.commands.includes("DATA"), false);
  let marked = false;
  const result = await sendSmtp({ server: local.server, credentials: credentials(), ...content, beforeData() { marked = true; assert.equal(local.messages.length, 0); } }, { allowInsecureLoopback: true });
  assert.equal(marked, true); assert.equal(result.accepted, true); assert.equal(result.smtpStatus, 250);
  assert.match(result.receiptId, /^smtp-receipt-[a-f0-9]{64}$/); assert.equal(result.response, undefined);
  assert.equal(local.messages.length, 1); assert.match(local.messages[0], /Message-ID: <fixture@example.invalid>/);
});
test("SMTP ambiguous DATA outcomes park; explicit rejection is the only safe DATA retry", async t => {
  for (const mode of ["drop", "timeout", "temporary-data", "temporary-rcpt"]) {
    const local = await relay(t, mode); let marked = false;
    const result = await sendSmtp({ server: local.server, credentials: credentials(), ...(await mail()), beforeData() { marked = true; } }, { allowInsecureLoopback: true, timeoutMs: mode === "timeout" ? 300 : 20000 });
    assert.equal(result.accepted, false, mode);
    assert.equal(result.ambiguous, ["drop", "timeout"].includes(mode), mode);
    assert.equal(result.retryable, mode.startsWith("temporary"), mode);
    assert.equal(marked, mode !== "temporary-rcpt", mode);
  }
});
test("STARTTLS absence and failed durable marker prevent message bytes", async t => {
  const local = await relay(t), content = await mail();
  const tls = await sendSmtp({ server: { ...local.server, security: "starttls", servername: "mail.example.invalid" }, credentials: credentials(), ...content, beforeData() { assert.fail("TLS failure reached DATA"); } });
  assert.equal(tls.accepted, false); assert.equal(local.commands.includes("AUTH"), false); assert.equal(local.messages.length, 0);
  const marker = await sendSmtp({ server: local.server, credentials: credentials(), ...content, beforeData() { throw new Error("synthetic disk limit"); } }, { allowInsecureLoopback: true });
  assert.equal(marker.errorCode, "smtp-data-boundary-refused"); assert.equal(marker.ambiguous, false);
  assert.equal(local.messages.length, 0);
});
