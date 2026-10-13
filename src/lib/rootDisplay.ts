// Display only: preserve drive/filesystem roots and never use this as a path.
export function rootFolderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const drive = path.match(/^([a-zA-Z]:)[\\/]+$/);
  if (drive) return drive[1] + path[2];
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path[0];
}
