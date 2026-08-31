import type { KratosFlow, PublicAuthContext } from "@idnest/shared-types";

export interface LoginFlowContextResponse {
  flow: KratosFlow;
  context: PublicAuthContext;
}

export interface LoginFlowRedirectResponse {
  redirectTo: string;
}

export type LoginFlowResponse = LoginFlowContextResponse | LoginFlowRedirectResponse;

export function isLoginFlowRedirectResponse(
  response: LoginFlowResponse,
): response is LoginFlowRedirectResponse {
  return "redirectTo" in response && typeof response.redirectTo === "string";
}
