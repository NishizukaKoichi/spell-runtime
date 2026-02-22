import { describe, expect, test } from "vitest";
import { listSpellVersions, parseMarketCatalog, searchMarketCatalog } from "../../src/optional/marketCatalog";

describe("optional market catalog", () => {
  test("searches by query and supports latest-only output", () => {
    const catalog = parseMarketCatalog(
      JSON.stringify({
        version: "v1",
        spells: [
          {
            id: "samples/call-webhook",
            version: "1.0.0",
            name: "Call Webhook",
            summary: "Send deploy webhook",
            publisher: "samples",
            risk: "low",
            source: "registry:samples/call-webhook@1.0.0",
            tags: ["webhook", "http"]
          },
          {
            id: "samples/call-webhook",
            version: "1.1.0",
            name: "Call Webhook",
            summary: "Send deploy webhook",
            publisher: "samples",
            risk: "low",
            source: "registry:samples/call-webhook@1.1.0",
            tags: ["webhook", "http"]
          },
          {
            id: "samples/publish-site",
            version: "1.0.0",
            name: "Publish Site",
            summary: "Deploy static site",
            publisher: "samples",
            risk: "high",
            source: "registry:samples/publish-site@1.0.0",
            tags: ["deploy"]
          }
        ]
      }),
      "inline"
    );

    const queried = searchMarketCatalog(catalog, { query: "webhook", latestOnly: true });
    expect(queried.map((entry) => `${entry.id}@${entry.version}`)).toEqual(["samples/call-webhook@1.1.0"]);

    const highRisk = searchMarketCatalog(catalog, { risk: "high" });
    expect(highRisk.map((entry) => entry.id)).toEqual(["samples/publish-site"]);
  });

  test("lists versions by semver-desc for one spell id", () => {
    const catalog = parseMarketCatalog(
      JSON.stringify({
        version: "v1",
        spells: [
          {
            id: "samples/repo-ops",
            version: "1.0.0",
            name: "Repo Ops",
            summary: "Repository operations",
            publisher: "samples",
            risk: "medium",
            source: "registry:samples/repo-ops@1.0.0",
            tags: []
          },
          {
            id: "samples/repo-ops",
            version: "1.2.0",
            name: "Repo Ops",
            summary: "Repository operations",
            publisher: "samples",
            risk: "medium",
            source: "registry:samples/repo-ops@1.2.0",
            tags: []
          }
        ]
      }),
      "inline"
    );

    const versions = listSpellVersions(catalog, "samples/repo-ops");
    expect(versions.map((entry) => entry.version)).toEqual(["1.2.0", "1.0.0"]);
  });
});
