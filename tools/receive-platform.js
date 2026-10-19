#!/usr/bin/env node
"use strict";
const { privateFile,startGateway }=require("./platform-gateway");
async function main(args=process.argv.slice(2)) {
  if(args.length===1&&args[0]==="--help") {process.stdout.write("Usage: node tools/receive-platform.js --config /absolute/path/gateway.json\nForeground authenticated OTLP JSON or mutual-TLS syslog gateway with durable canonical outbox.\n");return;}
  if(args.length!==2||args[0]!=="--config")throw new TypeError("Use --config with an owner-only external JSON file.");
  const config=JSON.parse(privateFile(args[1]).toString("utf8")),gateway=await startGateway(config);
  process.stdout.write(JSON.stringify({state:"listening",protocol:config.listener.protocol,port:gateway.address.port})+"\n");
  let closing=false;
  const stop=async()=>{if(closing)return;closing=true;await gateway.close();};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
if(require.main===module)main().catch(()=>{process.stderr.write("Gateway refused configuration or could not start; inspect private configuration and preserve queued work.\n");process.exitCode=1;});
module.exports={main};
