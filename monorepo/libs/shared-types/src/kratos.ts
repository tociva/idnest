/**
 * Kratos identity types + runtime guards shared by the auth backend and
 * frontend. Ported from the original Next.js app's
 * `src/app/util/types/kratos-user.type.ts`.
 */

export interface KratosTraits {
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface KratosVerifiableAddress {
  via?: string;
  value?: string;
  verified?: boolean;
  [key: string]: unknown;
}

export interface KratosUser {
  id: string;
  traits: KratosTraits;
  verifiable_addresses?: KratosVerifiableAddress[];
  [key: string]: unknown;
}

/** The subset of token claims we enrich from a Kratos identity's traits. */
export interface KratosUserClaims {
  name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

export interface KratosUiNodeAttributes {
  name?: string;
  value?: unknown;
  type?: string;
  disabled?: boolean;
  required?: boolean;
  autocomplete?: string;
  href?: string;
  id?: string;
  node_type?: string;
  [key: string]: unknown;
}

export interface KratosUiText {
  id?: number;
  text: string;
  type?: "info" | "error" | "success";
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface KratosUiNodeMeta {
  label?: KratosUiText;
  [key: string]: unknown;
}

export interface KratosUiNode {
  type: string;
  group: string;
  attributes: KratosUiNodeAttributes;
  meta?: KratosUiNodeMeta;
  messages?: KratosUiText[];
  [key: string]: unknown;
}

/** A Kratos self-service flow (login/registration/etc.) with its UI nodes. */
export interface KratosFlow {
  id: string;
  ui: {
    action: string;
    method: string;
    nodes: KratosUiNode[];
    messages?: KratosUiText[];
    [key: string]: unknown;
  };
  expires_at?: string;
  issued_at?: string;
  request_url?: string;
  return_to?: string;
  state?: string;
  [key: string]: unknown;
}

export interface KratosAuthenticationMethod {
  method: string;
  aal: string;
  completed_at: string;
  provider?: string;
  organization?: string;
}

export interface KratosSession {
  id: string;
  active: boolean;
  expires_at?: string;
  authenticated_at?: string;
  authenticator_assurance_level?: string;
  authentication_methods?: KratosAuthenticationMethod[];
  identity: KratosUser;
  [key: string]: unknown;
}

/**
 * Browser self-service flows require the `csrf_token` from the flow's UI nodes
 * to be submitted back. Returns the token, or null if the flow has none.
 */
export function getCsrfToken(flow: Pick<KratosFlow, "ui"> | null | undefined): string | null {
  const nodes = flow?.ui?.nodes ?? [];
  const node = nodes.find((n) => n.attributes?.name === "csrf_token");
  const value = node?.attributes?.value;
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || /\s/.test(email)) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  return email;
}

/**
 * Runtime guard: a value is a Kratos identity when it has a string `id` and an
 * object `traits`. Extra fields are allowed (Kratos returns far more).
 */
export function isKratosUser(value: unknown): value is KratosUser {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (!isRecord(value.traits)) return false;
  return true;
}

/** True when the identity's current email trait is verified in Kratos. */
export function hasVerifiedEmailAddress(user: KratosUser): boolean {
  return verifiedEmailAddress(user) !== null;
}

export function verifiedEmailAddress(user: KratosUser): string | null {
  const normalizedEmail = normalizeEmailAddress(user.traits.email);
  if (!normalizedEmail) return null;
  const verified = (user.verifiable_addresses ?? []).some(
    (address) =>
      address.via === "email" &&
      normalizeEmailAddress(address.value) === normalizedEmail &&
      address.verified === true,
  );
  return verified ? normalizedEmail : null;
}

export function oauthSubjectForKratosUser(user: KratosUser): string {
  return verifiedEmailAddress(user) ?? user.id;
}

/** Project a Kratos identity's traits into the claims we embed in tokens. */
export function toUserClaims(user: KratosUser): KratosUserClaims {
  const email = verifiedEmailAddress(user) ?? user.traits?.email;
  return {
    name: user.traits?.name,
    email,
    email_verified: typeof email === "string" ? hasVerifiedEmailAddress(user) : undefined,
    picture: user.traits?.picture,
  };
}
