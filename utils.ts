// Small helpers shared across the plugin runtime.

import type { ContentPart } from "./types";

export function textFromParts(parts: ContentPart[] = []): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}
