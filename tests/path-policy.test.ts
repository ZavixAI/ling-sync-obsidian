import { describe, expect, it } from "vitest";

import {
  isHiddenVaultPath,
  isIncludedMarkdown,
  normalizeFolderPaths,
  normalizeVaultPath,
} from "../src/path-policy";

describe("Vault path policy", () => {
  it("normalizes Vault-relative POSIX paths", () => {
    expect(normalizeVaultPath("/Projects\\Ling/./note.md")).toBe(
      "Projects/Ling/note.md",
    );
    expect(() => normalizeVaultPath("../note.md")).toThrow("cannot contain");
  });

  it("uses [''] for the whole Vault and removes duplicates", () => {
    expect(normalizeFolderPaths([])).toEqual([""]);
    expect(normalizeFolderPaths(["", "Projects"])).toEqual([""]);
    expect(normalizeFolderPaths(["Projects/", "Projects"])).toEqual([
      "Projects",
    ]);
  });

  it("excludes the configured settings directory and every hidden directory", () => {
    expect(isHiddenVaultPath(".obsidian/plugins/test.md")).toBe(true);
    expect(isHiddenVaultPath("Settings/plugins/test.md", "Settings")).toBe(true);
    expect(isHiddenVaultPath("Settings-note.md", "Settings")).toBe(false);
    expect(isHiddenVaultPath("Archive/.trash/note.md")).toBe(true);
    expect(isHiddenVaultPath("Project/.git/COMMIT.md")).toBe(true);
    expect(isHiddenVaultPath("Project/.private/note.md")).toBe(true);
    expect(isHiddenVaultPath("Project/note.md")).toBe(false);
  });

  it("only includes Markdown under selected folders", () => {
    expect(isIncludedMarkdown("Projects/Ling/note.md", ["Projects/Ling"])).toBe(
      true,
    );
    expect(isIncludedMarkdown("Projects/Other/note.md", ["Projects/Ling"])).toBe(
      false,
    );
    expect(isIncludedMarkdown("Projects/Ling/image.png", ["Projects/Ling"])).toBe(
      false,
    );
    expect(isIncludedMarkdown(".hidden/note.md", [""])).toBe(false);
    expect(isIncludedMarkdown("Settings/plugins/note.md", [""], "Settings")).toBe(
      false,
    );
  });
});
