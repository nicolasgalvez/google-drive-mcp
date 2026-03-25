# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # typecheck (tsc --noEmit) + bundle (esbuild → dist/index.js)
npm run typecheck          # type checking only
npm run watch              # esbuild watch mode

npm test                   # all tests (unit + integration, needs MCP_TESTING=1)
npm run test:unit          # unit tests only (no credentials needed)
npm run test:build         # compile tests to .tmp-test/ (required before running tests)

# Run a single test file after test:build:
node --test .tmp-test/test/utils.test.js

npm run lint               # tsc + eslint
npm run lint:eslint        # eslint only

npm run setup              # interactive GCP project setup wizard
npm run auth               # run OAuth flow manually
```

## Architecture

**MCP server** using `@modelcontextprotocol/sdk` with stdio transport. Google Drive, Docs, Sheets, Slides, and Calendar are exposed as MCP tools.

### Request flow

stdin → SDK deserialize → `ensureAuthenticated()` (lazy, once) → route to domain module → Zod validate input → Google API call → MCP response → stdout

### Auth priority chain (`src/auth.ts`)

1. **Service account** — `GOOGLE_APPLICATION_CREDENTIALS` env var
2. **External OAuth** — `GOOGLE_DRIVE_MCP_ACCESS_TOKEN` env var (optional refresh via `_REFRESH_TOKEN` + `_CLIENT_ID` + `_CLIENT_SECRET`)
3. **Local OAuth flow** — credentials file + Express callback server on ports 3000-3004

Credentials file search order: `GOOGLE_DRIVE_OAUTH_CREDENTIALS` env → `~/.config/google-drive-mcp/gcp-oauth.keys.json` → `./gcp-oauth.keys.json`

Tokens stored at `~/.config/google-drive-mcp/tokens.json` (override with `GOOGLE_DRIVE_MCP_TOKEN_PATH`).

### Tool module pattern

Each domain module (`src/tools/{drive,docs,sheets,slides,calendar}.ts`) exports:

```typescript
export const toolDefinitions: ToolDefinition[]
export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null>
```

`handleTool` returns `null` if it doesn't own the tool name. The server iterates modules until one handles it. All tool inputs are validated with Zod schemas. Errors use `errorResponse()` from `src/types.ts`.

To add a new tool: add its definition to `toolDefinitions`, add its Zod schema + handler case in `handleTool`, and the server picks it up automatically.

### Key abstractions

- **ToolContext** (`src/types.ts`) — passed to all handlers; carries `getDrive()`, `getCalendar()`, `resolvePath()`, `resolveFolderId()`, `log()`
- **resolvePath** (`src/index.ts`) — converts path strings like `/Work/Projects` to folder IDs, creating missing folders
- **download-file** (`src/download-file.ts`) — handles format conversion (Docs→Markdown, Sheets→CSV, Slides→PNG/PPTX)

### Build

esbuild bundles `src/index.ts` → `dist/index.js` (ESM, ES2020, externals preserved). TypeScript strict mode. Tests compile separately to `.tmp-test/` via `tsconfig.test.json`.

## Testing

Uses Node.js built-in `node:test` + `node:assert/strict`. No test framework.

- Unit tests: `test/*.test.ts` — no credentials needed
- Integration tests: `test/integration/*.test.ts` — need live Google API credentials and `MCP_TESTING=1`
- Schema tests: `test/schema/*.test.ts` — validate tool input schemas

## Style

- `@typescript-eslint/no-explicit-any`: OFF (allowed throughout)
- `@typescript-eslint/no-floating-promises`: ERROR (must await or handle)
- All Drive API calls must include `includeItemsFromAllDrives: true` and `supportsAllDrives: true`
- Logging goes to stderr via `ctx.log()` or `console.error()` (stdout is reserved for MCP protocol)
