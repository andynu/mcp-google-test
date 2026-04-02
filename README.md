# mcp-google-test

A dumb example MCP server that authenticates via Google OAuth and gates tool access by email/domain. Deployed on Railway.

Uses the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) MCP transport in stateless mode -- each request is independently authenticated and gets its own server instance.

## MCP Tools

Tools are registered per-request based on the authenticated user's role (derived from their email/domain).

### `mcp-users` role (also available to `mcp-admins`)

| Tool | Description | Parameters |
|------|-------------|------------|
| `greet` | Says hello. Tells you your authenticated identity. | `name` (string) |
| `roll_dice` | Rolls dice. | `sides` (number, 2-100, default 6), `count` (number, 1-20, default 1) |
| `magic_8ball` | Answers yes/no questions with guaranteed accuracy. | `question` (string) |

### `mcp-admins` role only

| Tool | Description | Parameters |
|------|-------------|------------|
| `server_info` | Returns node version, uptime, memory usage, your roles, Railway env. | (none) |
| `echo` | Echoes back whatever you send. | `message` (string) |

### No matching roles

If you authenticate successfully but don't match any allow-list, you get a single `access_denied` tool that tells you why.

## Access Control

Only `@wi.mit.edu` Google Workspace accounts are accepted. The `hd` (hosted domain) claim in the Google ID token is checked.

- **`ADMIN_EMAILS`** — comma-separated emails that get `mcp-admins` + `mcp-users` roles
- All other `@wi.mit.edu` users get `mcp-users` role
- Users from other domains (or consumer Gmail accounts) get `access_denied`

## Railway Deployment

### 1. Connect the repo

- Go to [railway.com](https://railway.com), create a new project, and deploy from this GitHub repo.
- Railway auto-detects Node.js via `package.json` and uses the config in `railway.toml`.

### 2. Set environment variables

In the Railway service's **Variables** tab, add:

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | `123456789.apps.googleusercontent.com` | Your Google OAuth 2.0 Client ID |
| `ADMIN_EMAILS` | No | `alice@wi.mit.edu,bob@wi.mit.edu` | Emails with admin access |
| `DEV_BYPASS_AUTH` | No | `true` | Bypasses auth entirely -- **never use in production** |

### 3. Generate a public domain

1. Go to your service's **Settings** tab
2. Under **Networking > Public Networking**, click **Generate Domain**
3. You'll get a `*.railway.app` URL with automatic HTTPS

This is the URL you'll use with Claude Code (e.g. `https://your-app.railway.app/mcp`).

### 4. What Railway does

Defined in `railway.toml`:

- **Build**: `npm run build` (runs `tsc` to compile TypeScript)
- **Start**: `npm start` (runs `node dist/server.js`)
- **Health check**: `GET /health` -- Railway won't route traffic until this returns 200
- **Restart policy**: restarts on failure

Railway automatically sets the `PORT` environment variable. The server reads `PORT` and defaults to `3000` for local dev.

### Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/` | No | JSON info page (expected env vars, role names) |
| `/health` | No | Health check for Railway |
| `/mcp` | Yes | MCP Streamable HTTP endpoint (POST) |

## Google OAuth Setup

### 1. Configure the OAuth consent screen

Before you can create credentials, Google requires an OAuth consent screen:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Go to **APIs & Services > OAuth consent screen**
4. Select **Internal** (restricts to your Google Workspace org) or **External** (any Google account can auth, but you control access server-side via the `hd` claim)
5. Fill in the required fields:
   - **App name**: whatever you want (e.g. "MCP Server")
   - **User support email**: your email
   - **Developer contact email**: your email
6. Click **Save and Continue**
7. On the **Scopes** page, click **Add or Remove Scopes** and add:
   - `openid`
   - `email`
   - `profile`
8. Click **Save and Continue** through the remaining steps

> **Note**: If you choose **External**, the app starts in "Testing" mode. Only test users you explicitly add can authenticate until you publish the app. For internal use at `wi.mit.edu`, **Internal** is simpler if your Google Cloud project is in the `wi.mit.edu` Workspace org.

### 2. Create OAuth 2.0 credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth 2.0 Client ID**
3. Select **Web application**
4. Set a name (e.g. "MCP Server")
5. Under **Authorized redirect URIs**, add:
   - `https://developers.google.com/oauthplayground` (for testing with the OAuth Playground)
6. Click **Create**
7. Note the **Client ID** and **Client Secret**

The **Client ID** (looks like `123456789-abc.apps.googleusercontent.com`) is what you set as `GOOGLE_CLIENT_ID` on Railway.

### 3. How authentication works

This server validates Google **ID tokens** (JWTs), not access tokens. Here's what happens on each request:

1. Client sends `Authorization: Bearer <id_token>` header
2. Server fetches Google's public keys from `https://www.googleapis.com/oauth2/v3/certs` (cached by `jose`)
3. Server verifies the JWT signature, issuer (`https://accounts.google.com`), and audience (`GOOGLE_CLIENT_ID`)
4. Server checks `email_verified` is `true`
5. Server checks the `hd` (hosted domain) claim equals `wi.mit.edu`
6. If the email is in `ADMIN_EMAILS`, the user gets `mcp-admins` + `mcp-users` roles; otherwise just `mcp-users`

The `hd` claim is automatically included in Google ID tokens for Google Workspace accounts. Consumer `@gmail.com` accounts don't have it, so they'll always be rejected.

### 4. Get a test ID token

The server expects a Google **ID token** (JWT) as the Bearer token, not an access token. ID tokens are the ones that contain `email`, `hd`, and other identity claims.

**Using the OAuth Playground:**

1. Go to [Google OAuth Playground](https://developers.google.com/oauthplayground/)
2. Click the **gear icon** (⚙️) in the top right
3. Check **Use your own OAuth credentials**
4. Enter your **Client ID** and **Client Secret**
5. Close the settings panel
6. In Step 1, find **Google OAuth2 API v2** and select:
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `openid`
7. Click **Authorize APIs** — sign in with a `@wi.mit.edu` account
8. In Step 2, click **Exchange authorization code for tokens**
9. In the response, copy the `id_token` value (not `access_token`)

**Using gcloud CLI:**

```bash
gcloud auth login --update-adc
gcloud auth print-identity-token --audiences=YOUR_CLIENT_ID
```

**Verify the token contents:**

```bash
# Decode the JWT payload (middle segment)
echo '<id_token>' | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

You should see something like:

```json
{
  "iss": "https://accounts.google.com",
  "azp": "123456789-abc.apps.googleusercontent.com",
  "aud": "123456789-abc.apps.googleusercontent.com",
  "sub": "1234567890",
  "hd": "wi.mit.edu",
  "email": "jdoe@wi.mit.edu",
  "email_verified": true,
  "name": "Jane Doe",
  "picture": "https://lh3.googleusercontent.com/...",
  "iat": 1234567890,
  "exp": 1234571490
}
```

Key things to check:
- `hd` is `wi.mit.edu`
- `email_verified` is `true`
- `aud` matches your `GOOGLE_CLIENT_ID`
- `exp` is in the future (ID tokens expire after 1 hour)

### 5. Token expiry

Google ID tokens expire after **1 hour**. For long-running use with Claude Code, you'll need to refresh the token periodically. The OAuth Playground has a "Refresh access token" button in Step 2 that also refreshes the ID token.

## Local Development

```bash
# Without Google auth (auth bypassed, all tools available)
DEV_BYPASS_AUTH=true npm run dev

# With Google auth (need a valid ID token)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com npm run dev
```

### Wire into Claude Code

```bash
# Local dev with auth bypass
claude mcp add stupid-example --transport http http://localhost:3000/mcp

# Local dev with Google auth
claude mcp add stupid-example \
  --transport http \
  --header "Authorization: Bearer <your-google-id-token>" \
  http://localhost:3000/mcp

# Deployed on Railway
claude mcp add stupid-example \
  --transport http \
  --header "Authorization: Bearer <your-google-id-token>" \
  https://your-app.railway.app/mcp
```

### Test with curl

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <id_token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```
