import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const candidate = path.join(root, "release-candidates/cockpit-r80-current-site-fixes-20260816-185001");
const manifest = JSON.parse(readFileSync(path.join(candidate, "manifest.json"), "utf8"));
const digest = (data) => ({ size: data.length, sha256: createHash("sha256").update(data).digest("hex") });

test("候选目录只包含发布器、manifest 和两个不可变资产", () => {
  assert.deepEqual(readdirSync(candidate).sort(), ["deploy.py", "manifest.json", "payload"]);
  const payload = path.join(candidate, "payload");
  assert.deepEqual(readdirSync(payload).sort(), manifest.assets.map((item) => item.path).sort());
  assert.equal(lstatSync(payload).isSymbolicLink(), false);
});

test("候选资产与冻结哈希完全一致", () => {
  for (const item of manifest.assets) {
    const data = readFileSync(path.join(candidate, "payload", item.path));
    assert.deepEqual(digest(data), { size: item.size, sha256: item.sha256 });
  }
});

test("当前公网入口与候选基线一致，增量结果可重现", async () => {
  const response = await fetch("https://firstcare.cloud/index.html", { headers: { "accept-encoding": "identity" } });
  assert.equal(response.status, 200);
  const baseline = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(digest(baseline), manifest.baselineIndex);
  let expected = baseline.toString("utf8");
  for (const insertion of manifest.indexInsertions) {
    assert.equal(expected.split(insertion.after).length - 1, 1);
    assert.equal(expected.includes(insertion.content), false);
    expected = expected.replace(insertion.after, insertion.after + insertion.content);
  }
  assert.deepEqual(digest(Buffer.from(expected)), manifest.expectedIndex);
  assert.ok(expected.indexOf("aph2-r80-current-site-fixes-20260816-v1.js") < expected.indexOf("cockpit-bundle-head-20260816.js"));
  assert.ok(expected.indexOf("cockpit-bundle-20260816.css") < expected.indexOf("aph2-r80-current-site-fixes-20260816-v1.css"));
});

test("发布器默认只校验，且不重启服务", () => {
  const source = readFileSync(path.join(candidate, "deploy.py"), "utf8");
  assert.match(source, /if not sys\.argv\[1:\]:\s*\n\s*result = verify_only\(\)/);
  assert.doesNotMatch(source, /systemctl\s+(?:restart|stop|start)/);
  assert.equal(manifest.restartService, false);
  assert.equal(manifest.databaseWrite, false);
});
