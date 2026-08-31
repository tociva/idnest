export function loginFlowErrorMessage(error: unknown): string {
  const status = httpStatusOf(error);
  if (status === 410) {
    return "This sign-in attempt is no longer active. Return to the application and try again.";
  }
  if (status === 400 || status === 404) {
    return "This sign-in request is invalid. Return to the application and try again.";
  }
  if (status === 0 || (status !== null && status >= 500)) {
    return "Authentication is temporarily unavailable. Please try again.";
  }
  return "This sign-in request could not be loaded. Return to the application and try again.";
}

function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}
