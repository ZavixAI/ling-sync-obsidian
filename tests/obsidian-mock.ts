import { vi } from "vitest";

export const requestUrl = vi.fn();

export function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "md";
  stat = { ctime: 0, mtime: 0, size: 0 };
}
