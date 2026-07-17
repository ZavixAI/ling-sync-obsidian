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

export function isHiddenVaultPath(path: string, configDir = ""): boolean {
  const segments = normalizeVaultPath(path).split("/");
  const parentSegments = segments.slice(0, -1);
  const parentPath = parentSegments.join("/");
  const normalizedConfigDir = normalizeVaultPath(configDir);
  const isInsideConfigDir =
    normalizedConfigDir.length > 0 &&
    (parentPath === normalizedConfigDir ||
      parentPath.startsWith(`${normalizedConfigDir}/`));
  return (
    isInsideConfigDir || parentSegments.some((segment) => segment.startsWith("."))
  );
}

export function isIncludedMarkdown(
  path: string,
  folderPaths: readonly string[],
  configDir = "",
): boolean {
  const normalizedPath = normalizeVaultPath(path);
  if (!normalizedPath.toLowerCase().endsWith(".md")) {
    return false;
  }
  if (isHiddenVaultPath(normalizedPath, configDir)) {
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
