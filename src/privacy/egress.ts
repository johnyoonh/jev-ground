import type {
  AccessLevel,
  Evidence,
  Verification,
  Verifier,
  VerifyClaimInput,
} from "../types.js";
import { redactEvidence, type RedactOptions } from "./redact.js";

export function getEvidenceAccessLevel(item: Evidence): AccessLevel {
  if (item.access) return item.access;
  const metaAccess = item.metadata?.access ?? item.metadata?.sensitivity ?? item.metadata?.policy;
  if (typeof metaAccess === "string") {
    const lower = metaAccess.toLowerCase();
    if (lower === "restricted") return "restricted";
    if (lower === "sensitive") return "sensitive";
    if (lower === "public") return "public";
  }
  return "public";
}

export function getMaxAccessLevel(evidence: Evidence[]): AccessLevel {
  let maxLevel: AccessLevel = "public";
  for (const item of evidence) {
    const level = getEvidenceAccessLevel(item);
    if (level === "restricted") return "restricted";
    if (level === "sensitive") maxLevel = "sensitive";
  }
  return maxLevel;
}

export interface EgressHookContext {
  claim: string;
  evidence: Evidence[];
  verifier: Verifier;
  provider?: string;
  isLocal?: boolean;
}

export type EgressDecision =
  | { action: "allow" }
  | { action: "block"; reason?: string }
  | {
      action: "redact";
      redactOptions?: RedactOptions;
      transform?: (evidence: Evidence[]) => { evidence: Evidence[]; transformed: boolean };
    }
  | { action: "route-local"; localVerifier: Verifier };

export type EgressHook = (
  context: EgressHookContext,
) => EgressDecision | Promise<EgressDecision>;

export interface EgressControlVerifierOptions {
  /** Custom egress policy hook. */
  egressPolicy?: EgressHook;
  /** Explicitly configured local verifier for routing restricted/sensitive requests locally. */
  localVerifier?: Verifier;
  /** Default behavior for sensitive evidence when no egress hook handles it. Defaults to "block". */
  defaultSensitiveAction?: "block" | "allow" | "redact";
  /** Redaction options if automatic redaction is applied. */
  redactOptions?: RedactOptions;
}

export class EgressControlVerifier implements Verifier {
  readonly isLocal: boolean;
  readonly provider?: string;

  constructor(
    private readonly delegate: Verifier,
    private readonly options: EgressControlVerifierOptions = {},
  ) {
    this.isLocal = delegate.isLocal ?? false;
    this.provider = delegate.provider;
  }

  async verify(input: VerifyClaimInput): Promise<Verification> {
    const maxAccess = getMaxAccessLevel(input.evidence);
    const isLocal = this.isLocal;

    const context: EgressHookContext = {
      claim: input.claim,
      evidence: input.evidence,
      verifier: this.delegate,
      provider: this.provider,
      isLocal,
    };

    let decision: EgressDecision | undefined;

    if (this.options.egressPolicy) {
      decision = await this.options.egressPolicy(context);
    }

    if (!decision) {
      if (isLocal || maxAccess === "public") {
        decision = { action: "allow" };
      } else if (maxAccess === "restricted") {
        if (this.options.localVerifier) {
          decision = { action: "route-local", localVerifier: this.options.localVerifier };
        } else {
          decision = {
            action: "block",
            reason: `Restricted evidence [${input.evidence
              .filter((e) => getEvidenceAccessLevel(e) === "restricted")
              .map((e) => e.id)
              .join(", ")}] prohibited from remote egress.`,
          };
        }
      } else if (maxAccess === "sensitive") {
        const sensitiveAction = this.options.defaultSensitiveAction ?? "block";
        if (sensitiveAction === "allow") {
          decision = { action: "allow" };
        } else if (sensitiveAction === "redact") {
          decision = { action: "redact", redactOptions: this.options.redactOptions };
        } else if (this.options.localVerifier) {
          decision = { action: "route-local", localVerifier: this.options.localVerifier };
        } else {
          decision = {
            action: "block",
            reason: `Sensitive evidence [${input.evidence
              .filter((e) => getEvidenceAccessLevel(e) === "sensitive")
              .map((e) => e.id)
              .join(", ")}] prohibited from remote egress.`,
          };
        }
      } else {
        decision = { action: "allow" };
      }
    }

    if (decision.action === "block") {
      const reason = decision.reason ?? "Evidence egress blocked by privacy policy";
      return {
        claim: input.claim,
        verdict: "insufficient",
        probabilities: { supported: 0, contradicted: 0, insufficient: 1 },
        confidence: 0,
        evidenceIds: input.evidence.map((e) => e.id),
        provider: this.provider ?? "blocked",
        executionState: "BLOCKED",
        privacyBlockReason: reason,
      };
    }

    if (decision.action === "route-local") {
      const result = await decision.localVerifier.verify(input);
      return {
        ...result,
        executionState: result.executionState ?? "EXECUTED",
      };
    }

    let activeInput = input;
    let transformedEvidence = false;

    if (decision.action === "redact") {
      const redactResult = decision.transform
        ? decision.transform(input.evidence)
        : redactEvidence(input.evidence, decision.redactOptions ?? this.options.redactOptions);

      activeInput = {
        ...input,
        evidence: redactResult.evidence,
      };
      transformedEvidence = redactResult.transformed;
    }

    const result = await this.delegate.verify(activeInput);

    return {
      ...result,
      executionState: result.executionState ?? "EXECUTED",
      ...(transformedEvidence ? { transformedEvidence: true } : {}),
    };
  }
}
