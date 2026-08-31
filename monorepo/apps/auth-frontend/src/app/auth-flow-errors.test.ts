import { describe, expect, it } from "vitest";
import { loginFlowErrorMessage } from "./auth-flow-errors";

describe("loginFlowErrorMessage", () => {
  it("maps stale transactions to a retry-from-application message", () => {
    expect(loginFlowErrorMessage({ status: 410 })).toBe(
      "This sign-in attempt is no longer active. Return to the application and try again.",
    );
  });

  it("maps invalid flow requests separately from stale flows", () => {
    expect(loginFlowErrorMessage({ status: 400 })).toBe(
      "This sign-in request is invalid. Return to the application and try again.",
    );
    expect(loginFlowErrorMessage({ status: 404 })).toBe(
      "This sign-in request is invalid. Return to the application and try again.",
    );
  });

  it("maps backend and network failures to temporary unavailable", () => {
    expect(loginFlowErrorMessage({ status: 502 })).toBe(
      "Authentication is temporarily unavailable. Please try again.",
    );
    expect(loginFlowErrorMessage({ status: 0 })).toBe(
      "Authentication is temporarily unavailable. Please try again.",
    );
  });
});
