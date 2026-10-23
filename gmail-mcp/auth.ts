// One-time Gmail sign-in. Opens Google's consent page, receives the code on
// a loopback address, and saves the refresh token the server runs with.
//
// Run with: npm run auth (loads ../personal-agent/.env for the client).
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod } from "google-auth-library";
import { oauthClient, SCOPES, TOKEN_PATH } from "./gmail.ts";

// A Desktop app OAuth client accepts any loopback port, so the OS picks one.
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const redirectUri = `http://127.0.0.1:${port}/callback`;

const client = oauthClient(redirectUri);
const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
const authUrl = client.generateAuthUrl({
  // offline returns a refresh token, and consent makes Google issue a new
  // one even when this client was authorized before.
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
  code_challenge: codeChallenge,
  code_challenge_method: CodeChallengeMethod.S256,
});

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("code");
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(value
      ? "Gmail is connected. You can close this tab."
      : `Sign-in failed: ${error ?? "no code returned"}`);
    if (value) resolve(value);
    else reject(new Error(`Sign-in failed: ${error ?? "no code returned"}`));
  });

  console.log(`Opening Google sign-in. If no browser opens, visit:\n${authUrl}`);
  execFile("open", [authUrl], () => undefined);
});
server.close();

const { tokens } = await client.getToken({ code, codeVerifier });
if (!tokens.refresh_token) {
  throw new Error("Google returned no refresh token; run npm run auth again.");
}

await mkdir(new URL(".", TOKEN_PATH), { recursive: true });
// Only the refresh token is kept; the server mints access tokens from it.
await writeFile(
  TOKEN_PATH,
  `${JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`Saved the Gmail sign-in to ${TOKEN_PATH.pathname}`);
