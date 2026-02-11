export function toIdKey(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function sanitizeIdForFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
