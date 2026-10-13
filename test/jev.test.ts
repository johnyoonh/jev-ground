import { describe, expect, it } from "vitest";
import { JevVerifier } from "../src/providers/jev.js";

describe("JevVerifier", () => {
  it("can be instantiated without TYPESAFE_API_KEY environment variable", () => {
    const originalApiKey = process.env.TYPESAFE_API_KEY;
    try {
      delete process.env.TYPESAFE_API_KEY;
      const verifier = new JevVerifier();
      expect(verifier).toBeInstanceOf(JevVerifier);
    } finally {
      if (originalApiKey !== undefined) {
        process.env.TYPESAFE_API_KEY = originalApiKey;
      }
    }
  });

  it("accepts custom apiKey option", () => {
    const verifier = new JevVerifier({ apiKey: "test_key" });
    expect(verifier).toBeInstanceOf(JevVerifier);
  });
});
