import type { Evidence } from "../types.js";

export interface RedactOptions {
  /** Custom regex patterns to redact with a replacement string or default [REDACTED]. */
  patterns?: RegExp[];
  /** Custom redaction function for evidence text. */
  customRedact?: (text: string) => string;
}

const DEFAULT_SENSITIVE_PATTERNS = [
  // SSN: e.g. 123-45-6789
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // Credit card: 13-19 digits with optional spaces or dashes
  /\b(?:\d[ -]*?){13,19}\b/g,
  // Common API key patterns like sk_live_..., key-..., etc.
  /\b(?:sk|pk|key|token|api_key|secret)_[a-zA-Z0-9_\-]{16,}\b/gi,
  // Standard Bearer tokens
  /Bearer\s+[a-zA-Z0-9_\-\.=]+/gi,
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

/**
 * Redacts sensitive fields (PII, tokens, secrets) from evidence items.
 * Returns the transformed evidence array along with a flag indicating whether transformation occurred.
 */
export function redactEvidence(
  evidence: Evidence[],
  options: RedactOptions = {},
): { evidence: Evidence[]; transformed: boolean } {
  let transformed = false;
  const patterns = options.patterns ?? DEFAULT_SENSITIVE_PATTERNS;

  const redactedList = evidence.map((item) => {
    let currentText = item.text;

    if (options.customRedact) {
      const newText = options.customRedact(currentText);
      if (newText !== currentText) {
        currentText = newText;
        transformed = true;
      }
    }

    for (const pattern of patterns) {
      // Create a clean regex instance with global flag
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      if (re.test(currentText)) {
        currentText = currentText.replace(re, "[REDACTED]");
        transformed = true;
      }
    }

    if (currentText !== item.text) {
      return {
        ...item,
        text: currentText,
        metadata: {
          ...item.metadata,
          redacted: true,
          originalLabelEquivalent: false,
        },
      };
    }

    return item;
  });

  return {
    evidence: redactedList,
    transformed,
  };
}
