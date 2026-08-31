import {
  hasVerifiedEmailAddress,
  oauthSubjectForKratosUser,
  toUserClaims,
  type KratosUser,
} from "@idnest/shared-types";
import { getHydraAdminUrl, getKratosAdminUrl } from "../config";
import { errorBody, type HandlerResult } from "./types";

export interface AcceptLoginInput {
  login_challenge?: string;
  subject?: string;
}

export async function acceptLogin(input: AcceptLoginInput): Promise<HandlerResult> {
  const { login_challenge, subject } = input;

  // Phase 2 addition: guard the missing challenge (the open test TODO from the
  // original Next.js handler).
  if (!login_challenge) {
    return { status: 400, body: { error: "Missing login_challenge" } };
  }
  if (!subject) {
    return { status: 400, body: { error: "Missing subject" } };
  }

  try {
    const kratosUserRes = await fetch(`${getKratosAdminUrl()}/identities/${encodeURIComponent(subject)}`);
    if (!kratosUserRes.ok) {
      const err = (await kratosUserRes.json().catch(() => null)) as { error?: unknown } | null;
      return {
        status: 500,
        body: { error: err?.error || err || "Identity lookup failed" },
      };
    }
    const kratosUser = (await kratosUserRes.json()) as KratosUser;
    if (!hasVerifiedEmailAddress(kratosUser)) {
      return {
        status: 403,
        body: {
          error: "email_not_verified",
          error_description: "Please sign in with a provider account that has a verified email address.",
        },
      };
    }

    const hydraRes = await fetch(
      `${getHydraAdminUrl()}/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(
        login_challenge,
      )}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: oauthSubjectForKratosUser(kratosUser),
          remember: true,
          remember_for: 3600,
          acr: "aal1",
          context: { id_token: toUserClaims(kratosUser) },
        }),
      },
    );

    if (!hydraRes.ok) {
      const err = await hydraRes.text();
      return { status: 500, body: { error: "Hydra error: " + err } };
    }

    const data = (await hydraRes.json()) as { redirect_to?: string };
    return { status: 200, body: { redirect_to: data.redirect_to } };
  } catch (err: unknown) {
    console.error("Error accepting login:", err);
    return { status: 500, body: errorBody(err) };
  }
}
