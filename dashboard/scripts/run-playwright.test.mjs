import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const status of [200, 404]) {
test(`browser tests refuse an occupied port even when the unrelated service returns HTTP ${status}`, { timeout: 60_000 }, async () => {
  let pageRequests = 0;
  const unrelated = createServer((request, response) => {
    if (request.url !== "/api/courses") pageRequests += 1;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ courses: [] }));
  });
  unrelated.listen(0, "127.0.0.1");
  await once(unrelated, "listening");
  const port = unrelated.address().port;
  const child = spawn(process.execPath, ["scripts/run-playwright.mjs", "--project=desktop", "--grep=homepage shows"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, LEARNING_LOOP_E2E_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  try {
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.match(output, /is already used/);
    assert.equal(pageRequests, 0, "no browser should visit the unrelated service");
  } finally {
    if (child.exitCode === null) child.kill();
    unrelated.closeAllConnections();
    await new Promise((resolve) => unrelated.close(resolve));
  }
});
}
