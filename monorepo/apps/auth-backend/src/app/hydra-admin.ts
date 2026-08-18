import {
  isHydraConsentRequest,
  isHydraLoginRequest,
  isHydraRedirectResponse,
  type HydraConsentRequest,
  type HydraClient,
  type HydraLoginRequest,
  type KratosUserClaims,
} from "@idnest/shared-types";
import { getHydraAdminUrl } from "./config";

function endpoint(path: string, challengeName: string, challenge: string): string {
  const base = getHydraAdminUrl().replace(/\/+$/, "");
  return `${base}${path}?${challengeName}=${encodeURIComponent(challenge)}`;
}

export async function getHydraClient(clientId: string): Promise<HydraClient> {
  const base = getHydraAdminUrl().replace(/\/+$/, "");
  const response = await fetch(`${base}/admin/clients/${encodeURIComponent(clientId)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Hydra client lookup failed (${response.status}): ${await errorText(response)}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || (body as { client_id?: unknown }).client_id !== clientId) {
    throw new Error("Hydra returned an invalid OAuth client");
  }
  return body as HydraClient;
}

async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body.slice(0, 500) || response.statusText;
}

export async function getHydraLoginRequest(challenge: string): Promise<HydraLoginRequest> {
  const response = await fetch(
    endpoint("/oauth2/auth/requests/login", "login_challenge", challenge),
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Hydra login request failed (${response.status}): ${await errorText(response)}`);
  const body: unknown = await response.json();
  if (!isHydraLoginRequest(body)) throw new Error("Hydra returned an invalid login request");
  return { ...body, challenge: body.challenge || challenge };
}

export async function acceptHydraLogin(
  challenge: string,
  input: {
    subject: string;
    acr: string;
    amr: string[];
    claims: KratosUserClaims;
    rememberFor: number;
    transactionId: string;
  },
): Promise<string> {
  const response = await fetch(
    endpoint("/oauth2/auth/requests/login/accept", "login_challenge", challenge),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        subject: input.subject,
        remember: true,
        remember_for: input.rememberFor,
        acr: input.acr,
        amr: input.amr,
        context: {
          auth_transaction_id: input.transactionId,
          id_token: input.claims,
        },
      }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isHydraRedirectResponse(body)) {
    throw new Error(`Hydra login acceptance failed (${response.status})`);
  }
  return body.redirect_to;
}

export async function rejectHydraLogin(
  challenge: string,
  error: string,
  description: string,
): Promise<string> {
  const response = await fetch(
    endpoint("/oauth2/auth/requests/login/reject", "login_challenge", challenge),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ error, error_description: description }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isHydraRedirectResponse(body)) {
    throw new Error(`Hydra login rejection failed (${response.status})`);
  }
  return body.redirect_to;
}

export async function getHydraConsentRequest(challenge: string): Promise<HydraConsentRequest> {
  const response = await fetch(
    endpoint("/oauth2/auth/requests/consent", "consent_challenge", challenge),
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Hydra consent request failed (${response.status}): ${await errorText(response)}`);
  const body: unknown = await response.json();
  if (!isHydraConsentRequest(body)) throw new Error("Hydra returned an invalid consent request");
  return { ...body, challenge: body.challenge || challenge };
}

export async function acceptHydraConsent(
  challenge: string,
  input: {
    scopes: string[];
    audiences: string[];
    claims: KratosUserClaims;
    rememberFor: number;
  },
): Promise<string> {
  const response = await fetch(
    endpoint("/oauth2/auth/requests/consent/accept", "consent_challenge", challenge),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_scope: input.scopes,
        grant_access_token_audience: input.audiences,
        remember: true,
        remember_for: input.rememberFor,
        session: {
          id_token: { user: input.claims },
          access_token: { user: input.claims },
        },
      }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isHydraRedirectResponse(body)) {
    throw new Error(`Hydra consent acceptance failed (${response.status})`);
  }
  return body.redirect_to;
}

export async function rejectHydraConsent(challenge: string, description: string): Promise<string> {
  const response = await fetch(
    endpoint("/oauth2/auth/requests/consent/reject", "consent_challenge", challenge),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ error: "access_denied", error_description: description }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isHydraRedirectResponse(body)) {
    throw new Error(`Hydra consent rejection failed (${response.status})`);
  }
  return body.redirect_to;
}
