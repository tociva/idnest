import {
  hasVerifiedEmailAddress,
  normalizeEmailAddress,
  toUserClaims,
  type HydraConsentRequest,
  type KratosUserClaims,
  type KratosUser,
} from "@idnest/shared-types";
import { getHydraAdminUrl, getKratosAdminUrl } from "../config";
import { errorBody, type HandlerResult } from "./types";

export interface AcceptConsentInput {
  consent_challenge?: string;
}

export async function acceptConsent(input: AcceptConsentInput): Promise<HandlerResult> {
  try {
    const { consent_challenge } = input;
    if (!consent_challenge) {
      return { status: 400, body: { error: "Missing consent_challenge" } };
    }

    // 1. Get the consent request from Hydra (carries what the client requested).
    const consentRequestRes = await fetch(
      `${getHydraAdminUrl()}/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(
        consent_challenge,
      )}`,
    );
    if (!consentRequestRes.ok) {
      const err = await consentRequestRes
        .text()
        .catch(() => consentRequestRes.statusText);
      return { status: 500, body: { error: `Failed to fetch consent request: ${err}` } };
    }
    const consentRequest = (await consentRequestRes.json()) as HydraConsentRequest;

    // 2. Enrich token claims. New logins use verified email as the OAuth subject;
    // legacy sessions may still carry a Kratos identity id.
    let user: KratosUserClaims;
    const emailSubject = normalizeEmailAddress(consentRequest.subject);
    if (emailSubject) {
      user = {
        name: undefined,
        email: emailSubject,
        email_verified: true,
        picture: undefined,
      };
    } else {
      const kratosUserRes = await fetch(
        `${getKratosAdminUrl()}/identities/${encodeURIComponent(consentRequest.subject)}`,
      );
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
      user = toUserClaims(kratosUser);
    }

    // 3. Accept consent, granting ONLY what this client actually requested.
    //    Echoing requested_scope / requested_access_token_audience keeps each
    //    OAuth client's tokens correctly scoped and audience-isolated, which is
    //    essential once multiple apps share this Hydra.
    const hydraRes = await fetch(
      `${getHydraAdminUrl()}/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(
        consent_challenge,
      )}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_scope: consentRequest.requested_scope ?? [],
          grant_access_token_audience: consentRequest.requested_access_token_audience ?? [],
          remember: true,
          remember_for: 3600,
          session: { id_token: { user }, access_token: { user } },
        }),
      },
    );
    const data = (await hydraRes.json()) as { redirect_to?: string; error?: unknown };
    if (!hydraRes.ok) {
      return { status: 500, body: { error: data.error || data } };
    }

    return { status: 200, body: { redirect_to: data.redirect_to } };
  } catch (err: unknown) {
    console.error("Error accepting consent:", err);
    return { status: 500, body: errorBody(err) };
  }
}
