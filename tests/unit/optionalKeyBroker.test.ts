import { describe, expect, test } from "vitest";
import { parseKeyBrokerStore, resolveConnectorToken } from "../../src/optional/keyBroker";

describe("optional key broker", () => {
  test("resolves connector token from tenant and falls back to default tenant", () => {
    const store = parseKeyBrokerStore(
      JSON.stringify({
        version: "v1",
        tenants: {
          default: {
            connectors: {
              github: { token: "gh-default", scopes: ["repo"] }
            }
          },
          team_a: {
            connectors: {
              cloudflare: { token: "cf-team-a", scopes: ["workers.write"] }
            }
          }
        }
      }),
      "inline"
    );

    const teamToken = resolveConnectorToken(store, { tenantId: "team_a", connector: "cloudflare" });
    expect(teamToken).toEqual({
      tenant_id: "team_a",
      connector: "cloudflare",
      token: "cf-team-a",
      scopes: ["workers.write"]
    });

    const fallbackToken = resolveConnectorToken(store, { tenantId: "team_a", connector: "github" });
    expect(fallbackToken).toEqual({
      tenant_id: "default",
      connector: "github",
      token: "gh-default",
      scopes: ["repo"]
    });
  });

  test("rejects invalid store shape", () => {
    expect(() =>
      parseKeyBrokerStore(
        JSON.stringify({
          version: "v1",
          tenants: {
            default: {
              connectors: {
                github: { token: "" }
              }
            }
          }
        }),
        "inline"
      )
    ).toThrow(/token must be non-empty/);
  });
});
