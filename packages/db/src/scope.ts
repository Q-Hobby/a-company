import type { Actor } from "@acompany/contracts";
import type { PrismaClient } from "./client.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const membership = await prisma.spaceMember.findFirst({
    where: {
      userId,
      ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
    },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    include: { member: { include: { user: true } } },
  });
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  return {
    userId: membership.userId,
    spaceId: membership.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: settings?.ownerUserId === membership.userId,
  };
}

/**
 * Single-workspace actor resolver used when running in accountless mode:
 * reuses the existing workspace owner (or creates the default workspace once)
 * so every request operates without login, sessions, or user credentials.
 */
export async function resolveDefaultActor(
  prisma: PrismaClient,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  let userId = settings?.ownerUserId ?? null;
  if (!userId) {
    const firstUser = await prisma.user.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    userId = firstUser?.id ?? null;
  }
  if (!userId) {
    const id = "default-workspace";
    const now = new Date();
    await prisma.user
      .create({
        data: {
          id,
          name: "A-Company",
          email: "workspace@a-company.local",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      })
      .catch(() => undefined);
    userId = id;
  }
  const existingSpace = await prisma.spaceMember.findFirst({
    where: { userId },
    select: { spaceId: true },
  });
  if (!existingSpace) {
    const { bootstrapUserSpace } = await import("./bootstrap-user.js");
    await bootstrapUserSpace(
      prisma,
      { id: userId },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
  }
  try {
    return await requireMembership(prisma, userId, requestedSpaceId);
  } catch {
    return await requireMembership(prisma, userId, null);
  }
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
