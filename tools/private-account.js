#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { createPrivateAuth, validatePassword } = require("../server/private-auth");

const USAGE = `Private BB SOC account management (local filesystem authority required)

  node tools/private-account.js create --state-dir /absolute/private/path --email you@example.invalid --name "Your name"
  node tools/private-account.js reset-password --state-dir /absolute/private/path --email you@example.invalid
  node tools/private-account.js revoke-sessions --state-dir /absolute/private/path --email you@example.invalid

Optional: --base-url http://127.0.0.1:8080 (or your Tailnet HTTPS origin).
Passwords are entered twice without terminal echo. For password-manager/agent
automation, --password-stdin accepts one password line from stdin instead.
Never pass passwords in command arguments or environment variables. Do not echo
a literal password in your shell: pipe it directly from a password manager.
All provisioned accounts have full operator authority; this is not tenant RBAC.
`;

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  if (argv.length > 16 || argv.some(value => typeof value !== "string" || value.length > 4096)) throw new Error("Invalid account command arguments.");
  const [command, ...rest] = argv;
  if (!["create", "reset-password", "revoke-sessions"].includes(command)) throw new Error("Choose create, reset-password, or revoke-sessions.");
  const options = { command, baseURL: "http://127.0.0.1:8080" };
  const names = { "--state-dir": "stateDir", "--base-url": "baseURL", "--email": "email", "--name": "name" };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (seen.has(arg)) throw new Error("Duplicate account option.");
    seen.add(arg);
    if (arg === "--password-stdin") { options.passwordStdin = true; continue; }
    if (!names[arg] || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error("Unknown or incomplete account option. Password arguments are never accepted.");
    options[names[arg]] = rest[++index];
  }
  if (!options.stateDir || !options.email || (command === "create" && !options.name)) throw new Error("--state-dir, --email, and (for create) --name are required.");
  if (command !== "create" && options.name) throw new Error("--name applies only to create.");
  if (command === "revoke-sessions" && options.passwordStdin) throw new Error("revoke-sessions does not accept a password.");
  return options;
}

async function readPasswordLine(input) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024) throw new Error("Password stdin is too large.");
    chunks.push(buffer);
  }
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  return validatePassword(password);
}

function readHiddenPassword(prompt, input, output) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== "function") return reject(new Error("A terminal is required; use --password-stdin for a password-manager pipe."));
    readline.emitKeypressEvents(input);
    const previousRaw = Boolean(input.isRaw);
    let password = "";
    const cleanup = () => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.setRawMode(previousRaw);
      input.pause();
      output.write("\n");
    };
    const onEnd = () => { cleanup(); reject(new Error("Password input ended before confirmation.")); };
    const onKey = (text, key = {}) => {
      if ((key.ctrl && ["c", "d"].includes(key.name)) || key.name === "escape") { cleanup(); reject(new Error("Account operation cancelled.")); return; }
      if (key.name === "return" || key.name === "enter") { cleanup(); resolve(password); return; }
      if (key.name === "backspace") { password = Array.from(password).slice(0, -1).join(""); return; }
      if (key.ctrl || key.meta || !text || /[\u0000-\u001f\u007f]/.test(text)) return;
      password += text;
      if (password.length > 128) { cleanup(); reject(new Error("Password exceeds 128 characters.")); }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.resume();
  });
}

async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  const options = parseArguments(argv);
  if (options.help) { output.write(USAGE); return; }
  let password;
  if (options.command !== "revoke-sessions") {
    if (options.passwordStdin) password = await readPasswordLine(input);
    else {
      password = validatePassword(await readHiddenPassword("Password (15–128 characters): ", input, errorOutput));
      const confirmation = await readHiddenPassword("Confirm password: ", input, errorOutput);
      if (password !== confirmation) throw new Error("Password confirmation does not match.");
    }
  }
  const auth = await createPrivateAuth(options);
  try {
    if (options.command === "create") {
      await auth.createOperator({ email: options.email, name: options.name, password });
      output.write("Private operator created. Public registration remains disabled.\n");
    } else if (options.command === "reset-password") {
      const result = await auth.resetOperatorPassword({ email: options.email, password });
      output.write("Operator password reset; " + result.revokedSessions + " session(s) revoked.\n");
    } else {
      const result = auth.revokeOperatorSessions({ email: options.email });
      output.write(result.revokedSessions + " operator session(s) revoked.\n");
    }
  } finally { auth.close(); }
}

if (require.main === module) main().catch(error => { process.stderr.write("Account operation failed: " + error.message + "\n"); process.exitCode = 1; });

module.exports = { main, parseArguments, readPasswordLine, USAGE };
