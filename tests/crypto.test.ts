import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/crypto";

describe("content hashing", () => {
  it("hashes UTF-8 Markdown with SHA-256 hex", async () => {
    await expect(sha256Hex("你好, Ling\n")).resolves.toBe(
      "5949118057ea895e2c6cfbf6d3005f9da223a1d95ef70930dcdb452814da8570",
    );
  });
});
