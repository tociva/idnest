import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptConsent } from "../handlers/accept-consent";
import { mockFetchByUrl } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const consentRequest = {
  subject: "kratos-id-1",
  requested_scope: ["openid", "email"],
  requested_access_token_audience: ["app-a"],
};
const identity = {
  id: "kratos-id-1",
  traits: { name: "Ada", email: "ada@example.com", picture: "p.png" },
  verifiable_addresses: [{ via: "email", value: "ada@example.com", verified: true }],
};

function happyPath() {
  return mockFetchByUrl([
    { match: "/requests/consent?", result: { ok: true, json: consentRequest } },
    { match: "/identities/", result: { ok: true, json: identity } },
    { match: "/consent/accept", result: { ok: true, json: { redirect_to: "https://app/cb" } } },
  ]);
}

describe("accept-consent", () => {
  it("returns redirect_to on success", async () => {
    happyPath();
    const res = await acceptConsent({ consent_challenge: "cc_1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redirect_to: "https://app/cb" });
  });

  it("(regression) grants exactly the requested_scope, not a hardcoded list", async () => {
    const fetchMock = happyPath();
    await acceptConsent({ consent_challenge: "cc_1" });
    const acceptCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/consent/accept"))!;
    const sent = JSON.parse((acceptCall[1] as RequestInit).body as string);
    expect(sent.grant_scope).toEqual(["openid", "email"]);
    expect(sent.grant_scope).not.toContain("offline_access");
  });

  it("(regression) grants exactly the requested_access_token_audience", async () => {
    const fetchMock = happyPath();
    await acceptConsent({ consent_challenge: "cc_1" });
    const acceptCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/consent/accept"))!;
    const sent = JSON.parse((acceptCall[1] as RequestInit).body as string);
    expect(sent.grant_access_token_audience).toEqual(["app-a"]);
  });

  it("maps Kratos traits into id_token and access_token", async () => {
    const fetchMock = happyPath();
    await acceptConsent({ consent_challenge: "cc_1" });
    const acceptCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/consent/accept"))!;
    const sent = JSON.parse((acceptCall[1] as RequestInit).body as string);
    const expected = { name: "Ada", email: "ada@example.com", email_verified: true, picture: "p.png" };
    expect(sent.session.id_token.user).toEqual(expected);
    expect(sent.session.access_token.user).toEqual(expected);
  });

  it("uses an email subject directly when login already normalized the OAuth subject", async () => {
    const fetchMock = mockFetchByUrl([
      {
        match: "/requests/consent?",
        result: {
          ok: true,
          json: {
            ...consentRequest,
            subject: "Ada@Example.COM",
          },
        },
      },
      { match: "/consent/accept", result: { ok: true, json: { redirect_to: "https://app/cb" } } },
    ]);

    const res = await acceptConsent({ consent_challenge: "cc_1" });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/identities/"))).toBe(false);
    const acceptCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/consent/accept"))!;
    const sent = JSON.parse((acceptCall[1] as RequestInit).body as string);
    expect(sent.session.id_token.user).toEqual({
      name: undefined,
      email: "ada@example.com",
      email_verified: true,
      picture: undefined,
    });
  });

  it("returns 400 when consent_challenge is missing", async () => {
    happyPath();
    const res = await acceptConsent({});
    expect(res.status).toBe(400);
  });

  it("returns 500 when the consent request lookup fails", async () => {
    mockFetchByUrl([{ match: "/requests/consent?", result: { ok: false, status: 500, text: "nope" } }]);
    const res = await acceptConsent({ consent_challenge: "cc_1" });
    expect(res.status).toBe(500);
  });

  it("returns 500 when the Kratos identity lookup fails", async () => {
    mockFetchByUrl([
      { match: "/requests/consent?", result: { ok: true, json: consentRequest } },
      { match: "/identities/", result: { ok: false, status: 404, json: { error: "not found" } } },
    ]);
    const res = await acceptConsent({ consent_challenge: "cc_1" });
    expect(res.status).toBe(500);
  });

  it("rejects consent before Hydra can issue tokens when the email is not verified", async () => {
    const fetchMock = mockFetchByUrl([
      { match: "/requests/consent?", result: { ok: true, json: consentRequest } },
      {
        match: "/identities/",
        result: {
          ok: true,
          json: {
            id: "kratos-id-1",
            traits: { email: "ada@example.com" },
            verifiable_addresses: [{ via: "email", value: "ada@example.com", verified: false }],
          },
        },
      },
    ]);

    const res = await acceptConsent({ consent_challenge: "cc_1" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "email_not_verified",
      error_description: "Please sign in with a provider account that has a verified email address.",
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/consent/accept"))).toBe(false);
  });

  it("returns error JSON when the Hydra accept fails", async () => {
    mockFetchByUrl([
      { match: "/requests/consent?", result: { ok: true, json: consentRequest } },
      { match: "/identities/", result: { ok: true, json: identity } },
      { match: "/consent/accept", result: { ok: false, status: 500, json: { error: "hydra-accept-failed" } } },
    ]);
    const res = await acceptConsent({ consent_challenge: "cc_1" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "hydra-accept-failed" });
  });
});
