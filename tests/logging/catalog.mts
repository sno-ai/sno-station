import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildLogCatalog } from "../../apps/mem-claw/scripts/build-log-catalog.ts";
import { resolveLogSite, validateLogCatalog } from "../../packages/utils/src/log-site-catalog.ts";

const path = "apps/example/src/request.ts";
const text = `class Request {
  constructor(private readonly value: string) {}
  async execute(): Promise<void> {
    await Promise.resolve();
    log.warn("Request failed", { outcome: "failed" }, {
      event_name: "request.failed", file: "apps/example/src/request.ts",
      function: "Request.execute", site_id: "request.execute.failed"
    });
  }
}
`;
const source = { event_name: "request.failed", file: path, function: "Request.execute", site_id: "request.execute.failed" };
const first = buildLogCatalog([{ path, text }]);
const site = first.sites[source.site_id];
assert.ok(site);
assert.equal(site.line, 5);
assert.equal(site.column, 5);
assert.equal(site.file_hash, createHash("sha256").update(text).digest("hex"));
validateLogCatalog(first, first.build_id);
assert.equal(resolveLogSite(source, first.build_id, first).catalog_status, "available");
const shifted = buildLogCatalog([{ path, text: "// Added source header\n\n" + text }]);
assert.equal(shifted.sites[source.site_id]?.line, 7);
assert.notEqual(shifted.build_id, first.build_id);
assert.notEqual(shifted.sites[source.site_id]?.file_hash, site.file_hash);
assert.throws(() => validateLogCatalog(first, shifted.build_id), /mismatch/);
assert.throws(() => buildLogCatalog([{ path, text }, { path, text }]), /Duplicate/);
assert.throws(() => buildLogCatalog([{ path: "apps/example/src/wrong.ts", text }]), /Wrong source/);
assert.throws(() => validateLogCatalog({ ...first, sites: { ...first.sites, corrupt: { ...site, line: 0 } } }, first.build_id), /Invalid/);
assert.equal(resolveLogSite({ ...source, function: "Wrong.operation" }, first.build_id, first).catalog_status, "unavailable");
assert.equal(resolveLogSite(source, shifted.build_id, first).catalog_status, "unavailable");
assert.equal(resolveLogSite({ ...source, site_id: "missing" }, first.build_id, first).catalog_status, "unavailable");
console.log(JSON.stringify({ passed: true, checks: 14, original_line: site.line, shifted_line: shifted.sites[source.site_id]?.line }));
