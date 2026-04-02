import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Request, Response, NextFunction } from "express";

export interface GoogleClaims extends JWTPayload {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string; // Hosted domain (Google Workspace)
  name?: string;
  picture?: string;
}

// Augment Express Request to carry verified claims
declare global {
  namespace Express {
    interface Request {
      googleClaims?: GoogleClaims;
      userRoles?: string[];
    }
  }
}

const GOOGLE_CLIENT_ID = process.env["GOOGLE_CLIENT_ID"];
const DEV_BYPASS_AUTH = process.env["DEV_BYPASS_AUTH"] === "true";

// Only accept users from this domain
const ALLOWED_DOMAIN = "wi.mit.edu";

// Comma-separated list of emails that get admin access
const ADMIN_EMAILS = (process.env["ADMIN_EMAILS"] ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

if (DEV_BYPASS_AUTH) {
  console.warn(
    "WARNING: DEV_BYPASS_AUTH=true — auth is bypassed! " +
      "All requests get fake claims with admin roles."
  );
} else if (!GOOGLE_CLIENT_ID) {
  console.warn(
    "WARNING: GOOGLE_CLIENT_ID not set. Auth will reject all requests. " +
      "Set GOOGLE_CLIENT_ID to your Google OAuth 2.0 Client ID."
  );
}

// Google's OIDC JWKS endpoint
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const JWKS = createRemoteJWKSet(GOOGLE_JWKS_URL);

/**
 * Determine roles for a Google-authenticated user based on their email/domain.
 */
function resolveRoles(claims: GoogleClaims): string[] {
  const email = claims.email.toLowerCase();
  const domain = claims.hd?.toLowerCase();
  const roles: string[] = [];

  // Must be from the allowed domain
  if (domain !== ALLOWED_DOMAIN) {
    return roles;
  }

  // Check admin list first
  if (ADMIN_EMAILS.includes(email)) {
    roles.push("mcp-admins", "mcp-users");
    return roles;
  }

  // All wi.mit.edu users get mcp-users
  roles.push("mcp-users");
  return roles;
}

/**
 * Express middleware that validates Google OAuth ID tokens (Bearer tokens)
 * and attaches decoded claims + computed roles to the request.
 */
export async function googleAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Dev bypass: skip auth entirely, inject fake claims
  if (DEV_BYPASS_AUTH) {
    req.googleClaims = {
      sub: "dev-user-123",
      email: "dev-user@example.com",
      email_verified: true,
      hd: "example.com",
      name: "Dev User",
    };
    req.userRoles = ["mcp-users", "mcp-admins"];
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  if (!GOOGLE_CLIENT_ID) {
    res.status(500).json({ error: "GOOGLE_CLIENT_ID not configured" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: GOOGLE_CLIENT_ID,
    });

    const claims = payload as GoogleClaims;

    // Require verified email
    if (!claims.email_verified) {
      res.status(403).json({ error: "Email not verified" });
      return;
    }

    req.googleClaims = claims;
    req.userRoles = resolveRoles(claims);
    next();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Token verification failed";
    res.status(401).json({ error: message });
  }
}

/**
 * Check if the authenticated user has a specific role.
 */
export function hasRole(req: Request, role: string): boolean {
  return req.userRoles?.includes(role) ?? false;
}
