import 'dotenv/config';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import path from 'node:path';
import { authorizationScopes, monetaryScope } from './core.js';

const directory = () => path.resolve('.youtube-mcp');
export function cleanAlias(alias: string) {
  if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(alias)) throw Error('Invalid channel alias.');
  return alias;
}
export const tokenPath = (alias: string) => path.join(directory(), 'tokens', cleanAlias(alias) + '.json');
export async function oauth() {
  const redirect = `http://127.0.0.1:${Number(process.env.YOUTUBE_OAUTH_PORT || 53124)}/oauth2callback`;
  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) return new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, redirect);
  try {
    const parsed = JSON.parse(await readFile(process.env.YOUTUBE_OAUTH_CLIENT_FILE || path.join(directory(), 'client_secret.json'), 'utf8'));
    const client = parsed.installed || parsed.web;
    if (!client?.client_id || !client?.client_secret) throw Error();
    return new google.auth.OAuth2(client.client_id, client.client_secret, redirect);
  } catch { throw Error('OAuth client configuration is missing or invalid. Credential contents are omitted.'); }
}
export async function auth(alias: string) {
  const client = await oauth();
  try { client.setCredentials(JSON.parse(await readFile(tokenPath(alias), 'utf8'))); }
  catch { throw Error('No valid saved authorization for this alias; use authorize_channel.'); }
  return client;
}
export function mergeCredentials(previous: Credentials, incoming: Credentials) {
  if (!incoming.access_token) throw Error('OAuth response has no access token.');
  return { ...incoming, scope: incoming.scope || previous.scope, refresh_token: incoming.refresh_token || previous.refresh_token };
}
export function assertChannelIdentity(actual: string | null | undefined, expected?: string) {
  if (!actual || (expected && actual !== expected)) throw Error('Selected channel does not match the alias. Existing authorization was preserved.');
}
export function renderAuthorizationPage(alias: string, url: string, revenue: boolean) {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect YouTube analytics</title><main style="max-width:640px;margin:48px auto;padding:20px;font:18px/1.6 system-ui"><h1>Connect ${escape(alias)} analytics</h1><p>Continue in the browser where this channel is already signed in. Choose the Google account and YouTube channel matching ${escape(alias)}.</p><p>${revenue ? 'Google will ask for read-only access to revenue analytics, alongside the existing YouTube permissions.' : 'Review the requested YouTube permissions on Google’s page.'}</p><p><a href="${escape(url)}">Continue with Google</a></p><p>The existing connection stays intact unless the matching channel and requested permissions are verified. This link expires after ten minutes.</p></main></html>`;
}
export async function startAuthorization(alias: string, includeRevenue = false, expectedChannelId?: string) {
  cleanAlias(alias);
  const client = await oauth();
  let previous: Credentials = {};
  try { previous = JSON.parse(await readFile(tokenPath(alias), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Cannot read existing authorization; it was not replaced.'); }
  if (previous.refresh_token || previous.access_token) {
    const old = await auth(alias);
    let oldChannel: string | null | undefined;
    try { oldChannel = (await google.youtube({ version: 'v3', auth: old }).channels.list({ part: ['id'], mine: true })).data.items?.[0]?.id; }
    catch { if (!expectedChannelId) throw Error('Cannot verify the saved alias. Supply its verified expected_channel_id to renew it.'); }
    if (oldChannel) { assertChannelIdentity(oldChannel, expectedChannelId); expectedChannelId = oldChannel; }
    else if (!expectedChannelId) throw Error('Cannot verify the saved alias; existing authorization was preserved.');
  }
  const verifier = await client.generateCodeVerifierAsync();
  const state = randomUUID();
  const wantsRevenue = includeRevenue || !!previous.scope?.split(' ').includes(monetaryScope);
  const scopes = authorizationScopes(wantsRevenue);
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: scopes, state, code_challenge: verifier.codeChallenge, code_challenge_method: 'S256' as never });
  const port = Number(process.env.YOUTUBE_OAUTH_PORT || 53124);
  let busy = false;
  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const request = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (request.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(renderAuthorizationPage(alias, url, wantsRevenue)); return; }
    if (request.pathname !== '/oauth2callback') { res.writeHead(404).end('Not found.'); return; }
    if (request.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid authorization state.'); return; }
    if (busy) { res.writeHead(409).end('Authorization is being processed.'); return; }
    busy = true;
    try {
      const code = request.searchParams.get('code');
      if (!code || request.searchParams.has('error')) throw Error();
      const { tokens } = await client.getToken({ code, codeVerifier: verifier.codeVerifier });
      client.setCredentials(tokens);
      const granted = tokens.scope?.split(' ') || (tokens.access_token ? (await client.getTokenInfo(tokens.access_token)).scopes : []);
      if (wantsRevenue && !granted.includes(monetaryScope)) throw Error('Requested revenue access was not granted.');
      const channel = (await google.youtube({ version: 'v3', auth: client }).channels.list({ part: ['snippet'], mine: true })).data.items?.[0];
      assertChannelIdentity(channel?.id, expectedChannelId);
      const merged = mergeCredentials(previous, { ...tokens, scope: granted.join(' ') });
      if (!merged.refresh_token) throw Error('No refresh token.');
      const final = tokenPath(alias), temp = final + '.' + randomUUID() + '.tmp';
      await mkdir(path.dirname(final), { recursive: true });
      try { await writeFile(temp, JSON.stringify(merged, null, 2), { mode: 0o600 }); await rename(temp, final); }
      finally { await rm(temp, { force: true }).catch(() => undefined); }
      res.end('Channel authorization verified and saved. You can return to Codex.');
    } catch { res.writeHead(400).end('Authorization was cancelled, did not match the channel, or could not be saved. Existing authorization was preserved.'); }
    finally { http.close(); clearTimeout(timer); }
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  const timer = setTimeout(() => http.close(), 10 * 60_000); timer.unref();
  return { channel_alias: alias, expected_channel_id: expectedChannelId || null, handoff_url: `http://127.0.0.1:${port}/`, authorization_url: url, revenue_requested: wantsRevenue, expires_in_minutes: 10, next: 'Open handoff_url in the browser where this channel is already signed in, then review Google consent. The existing login is replaced only after channel identity verification succeeds.' };
}
