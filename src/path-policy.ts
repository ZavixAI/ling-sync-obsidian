const HIDDEN_SYSTEM_DIRECTORIES = new Set([".obsidian", ".trash", ".git"]);

export function normalizeVaultPath(path: string): string {
  const segments = path
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new Error("Vault paths cannot contain '..'.");
  }

  return segments.join("/");
}

export function normalizeFolderPaths(paths: readonly string[]): string[] {
  const normalized = [...new Set(paths.map(normalizeVaultPath))];
  if (normalized.length === 0 || normalized.includes("")) {
    return [""];
  }
  return normalized.sort();
}

export function isHiddenVaultPath(path: string): boolean {
  const segments = normalizeVaultPath(path).split("/");
  return segments
    .slice(0, -1)
    .some(
      (segment) =>
        segment.startsWith(".") || HIDDEN_SYSTEM_DIRECTORIES.has(segment),
    );
}

export function isIncludedMarkdown(
  path: string,
  folderPaths: readonly string[],
): boolean {
  const normalizedPath = normalizeVaultPath(path);
  if (!normalizedPath.toLowerCase().endsWith(".md")) {
    return false;
  }
  if (isHiddenVaultPath(normalizedPath)) {
    return false;
  }

  const normalizedFolders = normalizeFolderPaths(folderPaths);
  return normalizedFolders.some(
    (folder) =>
      folder === "" ||
      normalizedPath === folder ||
      normalizedPath.startsWith(`${folder}/`),
  );
}
