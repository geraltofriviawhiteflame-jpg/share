import { randomUUID } from "node:crypto";
import { SQLiteDatabase } from "../db/database";
import { conflict, validation } from "../domain/errors";

export interface CreateUserInput {
  email: string;
  displayName: string;
  timezone?: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
}

export class AccountService {
  public constructor(private readonly database: SQLiteDatabase) {}

  /**
   * This is a temporary bootstrap operation. Authentication should own account
   * creation once sessions and email verification are introduced.
   */
  public createUser(input: CreateUserInput): User {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const timezone = input.timezone?.trim() || "Asia/Kolkata";

    if (!email || !email.includes("@")) {
      throw validation("email must be a valid non-empty address");
    }
    if (!displayName) {
      throw validation("display_name is required");
    }

    const user: User = {
      id: randomUUID(),
      email,
      displayName,
      timezone,
    };
    try {
      this.database
        .prepare(`
          INSERT INTO users (id, email, display_name, timezone)
          VALUES (@id, @email, @displayName, @timezone)
        `)
        .run(user);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict("email is already registered", error);
      }
      throw error;
    }
    return user;
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
