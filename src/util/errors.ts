export class SpellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpellError";
  }
}
