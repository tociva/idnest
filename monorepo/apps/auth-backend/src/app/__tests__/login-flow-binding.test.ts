import { describe, expect, it } from "vitest";
import type { KratosFlow } from "@idnest/shared-types";
import {
  KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
  classifyLoginFlowBinding,
  isSettingsPrivilegedReauthFlow,
  settingsResumeUrlFromFlow,
  transactionTokenFromFlow,
} from "../login-flow-binding";

const authBase = "https://auth-local.idnest.cloud";
const kratosPublic = "https://kratos-local.idnest.cloud";

function flow(overrides: Partial<KratosFlow> = {}): KratosFlow {
  return {
    id: "flow-1",
    ui: { action: `${kratosPublic}/self-service/login?flow=flow-1`, method: "POST", nodes: [] },
    ...overrides,
  };
}

describe("login-flow-binding", () => {
  it("extracts OAuth transaction tokens from completion return_to", () => {
    expect(
      transactionTokenFromFlow(
        flow({
          return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
        }),
        authBase,
      ),
    ).toBe("tok-123");
  });

  it("detects privileged settings reauth from Kratos settings return_to", () => {
    const settingsReauth = flow({
      request_url: `${kratosPublic}/self-service/login/browser?refresh=true&return_to=${encodeURIComponent(
        `${kratosPublic}/self-service/settings?flow=settings-1`,
      )}`,
    });
    expect(
      isSettingsPrivilegedReauthFlow(settingsReauth, {
        authBaseUrl: authBase,
        kratosPublicUrl: kratosPublic,
      }),
    ).toBe(true);
    expect(
      settingsResumeUrlFromFlow(settingsReauth, {
        authBaseUrl: authBase,
        kratosPublicUrl: kratosPublic,
      }),
    ).toBe(`${kratosPublic}/self-service/settings?flow=settings-1`);
  });

  it("detects privileged settings reauth from auth settings return_to", () => {
    const settingsReauth = flow({
      return_to: `${authBase}/settings?return_to=${encodeURIComponent(`${authBase}/oauth2/login/complete?transaction=tok`)}`,
    });
    expect(
      isSettingsPrivilegedReauthFlow(settingsReauth, {
        authBaseUrl: authBase,
        kratosPublicUrl: kratosPublic,
      }),
    ).toBe(true);
    expect(transactionTokenFromFlow(settingsReauth, authBase)).toBeNull();
  });

  it("does not treat OAuth completion flows as settings reauth", () => {
    const oauth = flow({
      return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
    });
    expect(
      isSettingsPrivilegedReauthFlow(oauth, {
        authBaseUrl: authBase,
        kratosPublicUrl: kratosPublic,
      }),
    ).toBe(false);
  });

  it("classifies structured Kratos account-link successor login flows", () => {
    const successor = flow({
      issued_at: "2026-08-31T06:26:19.000Z",
      expires_at: "2026-08-31T06:36:19.000Z",
      return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
      ui: {
        action: `${kratosPublic}/self-service/login?flow=flow-1`,
        method: "POST",
        nodes: [],
        messages: [
          {
            id: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
            type: "info",
            text: "Sign in to link your account.",
            context: {
              provider: "apple",
              duplicateIdentifier: "Ada@Example.COM",
            },
          },
        ],
      },
    });

    expect(
      classifyLoginFlowBinding(successor, authBase, {
        now: Date.parse("2026-08-31T06:26:20.000Z"),
      }),
    ).toEqual({
      reason: "account-link-recovery",
      issuedAt: "2026-08-31T06:26:19.000Z",
      kratosMessageId: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
      accountLink: {
        provider: "apple",
        duplicateEmail: "ada@example.com",
      },
    });
  });

  it("does not classify account-link successors when the duplicate identifier is not an email", () => {
    const successor = flow({
      issued_at: "2026-08-31T06:26:19.000Z",
      expires_at: "2026-08-31T06:36:19.000Z",
      return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
      ui: {
        action: `${kratosPublic}/self-service/login?flow=flow-1`,
        method: "POST",
        nodes: [],
        messages: [
          {
            id: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
            type: "info",
            text: "Sign in to link your account.",
            context: {
              provider: "apple",
              duplicateIdentifier: "opaque-identifier",
            },
          },
        ],
      },
    });

    expect(
      classifyLoginFlowBinding(successor, authBase, {
        now: Date.parse("2026-08-31T06:26:20.000Z"),
      }),
    ).toEqual({ reason: "initial", issuedAt: "2026-08-31T06:26:19.000Z" });
  });

  it("does not classify account-link successors by message id alone", () => {
    const successor = flow({
      issued_at: "2026-08-31T06:26:19.000Z",
      expires_at: "2026-08-31T06:36:19.000Z",
      return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
      ui: {
        action: `${kratosPublic}/self-service/login?flow=flow-1`,
        method: "POST",
        nodes: [],
        messages: [
          {
            id: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
            type: "info",
            text: "Sign in to link your account.",
          },
        ],
      },
    });

    expect(
      classifyLoginFlowBinding(successor, authBase, {
        now: Date.parse("2026-08-31T06:26:20.000Z"),
      }),
    ).toEqual({ reason: "initial", issuedAt: "2026-08-31T06:26:19.000Z" });
  });

  it("requires account-link successor flows to still be alive", () => {
    const expired = flow({
      issued_at: "2026-08-31T06:26:19.000Z",
      expires_at: "2026-08-31T06:26:20.000Z",
      return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
      ui: {
        action: `${kratosPublic}/self-service/login?flow=flow-1`,
        method: "POST",
        nodes: [],
        messages: [
          {
            id: KRATOS_ACCOUNT_LINK_LOGIN_MESSAGE_ID,
            type: "info",
            text: "Sign in to link your account.",
            context: {
              provider: "apple",
              duplicate_identifier: "ada@example.com",
            },
          },
        ],
      },
    });

    expect(
      classifyLoginFlowBinding(expired, authBase, {
        now: Date.parse("2026-08-31T06:26:21.000Z"),
      }),
    ).toEqual({ reason: "initial", issuedAt: "2026-08-31T06:26:19.000Z" });
  });

  it("classifies AAL2 step-up flows explicitly", () => {
    const aal2 = flow({
      issued_at: "2026-08-31T06:26:19.000Z",
      expires_at: "2026-08-31T06:36:19.000Z",
      request_url: `${kratosPublic}/self-service/login/browser?aal=aal2`,
      return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
    });

    expect(classifyLoginFlowBinding(aal2, authBase)).toEqual({
      reason: "aal2-step-up",
      issuedAt: "2026-08-31T06:26:19.000Z",
    });
  });

  it("refuses to bind login flows without a valid issued_at timestamp", () => {
    expect(
      classifyLoginFlowBinding(
        flow({
          return_to: `${authBase}/oauth2/login/complete?transaction=tok-123`,
        }),
        authBase,
      ),
    ).toBeNull();
  });
});
