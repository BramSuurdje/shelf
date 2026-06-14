import { redisStorage } from "@better-auth/redis-storage"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { createAccessControl } from "better-auth/plugins/access"
import { admin as adminPlugin, username } from "better-auth/plugins"
import Redis from "ioredis"

import { loadEnv } from "@shelf/config"
import { db } from "@shelf/db"
import { maintenanceQueue } from "@shelf/jobs"

const env = loadEnv()

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
})

const adminStatement = {
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "impersonate-admins",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
} as const

const accessControl = createAccessControl(adminStatement)
const ownerRole = accessControl.newRole({
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "impersonate-admins",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
})
const adminRole = accessControl.newRole({
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
})
const userRole = accessControl.newRole({
  user: [],
  session: [],
})

export const auth = betterAuth({
  baseURL: env.PUBLIC_APP_URL,
  basePath: "/api/v1/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  secondaryStorage: redisStorage({
    client: redis,
    keyPrefix: "shelf:auth:",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 10,
    sendResetPassword: async ({ user, url }) => {
      await maintenanceQueue.add("email.passwordReset", {
        to: user.email,
        subject: "Reset your Shelf password",
        text: `Reset your Shelf password with this link: ${url}`,
      })
    },
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
      ...additionalFields,
      id,
    }),
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await maintenanceQueue.add("email.verification", {
        to: user.email,
        subject: "Verify your Shelf email",
        text: `Verify your Shelf email with this link: ${url}`,
      })
    },
  },
  socialProviders: {
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          }
        : undefined,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          }
        : undefined,
  },
  user: {
    additionalFields: {
      usernameChangedAt: {
        type: "date",
        required: false,
        input: false,
      },
      storageQuotaBytes: {
        type: "number",
        required: false,
        input: false,
      },
      disabledAt: {
        type: "date",
        required: false,
        input: false,
      },
      onboardingCompletedAt: {
        type: "date",
        required: false,
        input: false,
      },
      preferences: {
        type: "json",
        required: false,
        input: false,
        defaultValue: {},
      },
    },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 32,
      usernameValidator: (value) => /^[a-z0-9_]{3,32}$/.test(value),
    }),
    adminPlugin({
      ac: accessControl,
      roles: {
        owner: ownerRole,
        admin: adminRole,
        user: userRole,
      },
      defaultRole: "user",
      adminRoles: ["owner", "admin"],
    }),
  ],
})

export type ShelfSession = typeof auth.$Infer.Session

export async function getSession(request: Request) {
  return auth.api.getSession({ headers: request.headers })
}

export async function requireSession(request: Request) {
  const session = await getSession(request)

  if (!session) {
    throw new Response("Unauthorized", { status: 401 })
  }

  if (session.user.disabledAt || session.user.banned) {
    throw new Response("Account disabled", { status: 403 })
  }

  return session
}

export async function requireAdmin(request: Request) {
  const session = await requireSession(request)
  if (session.user.role !== "owner" && session.user.role !== "admin") {
    throw new Response("Forbidden", { status: 403 })
  }
  return session
}

export async function requireOwner(request: Request) {
  const session = await requireSession(request)
  if (session.user.role !== "owner") {
    throw new Response("Forbidden", { status: 403 })
  }
  return session
}
