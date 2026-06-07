// Demo file 3 of 3 — illustrates @prisma/client mistakes Nark catches.
//
// Prisma's errors come back as `PrismaClientKnownRequestError` with a code
// like `P2002` (unique constraint failure). Application code that doesn't
// distinguish these from generic errors ends up returning 500s for what
// should be 4xx user-correctable cases.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Creates a new user row at signup.
// VIOLATION (@prisma/client.error-4xx-5xx): no try/catch. A duplicate email
// throws Prisma's P2002 unique-constraint error. The caller sees a generic
// rejection and a 500 — the user sees "something went wrong" instead of
// "this email is already registered."
export async function createUser(email: string, name: string) {
  const user = await prisma.user.create({ data: { email, name } });
  return user;
}

// Looks up a user by email.
// VIOLATION (@prisma/client.error-4xx-5xx): no try/catch. findUnique can
// reject on connection-pool exhaustion, statement-timeout, or a transient
// network blip to the database. Without handling, a slow query during
// peak traffic crashes the request instead of returning a graceful 503.
export async function getUserByEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  return user;
}
