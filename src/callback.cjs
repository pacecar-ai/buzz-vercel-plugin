// The manifest fixes the HTTPS return page as the first argument after "node -e … --".
const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const returnPage = process.argv[1];
const path = "/buzz/" + randomBytes(24).toString("base64url");
const receipt = randomBytes(32).toString("base64url");
let origin;
let used = false;
const server = createServer((req, res) => {
  let url;
  try { url = new URL(req.url, origin); } catch { res.writeHead(400).end(); return; }
  const code = url.searchParams.get("code");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (used || req.method !== "GET" || "http://" + req.headers.host !== origin ||
      url.origin !== origin || url.pathname !== path || url.searchParams.size !== 1 ||
      !code || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) {
    res.writeHead(404).end();
    return;
  }
  used = true;
  // Only a read-only receipt travels to the browser. Flush the redirect before Buzz can stop this helper.
  res.writeHead(303, { Location: returnPage + "#" + receipt }).end(() => console.log(JSON.stringify(["code", code])));
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  origin = "http://127.0.0.1:" + server.address().port;
  console.log(JSON.stringify(["ready", origin + path, receipt]));
});
setTimeout(() => process.exit(1), 5 * 60_000).unref();
