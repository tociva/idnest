import { describe, expect, it } from "vitest";
import { isLoginFlowRedirectResponse, type LoginFlowResponse } from "./auth-flow-response";

describe("isLoginFlowRedirectResponse", () => {
  it("detects successful login redirect responses", () => {
    expect(isLoginFlowRedirectResponse({ redirectTo: "https://app.example/cb" })).toBe(true);
  });

  it("leaves renderable flow context responses alone", () => {
    const response = {
      flow: { id: "flow-1", ui: { action: "/self-service/login", method: "POST", nodes: [] } },
      context: {
        transactionId: "transaction-1",
        client: { id: "client-1", displayName: "Client" },
        recovery: { kind: "request_context_unavailable" },
        brand: {
          key: "brand",
          displayName: "Brand",
          legalName: "Brand LLC",
          productName: "Brand",
          primaryColor: "#000000",
          secondaryColor: "#111111",
          surfaceColor: "#ffffff",
          textColor: "#111111",
          mutedTextColor: "#555555",
          errorColor: "#b91c1c",
          borderRadius: "8px",
          fontFamily: "system",
          loginHeading: "Sign in",
          loginDescription: "Continue",
          registrationHeading: "Register",
          recoveryHeading: "Recover",
          consentHeading: "Consent",
          defaultLocale: "en",
        },
        policy: {
          passwordEnabled: false,
          passkeyEnabled: false,
          allowedOidcProviders: ["apple"],
          totpEnabled: false,
          minimumAal: "aal1",
          registrationMode: "enabled",
        },
        expiresAt: "2026-08-31T06:36:19.000Z",
      },
    } satisfies LoginFlowResponse;

    expect(isLoginFlowRedirectResponse(response)).toBe(false);
  });
});
