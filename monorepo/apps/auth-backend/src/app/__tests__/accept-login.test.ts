import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptLogin } from "../handlers/accept-login";
import { mockFetchByUrl } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const identity = {
  id: "kratos-id-1",
  traits: { name: "Ada", email: "ada@example.com", picture: "p.png" },
  verifiable_addresses: [{ via: "email", value: "ada@example.com", verified: true }],
};

function happyPath() {
  return mockFetchByUrl([
    { match: "/identities/", result: { ok: true, json: identity } },
    { match: "/login/accept", result: { ok: true, json: { redirect_to: "https://app/cb" } } },
  ]);
}

describe("accept-login", () => {
  it("returns redirect_to on a valid login_challenge + subject", async () => {
    happyPath();
    const res = await acceptLogin({ login_challenge: "lc_1", subject: "kratos-id-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redirect_to: "https://app/cb" });
  });

  it("sends remember, acr: aal1, and verified identity claims in the PUT body", async () => {
    const fetchMock = happyPath();
    await acceptLogin({ login_challenge: "lc_1", subject: "kratos-id-1" });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/login/accept"))!;
    const sent = JSON.parse((call[1] as RequestInit).body as string);
    expect(sent.subject).toBe("ada@example.com");
    expect(sent.remember).toBe(true);
    expect(sent.acr).toBe("aal1");
    expect(sent.context.id_token).toEqual({
      name: "Ada",
      email: "ada@example.com",
      email_verified: true,
      picture: "p.png",
    });
  });

  it("returns 500 with the Hydra error text when Hydra responds non-OK", async () => {
    mockFetchByUrl([
      { match: "/identities/", result: { ok: true, json: identity } },
      { match: "/login/accept", result: { ok: false, status: 500, text: "boom" } },
    ]);
    const res = await acceptLogin({ login_challenge: "lc_1", subject: "s" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Hydra error: boom" });
  });

  it("returns 400 when login_challenge is missing", async () => {
    mockFetchByUrl([]);
    const res = await acceptLogin({ subject: "s" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when subject is missing", async () => {
    mockFetchByUrl([]);
    const res = await acceptLogin({ login_challenge: "lc_1" });
    expect(res.status).toBe(400);
  });

  it("rejects before Hydra accept when the email is not verified", async () => {
    const fetchMock = mockFetchByUrl([
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

    const res = await acceptLogin({ login_challenge: "lc_1", subject: "kratos-id-1" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "email_not_verified",
      error_description: "Please sign in with a provider account that has a verified email address.",
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/login/accept"))).toBe(false);
  });

  it("surfaces network/fetch failure as a JSON error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const res = await acceptLogin({ login_challenge: "lc_1", subject: "s" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "network down" });
  });
});
