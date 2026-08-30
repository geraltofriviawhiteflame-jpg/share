export type ErrorKind =
  | "validation"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "unavailable";

/** Expected business failures that the HTTP adapter can safely expose. */
export class DomainError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const validation = (message: string): DomainError =>
  new DomainError("validation", message);

export const notFound = (message: string): DomainError =>
  new DomainError("not_found", message);

export const conflict = (message: string, cause?: unknown): DomainError =>
  new DomainError("conflict", message, cause);

export const forbidden = (message: string): DomainError =>
  new DomainError("forbidden", message);

export const unavailable = (message: string, cause?: unknown): DomainError =>
  new DomainError("unavailable", message, cause);
