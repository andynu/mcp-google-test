import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { googleAuth, type GoogleClaims } from "./google-auth.js";

const app = express();
app.use(express.json());

// Health check (unauthenticated — Railway uses this)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Info endpoint so you can see what env vars are expected
app.get("/", (_req, res) => {
  res.json({
    name: "Stupid Example MCP Server with Google OAuth",
    mcp_endpoint: "/mcp",
    env_vars_needed: [
      "GOOGLE_CLIENT_ID — your Google OAuth 2.0 Client ID",
      "ADMIN_EMAILS    — comma-separated emails with admin access (optional)",
    ],
    access_control:
      "Only @wi.mit.edu accounts are accepted. " +
      "ADMIN_EMAILS get mcp-admins + mcp-users; all other wi.mit.edu users get mcp-users.",
    roles_used: [
      "mcp-users  — basic access to greeting and dice tools",
      "mcp-admins — access to admin tools (server info, echo)",
    ],
  });
});

/**
 * Build an McpServer instance scoped to the authenticated user.
 * Tools are registered based on the user's roles.
 */
function createMcpServerForUser(claims: GoogleClaims, roles: string[]) {
  const server = new McpServer({
    name: "stupid-example-mcp",
    version: "1.0.0",
  });

  const isUser = roles.includes("mcp-users") || roles.includes("mcp-admins");
  const isAdmin = roles.includes("mcp-admins");

  // --- Tools available to mcp-users ---

  if (isUser) {
    server.tool(
      "greet",
      "Say hello. Very advanced AI technology.",
      { name: z.string().describe("Who to greet") },
      async ({ name }) => ({
        content: [
          {
            type: "text" as const,
            text: `Hello, ${name}! You are authenticated as ${claims.email}. Wow.`,
          },
        ],
      })
    );

    server.tool(
      "roll_dice",
      "Roll some dice. Because every example needs dice.",
      {
        sides: z.number().min(2).max(100).default(6).describe("Number of sides"),
        count: z.number().min(1).max(20).default(1).describe("Number of dice"),
      },
      async ({ sides, count }) => {
        const rolls = Array.from({ length: count }, () =>
          Math.floor(Math.random() * sides) + 1
        );
        const total = rolls.reduce((a, b) => a + b, 0);
        return {
          content: [
            {
              type: "text" as const,
              text: `🎲 Rolled ${count}d${sides}: [${rolls.join(", ")}] = ${total}`,
            },
          ],
        };
      }
    );

    server.tool(
      "magic_8ball",
      "Ask the magic 8-ball a question. Guaranteed accurate.",
      { question: z.string().describe("Your yes/no question") },
      async ({ question }) => {
        const answers = [
          "It is certain.",
          "Without a doubt.",
          "Don't count on it.",
          "My reply is no.",
          "Ask again later.",
          "Cannot predict now.",
          "Outlook not so good.",
          "Signs point to yes.",
          "Better not tell you now.",
          "Concentrate and ask again.",
        ];
        const answer = answers[Math.floor(Math.random() * answers.length)]!;
        return {
          content: [
            {
              type: "text" as const,
              text: `🎱 Question: "${question}"\n   Answer: ${answer}`,
            },
          ],
        };
      }
    );
  }

  // --- Tools available to mcp-admins only ---

  if (isAdmin) {
    server.tool("server_info", "Get server info (admin only).", async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              node_version: process.version,
              uptime_seconds: Math.floor(process.uptime()),
              memory_mb: Math.floor(process.memoryUsage().rss / 1024 / 1024),
              user_email: claims.email,
              user_domain: claims.hd ?? "consumer account",
              user_roles: roles,
              env: {
                RAILWAY_ENVIRONMENT: process.env["RAILWAY_ENVIRONMENT"] ?? "unknown",
              },
            },
            null,
            2
          ),
        },
      ],
    }));

    server.tool(
      "echo",
      "Echo back whatever you send (admin only). For testing.",
      { message: z.string().describe("Message to echo back") },
      async ({ message }) => ({
        content: [{ type: "text" as const, text: `Echo: ${message}` }],
      })
    );
  }

  // If the user has no relevant roles, give them a single tool that tells them so
  if (!isUser && !isAdmin) {
    server.tool("access_denied", "You don't have access.", async () => ({
      content: [
        {
          type: "text" as const,
          text:
            `You are authenticated as ${claims.email}, but you don't have access. ` +
            `Only @wi.mit.edu accounts are accepted. ` +
            `Your domain: ${claims.hd ?? "consumer account"}.`,
        },
      ],
    }));
  }

  return server;
}

// MCP endpoint — protected by Google auth
app.post("/mcp", googleAuth, async (req, res) => {
  const claims = req.googleClaims!;
  const roles = req.userRoles ?? [];

  const server = createMcpServerForUser(claims, roles);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  // Pass auth info to transport so MCP SDK can access it
  (req as any).auth = { token: req.headers.authorization?.slice(7), clientId: claims.sub };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Also handle GET and DELETE for the MCP endpoint (spec compliance)
app.get("/mcp", googleAuth, async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

app.delete("/mcp", googleAuth, async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Stateless server, no sessions to delete." });
});

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on http://0.0.0.0:${PORT}`);
  console.log(`  Health: http://0.0.0.0:${PORT}/health`);
  console.log(`  MCP:    http://0.0.0.0:${PORT}/mcp`);
  console.log(`  GOOGLE_CLIENT_ID: ${process.env["GOOGLE_CLIENT_ID"] ? "(set)" : "(not set!)"}`);
});
