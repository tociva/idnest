import { getHydraAdminUrl } from "./config";

interface HydraIntrospection {
  active?: boolean;
  client_id?: string;
  scope?: string | string[];
  aud?: string | string[];
  audience?: string | string[];
  token_use?: string;
  token_type?: string;
}

export interface DelegationServicePrincipal {
  clientId: string;
  scopes: string[];
  audiences: string[];
}

function stringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

export async function introspectDelegationServiceToken(
  accessToken: string,
): Promise<DelegationServicePrincipal | null> {
  const response = await fetch(
    `${getHydraAdminUrl().replace(/\/+$/, "")}/admin/oauth2/introspect`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: accessToken }),
    },
  );
  if (!response.ok) throw new Error(`Hydra token introspection failed (${response.status})`);
  const token = (await response.json()) as HydraIntrospection;
  const tokenUse = (token.token_use ?? token.token_type ?? "access_token").toLowerCase();
  if (
    !token.active ||
    !token.client_id ||
    (tokenUse !== "access_token" && tokenUse !== "bearer")
  ) {
    return null;
  }
  return {
    clientId: token.client_id,
    scopes: stringList(token.scope),
    audiences: stringList(token.aud ?? token.audience),
  };
}
