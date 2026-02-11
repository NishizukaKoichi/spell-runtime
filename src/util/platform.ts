export function detectHostPlatform(): string {
  return `${process.platform}/${process.arch}`;
}
