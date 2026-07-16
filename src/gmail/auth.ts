import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { google } from "googleapis";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DEFAULT_CREDENTIALS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "google-oauth-client.json",
);
const DEFAULT_TOKEN_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "cache",
  "gmail-token.json",
);

type OAuthClientConfig = {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
};

type GoogleOAuthCredentials = {
  installed: OAuthClientConfig;
};

type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// Reads the downloaded Google OAuth client JSON.
const readOAuthClientConfig = async (
  credentialsPath: string,
): Promise<OAuthClientConfig> => {
  try {
    const raw = await fs.readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as GoogleOAuthCredentials;
    const config = parsed.installed;
    if (
      !config?.client_id ||
      !config.client_secret ||
      !config.redirect_uris[0]
    ) {
      throw new Error("Missing client_id/client_secret/redirect_uris.");
    }
    return config;
  } catch (error) {
    throw new Error(
      [
        `Unable to read Google OAuth client file at ${credentialsPath}.`,
        "Create a Google Cloud OAuth client for a desktop app, enable the Gmail API, download the JSON, and save it there.",
        (error as Error).message,
      ].join(" "),
    );
  }
};

// Reads a JSON file when it exists, returning undefined on first run.
const readJsonIfExists = async (
  filePath: string,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

// Runs the one-time browser authorization flow for Gmail.
const runLocalOAuthFlow = async (
  oauth2Client: GoogleOAuth2Client,
  config: OAuthClientConfig,
): Promise<Record<string, unknown>> => {
  // Desktop OAuth returns to a temporary localhost server on this machine.
  const baseRedirect = new URL(config.redirect_uris[0]);
  if (baseRedirect.hostname !== "localhost") {
    throw new Error(
      `Expected a localhost redirect URI in google-oauth-client.json, got ${baseRedirect.toString()}`,
    );
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(
          request.url || "/",
          `${baseRedirect.protocol}//${baseRedirect.host}`,
        );

        if (requestUrl.pathname !== baseRedirect.pathname) {
          response.writeHead(404);
          response.end("Invalid OAuth callback path.");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        if (error) throw new Error(`OAuth failed: ${error}`);

        const code = requestUrl.searchParams.get("code");
        if (!code) throw new Error("OAuth callback did not include a code.");

        const redirectUri = baseRedirect.toString();
        const { tokens } = await oauth2Client.getToken({
          code,
          redirect_uri: redirectUri,
        });

        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("Gmail authorization complete. You can close this tab.");
        server.close();
        resolve(tokens as Record<string, unknown>);
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end((error as Error).message);
        server.close();
        reject(error);
      }
    });

    server.on("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        baseRedirect.port = String(address.port);
      }

      const authUrl = oauth2Client.generateAuthUrl({
        redirect_uri: baseRedirect.toString(),
        access_type: "offline",
        prompt: "consent",
        // Readonly is enough for search/reporting and avoids mail changes.
        scope: [GMAIL_READONLY_SCOPE],
      });

      console.log(
        `Open this URL to authorize Gmail read-only access:\n${authUrl}`,
      );
      execFile("open", [authUrl], () => undefined);
    });
  });
};

// Returns an authorized Gmail client, reusing the local token when possible.
export const getGmailAuthClient = async (): Promise<GoogleOAuth2Client> => {
  const config = await readOAuthClientConfig(DEFAULT_CREDENTIALS_PATH);
  const oauth2Client = new google.auth.OAuth2({
    clientId: config.client_id,
    clientSecret: config.client_secret,
  });

  const cachedToken = await readJsonIfExists(DEFAULT_TOKEN_PATH);
  if (cachedToken) {
    // Reuse the local refresh token so normal runs do not prompt again.
    oauth2Client.setCredentials(cachedToken);
    return oauth2Client;
  }

  const tokens = await runLocalOAuthFlow(oauth2Client, config);
  await fs.mkdir(path.dirname(DEFAULT_TOKEN_PATH), { recursive: true });
  // Keep the token readable only by the local user account.
  await fs.writeFile(DEFAULT_TOKEN_PATH, JSON.stringify(tokens, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
};
