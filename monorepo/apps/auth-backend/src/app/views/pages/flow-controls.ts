import type { KratosFlow, KratosUiNode } from "@idnest/shared-types";

export interface FlowHiddenInput {
  name: string;
  value: string;
}

export interface FlowSubmitButton {
  name: string;
  value: string;
  provider: string;
  label: string;
  disabled: boolean;
}

export interface FlowMessage {
  text: string;
  type: "info" | "error" | "success";
}

export type FactorSettingsNode =
  | { kind: "text"; text: string; messageType?: string }
  | { kind: "img"; src: string; alt: string }
  | {
      kind: "input";
      name: string;
      value: string;
      inputType: string;
      label: string;
      required: boolean;
      disabled: boolean;
    }
  | {
      kind: "submit";
      name: string;
      value: string;
      label: string;
      disabled: boolean;
    };

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function providerName(value: string): string {
  if (!value) return "provider";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buttonLabel(node: KratosUiNode, provider: string, fallbackVerb: string): string {
  const label = node.meta?.label?.text;
  if (typeof label === "string" && label.trim()) return label;
  return `${fallbackVerb} ${providerName(provider)}`;
}

export function hiddenInputsFromFlow(flow: Pick<KratosFlow, "ui">): FlowHiddenInput[] {
  return flow.ui.nodes
    .filter((node) => node.type === "input" && node.attributes.type === "hidden")
    .map((node) => ({ name: node.attributes.name, value: stringValue(node.attributes.value) }))
    .filter((input): input is FlowHiddenInput => typeof input.name === "string" && input.name.length > 0);
}

export function oidcSubmitButtonsFromFlow(
  flow: Pick<KratosFlow, "ui">,
  fallbackVerb: string,
): FlowSubmitButton[] {
  return flow.ui.nodes
    .filter((node) => node.group === "oidc" && node.type === "input" && node.attributes.type === "submit")
    .map((node) => {
      const name = node.attributes.name;
      const value = stringValue(node.attributes.value);
      if (typeof name !== "string" || !name || !value) return null;
      return {
        name,
        value,
        provider: value,
        label: buttonLabel(node, value, fallbackVerb),
        disabled: node.attributes.disabled === true,
      };
    })
    .filter((button): button is FlowSubmitButton => button !== null);
}

/** User-facing guidance and errors returned by Kratos for the current flow. */
export function messagesFromFlow(flow: Pick<KratosFlow, "ui">): FlowMessage[] {
  const candidates = [...(flow.ui.messages ?? []), ...flow.ui.nodes.flatMap((node) => node.messages ?? [])];
  const seen = new Set<string>();
  const messages: FlowMessage[] = [];

  for (const candidate of candidates) {
    const message = candidate.text?.trim();
    if (!message) continue;
    const type = candidate.type === "error" || candidate.type === "success" ? candidate.type : "info";
    const key = `${type}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({ text: message, type });
  }

  return messages;
}

/** TOTP / lookup-secret nodes from a Kratos settings flow for enrollment UI. */
export function factorSettingsNodesFromFlow(flow: Pick<KratosFlow, "ui">): FactorSettingsNode[] {
  const nodes: FactorSettingsNode[] = [];
  for (const node of flow.ui.nodes) {
    if (node.group !== "totp" && node.group !== "lookup_secret") continue;

    if (node.type === "text") {
      const text = node.meta?.label?.text || node.attributes.value;
      if (typeof text === "string" && text.trim()) {
        nodes.push({ kind: "text", text, messageType: node.messages?.[0]?.type });
      }
      continue;
    }

    if (node.type === "img") {
      const src = typeof node.attributes.src === "string" ? node.attributes.src : "";
      if (!src) continue;
      const alt =
        (typeof node.meta?.label?.text === "string" && node.meta.label.text) ||
        "Authenticator QR code";
      nodes.push({ kind: "img", src, alt });
      continue;
    }

    if (node.type !== "input") continue;
    const name = node.attributes.name;
    if (typeof name !== "string" || !name) continue;
    const value = stringValue(node.attributes.value);
    const label =
      (typeof node.meta?.label?.text === "string" && node.meta.label.text) || name;
    if (node.attributes.type === "hidden") continue;
    if (node.attributes.type === "submit") {
      nodes.push({
        kind: "submit",
        name,
        value: value || "true",
        label,
        disabled: node.attributes.disabled === true,
      });
      continue;
    }
    nodes.push({
      kind: "input",
      name,
      value,
      inputType:
        node.attributes.type === "password" || node.attributes.type === "text"
          ? String(node.attributes.type)
          : "text",
      label,
      required: node.attributes.required === true,
      disabled: node.attributes.disabled === true,
    });
  }
  return nodes;
}
