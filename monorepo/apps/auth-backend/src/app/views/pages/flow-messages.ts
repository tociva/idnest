import { esc } from "../escape";
import type { FlowMessage } from "./flow-controls";

export function renderFlowMessages(messages: FlowMessage[] = []): string {
  if (!messages.length) return "";

  return `<div class="flow-messages" role="status" aria-live="polite">
    ${messages
      .map((message) => `<div class="alert alert-${message.type}">${esc(message.text)}</div>`)
      .join("\n    ")}
  </div>`;
}
