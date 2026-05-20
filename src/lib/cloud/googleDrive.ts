/**
 * Google Drive cloud provider — Phase 1 surface.
 *
 * Auth: PKCE same-window redirect (no popup, no client secret needed).
 * Scope: `drive.file` — the app can only see/touch files it creates
 * or files the user explicitly grants via the Picker. This is
 * deliberately narrower than `drive` (which is Google's "high-risk"
 * tier requiring formal security review).
 *
 * Folder model: at first sign-in the app does NOT have access to any
 * existing Drive folders. The user picks one via the Google Picker
 * (which grants per-file `drive.file` access). The chosen folder's id
 * is stashed in localStorage; all subsequent List / Pull / Push calls
 * scope to that folder.
 *
 * Token storage: access + refresh tokens live in localStorage. This
 * is not the most secure store (vulnerable to XSS), but the app has
 * no other meaningful secrets and the alternative (sessionStorage)
 * loses tokens across tab close. Locked decision for personal scale.
 *
 * Phase 1 surface implements: sign-in / sign-out / handleAuthRedirect
 * / pickFolder / listCloudSlots / pullSlot / token refresh.
 * `pushSlot` and `removeCloudSlot` throw a Phase-2 marker error.
 */

import type {
  AuthListener,
  AuthState,
  CloudProvider,
  CloudPullResult,
  CloudPushOptions,
  CloudPushResult,
  CloudSlotMeta,
} from '../cloud';
import { parseDisplayNameFromFilename } from '../cloud';
import type { AutosaveBlob } from '../storage';

// ---------- config ----------

/**
 * Public OAuth identifiers, both inlined at build time from Vite env
 * vars. The empty fallbacks are fine for local dev where the user
 * hasn't registered yet; `signIn` throws an actionable error in that
 * case.
 *
 * About `GOOGLE_CLIENT_SECRET` in a browser bundle:
 *
 *   Google classifies OAuth clients of type "Web application" as
 *   confidential and rejects the token exchange (auth-code → tokens,
 *   and refresh-token → tokens) with `invalid_request: client_secret
 *   is missing` if you only send `client_id` + `code_verifier`, even
 *   though that's exactly what PKCE says a public client should send.
 *   The only way to use a Web-application client from a pure-browser
 *   app with no backend is to also send the so-called "client secret".
 *
 *   This makes the secret functionally non-secret here — it ends up
 *   in the deployed JS just like the client id. PKCE still does its
 *   job (binds the redeemed code to this browser instance via the
 *   code_verifier), and the real anti-phishing defense for this
 *   client is the Authorized redirect URIs allowlist in Google Cloud
 *   Console: a stolen id+secret can only redirect to URLs we've
 *   explicitly registered. We treat the secret the same way we treat
 *   the id — keep it out of source via env vars / repo secrets, but
 *   accept that it's visible in the built bundle.
 *
 * Read off `import.meta.env` via the loose `unknown` cast so this
 * file compiles without needing the Vite ambient client types
 * configured (and so tests that import this file under Node — no
 * `import.meta.env` shim — don't crash at module load).
 */
const ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
const GOOGLE_CLIENT_ID: string = ENV.VITE_GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET: string = ENV.VITE_GOOGLE_CLIENT_SECRET ?? '';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const PICKER_API_SCRIPT = 'https://apis.google.com/js/api.js';

// ---------- storage keys ----------

const TOKEN_KEY = 'sorter:cloud:tokens:v1';
const FOLDER_KEY = 'sorter:cloud:folder:v1';
const PKCE_KEY = 'sorter:cloud:pkce:v1';
const PRE_AUTH_HASH_KEY = 'sorter:preAuthHash';

// ---------- types ----------

interface StoredTokens {
  accessToken: string;
  /** May be empty if Google didn't issue one (re-auth needed sooner). */
  refreshToken: string;
  /** ms-epoch when the access token expires. */
  expiresAt: number;
}

interface StoredFolder {
  folderId: string;
  folderName: string;
}

interface PkceState {
  verifier: string;
  state: string;
}

// ---------- helpers (PKCE) ----------

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await sha256(verifier);
  return base64UrlEncode(digest);
}

// ---------- helpers (storage) ----------

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (!parsed.accessToken || typeof parsed.expiresAt !== 'number') return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? '',
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens): void {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    /* ignore */
  }
}

function clearTokens(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function readFolder(): StoredFolder | null {
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredFolder>;
    if (!parsed.folderId || !parsed.folderName) return null;
    return { folderId: parsed.folderId, folderName: parsed.folderName };
  } catch {
    return null;
  }
}

function writeFolder(f: StoredFolder): void {
  try {
    localStorage.setItem(FOLDER_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

function clearFolderStorage(): void {
  try {
    localStorage.removeItem(FOLDER_KEY);
  } catch {
    /* ignore */
  }
}

function readPkce(): PkceState | null {
  try {
    const raw = sessionStorage.getItem(PKCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PkceState>;
    if (!parsed.verifier || !parsed.state) return null;
    return { verifier: parsed.verifier, state: parsed.state };
  } catch {
    return null;
  }
}

function writePkce(p: PkceState): void {
  try {
    sessionStorage.setItem(PKCE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function clearPkce(): void {
  try {
    sessionStorage.removeItem(PKCE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- helpers (URL hash stash; see plan: phase1_hash_restore) ----------

function stashPreAuthHash(): void {
  try {
    const h = window.location.hash;
    if (h && h.length > 1) {
      sessionStorage.setItem(PRE_AUTH_HASH_KEY, h);
    }
  } catch {
    /* ignore */
  }
}

function restorePreAuthHash(): void {
  try {
    const h = sessionStorage.getItem(PRE_AUTH_HASH_KEY);
    if (h) {
      // Set via history.replaceState so we don't trigger a hashchange
      // listener that might double-handle (e.g. share-link import
      // listens for hashchange).
      const newUrl = window.location.pathname + window.location.search + h;
      window.history.replaceState(null, '', newUrl);
      sessionStorage.removeItem(PRE_AUTH_HASH_KEY);
    }
  } catch {
    /* ignore */
  }
}

// ---------- impl ----------

export class GoogleDriveProvider implements CloudProvider {
  private listeners = new Set<AuthListener>();
  /** Cache for the dynamically-injected gapi script load promise so
   *  parallel `pickFolder` calls share one load. */
  private gapiLoadPromise: Promise<void> | null = null;

  // ----- auth state -----

  getAuthState(): AuthState {
    const tokens = readTokens();
    if (!tokens) return { status: 'signed-out' };
    // If the access token is expired AND we have no refresh token,
    // surface `expired`. If we DO have a refresh token, treat as
    // signed-in — `refreshTokenIfNeeded` will quietly swap on the
    // next data call. (We don't pre-emptively refresh on
    // `getAuthState` because it's called synchronously from React
    // render paths.)
    if (Date.now() >= tokens.expiresAt && !tokens.refreshToken) {
      return { status: 'expired' };
    }
    const folder = readFolder();
    return {
      status: 'signed-in',
      expiresAt: tokens.expiresAt,
      folderId: folder?.folderId,
      folderName: folder?.folderName,
    };
  }

  subscribeAuthChange(listener: AuthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fireAuthChange(): void {
    const state = this.getAuthState();
    for (const l of this.listeners) {
      try {
        l(state);
      } catch (err) {
        console.warn('auth listener threw', err);
      }
    }
  }

  // ----- sign in / sign out -----

  async signIn(): Promise<void> {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      // Fail fast here so the user sees the actionable error before
      // bouncing through Google's consent screen — without both env
      // vars the post-redirect token exchange would silently 400 and
      // the user would land back at the app with no obvious reason
      // it didn't work.
      const missing = [
        !GOOGLE_CLIENT_ID && 'VITE_GOOGLE_CLIENT_ID',
        !GOOGLE_CLIENT_SECRET && 'VITE_GOOGLE_CLIENT_SECRET',
      ]
        .filter(Boolean)
        .join(' and ');
      throw new Error(
        `Cloud backup is not configured: ${missing} is empty. ` +
          'Register an OAuth client at https://console.cloud.google.com ' +
          '(Web application type), then set both env vars at build time. ' +
          'See README "Cloud backup" for the full setup.',
      );
    }
    const verifier = randomString(64);
    const state = randomString(16);
    const challenge = await pkceChallenge(verifier);
    writePkce({ verifier, state });
    stashPreAuthHash();
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      // Drive's refresh tokens are only issued when this is set. Without
      // it, the access token expires in ~1h and the user has to fully
      // re-auth (Safari ITP user experience for everyone). With it,
      // `refreshTokenIfNeeded` can silently keep the session alive.
      access_type: 'offline',
      // Force the consent screen on every sign-in. Without this Google
      // sometimes skips the consent step on returning users and
      // doesn't issue a fresh refresh token, leaving us in a quiet
      // hanging state. Personal scale: one extra click is fine.
      prompt: 'consent',
      // Request the granular consent UI variant where the user can
      // tick `drive.file`. (Default behavior; explicit for clarity.)
      include_granted_scopes: 'true',
    });
    window.location.assign(`${AUTH_ENDPOINT}?${params.toString()}`);
  }

  async handleAuthRedirect(): Promise<AuthState> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const incomingState = url.searchParams.get('state');
    const errorParam = url.searchParams.get('error');
    if (!code && !errorParam) return this.getAuthState();

    // Clean up the URL up front so a reload doesn't replay the
    // exchange (refresh would try to redeem the now-spent code and
    // fail). Restoring the pre-auth hash is part of this cleanup
    // step so a mid-import share-link survives the round-trip.
    //
    // The strip list includes `iss` (issuer) which Google appends to
    // every OIDC-style callback even when we didn't ask for it. If we
    // miss it, the remaining query string starts with `&iss=…` and
    // the URL ends up looking like `localhost:3000/&iss=…`.
    //
    // The two normalize passes that follow handle the case where
    // every param got stripped: collapse a leftover lone `?` and any
    // stray leading `&` so the cleaned URL is the bare pathname.
    const strippedSearch = window.location.search
      .replace(/[?&]?(code|state|error|scope|authuser|prompt|hd|iss)=[^&]*/g, '')
      .replace(/^\?&/, '?')
      .replace(/^&/, '')
      .replace(/^\?$/, '');
    const cleanUrl = window.location.pathname + strippedSearch;
    window.history.replaceState(null, '', cleanUrl || window.location.pathname);
    restorePreAuthHash();

    if (errorParam) {
      // User dismissed consent / denied. Wipe pkce state and return
      // signed-out — the UI re-offers Sign in on next render.
      clearPkce();
      this.fireAuthChange();
      return this.getAuthState();
    }

    const pkce = readPkce();
    clearPkce();
    if (!pkce || !code) {
      // No verifier means we can't redeem — treat as a bounce-through.
      this.fireAuthChange();
      return this.getAuthState();
    }
    if (incomingState && incomingState !== pkce.state) {
      // CSRF / link-mixup: drop the response.
      console.warn('cloud auth state mismatch; ignoring redirect');
      this.fireAuthChange();
      return this.getAuthState();
    }

    // client_secret is included because Google's "Web application"
    // OAuth client type is classified as confidential and rejects
    // token exchange without it, even when PKCE is in use. See the
    // GOOGLE_CLIENT_SECRET comment at the top of this file for the
    // full rationale and threat model.
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: pkce.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
    });
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      console.warn('token exchange failed', resp.status, await safeText(resp));
      this.fireAuthChange();
      return this.getAuthState();
    }
    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token || typeof data.expires_in !== 'number') {
      console.warn('token response malformed');
      this.fireAuthChange();
      return this.getAuthState();
    }
    writeTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    this.fireAuthChange();
    return this.getAuthState();
  }

  async signOut(): Promise<void> {
    // Locked decision: sign-out clears tokens AND the folder selection
    // so the next sign-in starts with a fresh pick. Cloud-side files
    // are NOT touched — they remain in the user's Drive.
    clearTokens();
    clearFolderStorage();
    clearPkce();
    this.fireAuthChange();
  }

  // ----- token refresh -----

  async refreshTokenIfNeeded(): Promise<void> {
    const tokens = readTokens();
    if (!tokens) return;
    // Refresh when we're within 60s of expiry. Anything closer risks
    // the in-flight Drive call landing after expiry; anything further
    // wastes refresh-token uses.
    if (Date.now() < tokens.expiresAt - 60_000) return;
    if (!tokens.refreshToken) {
      // No refresh token to use; transition to expired so the UI
      // surfaces the banner. Caller's data call will then 401, which
      // is the correct cue to ask the user to sign in again.
      clearTokens();
      this.fireAuthChange();
      return;
    }
    // client_secret required for the same reason as the initial
    // code exchange — see GOOGLE_CLIENT_SECRET comment above.
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    });
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      // Refresh token rejected (revoked by user, or Google's invalid
      // grant). Wipe state so we surface as expired and prompt re-auth.
      console.warn('token refresh failed', resp.status);
      clearTokens();
      this.fireAuthChange();
      return;
    }
    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token || typeof data.expires_in !== 'number') {
      clearTokens();
      this.fireAuthChange();
      return;
    }
    writeTokens({
      accessToken: data.access_token,
      // Google may or may not re-issue a refresh token on refresh.
      // Keep the old one when nothing fresh is sent.
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    this.fireAuthChange();
  }

  // ----- folder pick -----

  async pickFolder(): Promise<{ folderId: string; folderName: string }> {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error(
        'Cloud backup is not configured: VITE_GOOGLE_CLIENT_ID and ' +
          'VITE_GOOGLE_CLIENT_SECRET must both be set at build time.',
      );
    }
    await this.refreshTokenIfNeeded();
    const tokens = readTokens();
    if (!tokens) throw new Error('Sign in before picking a folder.');
    await this.loadGapi();
    return new Promise<{ folderId: string; folderName: string }>((resolve, reject) => {
      const w = window as unknown as {
        google?: {
          picker?: PickerNamespace;
        };
      };
      const picker = w.google?.picker;
      if (!picker) {
        reject(new Error('Google Picker SDK failed to load.'));
        return;
      }
      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder');
      const builder = new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(tokens.accessToken)
        .setCallback((data: PickerResponseData) => {
          if (data.action === picker.Action.CANCEL) {
            reject(new Error('Folder pick canceled.'));
            return;
          }
          if (data.action !== picker.Action.PICKED) return;
          const doc = data.docs?.[0];
          if (!doc) {
            reject(new Error('No folder was selected.'));
            return;
          }
          const folder = { folderId: doc.id, folderName: doc.name };
          writeFolder(folder);
          this.fireAuthChange();
          resolve(folder);
        });
      // App id is optional for drive.file scope.
      if (GOOGLE_CLIENT_ID) {
        const appId = GOOGLE_CLIENT_ID.split('-')[0];
        if (appId) builder.setAppId(appId);
      }
      builder.build().setVisible(true);
    });
  }

  async clearFolder(): Promise<void> {
    clearFolderStorage();
    this.fireAuthChange();
  }

  /**
   * Dynamically inject the gapi script and load the picker module.
   * Memoized so repeated picker calls share one network load.
   * Headless test environments are expected to mock `pickFolder`
   * outright — this loader isn't exercised in unit tests.
   */
  private loadGapi(): Promise<void> {
    if (this.gapiLoadPromise) return this.gapiLoadPromise;
    this.gapiLoadPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector(`script[src="${PICKER_API_SCRIPT}"]`);
      if (existing) {
        // Already injected by a prior call; just load the picker module.
        const g = (window as unknown as { gapi?: GapiNamespace }).gapi;
        if (g) {
          g.load('picker', { callback: () => resolve() });
        } else {
          existing.addEventListener('load', () => {
            const g2 = (window as unknown as { gapi?: GapiNamespace }).gapi;
            if (!g2) {
              reject(new Error('gapi failed to load.'));
              return;
            }
            g2.load('picker', { callback: () => resolve() });
          });
        }
        return;
      }
      const script = document.createElement('script');
      script.src = PICKER_API_SCRIPT;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        const g = (window as unknown as { gapi?: GapiNamespace }).gapi;
        if (!g) {
          reject(new Error('gapi failed to load.'));
          return;
        }
        g.load('picker', { callback: () => resolve() });
      };
      script.onerror = () => reject(new Error('Google Picker SDK failed to load.'));
      document.head.appendChild(script);
    });
    return this.gapiLoadPromise;
  }

  // ----- data ops -----

  async listCloudSlots(): Promise<CloudSlotMeta[]> {
    const folder = readFolder();
    if (!folder) return [];
    await this.refreshTokenIfNeeded();
    const params = new URLSearchParams({
      q: `'${folder.folderId}' in parents and trashed = false and name contains '.sorter.json'`,
      fields:
        'files(id,name,modifiedTime,size,version,md5Checksum,appProperties)',
      pageSize: '1000',
    });
    const resp = await this.authedFetch(`${DRIVE_API}/files?${params.toString()}`);
    if (!resp.ok) {
      throw new Error(`listCloudSlots failed: ${resp.status} ${await safeText(resp)}`);
    }
    const data = (await resp.json()) as {
      files?: Array<{
        id: string;
        name: string;
        modifiedTime: string;
        size?: string;
        version?: string;
        md5Checksum?: string;
        appProperties?: Record<string, string>;
      }>;
    };
    return (data.files ?? []).map((f) => ({
      cloudId: f.id,
      filename: f.name,
      displayName:
        f.appProperties?.sorterDisplayName ?? parseDisplayNameFromFilename(f.name),
      sizeBytes: f.size ? Number(f.size) : 0,
      updatedAt: f.modifiedTime,
      etag: f.md5Checksum ?? f.version ?? f.modifiedTime,
      sorterSlotId: f.appProperties?.sorterSlotId,
    }));
  }

  async pullSlot(cloudId: string): Promise<CloudPullResult> {
    await this.refreshTokenIfNeeded();
    // One round-trip for the metadata (etag/updatedAt/appProperties)
    // and one for the body. Drive's `alt=media` returns the raw bytes
    // but no metadata; we want both, so two calls is unavoidable.
    const metaResp = await this.authedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(cloudId)}?fields=id,name,modifiedTime,version,md5Checksum,appProperties`,
    );
    if (!metaResp.ok) {
      throw new Error(`pullSlot meta failed: ${metaResp.status}`);
    }
    const meta = (await metaResp.json()) as {
      id: string;
      name: string;
      modifiedTime: string;
      version?: string;
      md5Checksum?: string;
      appProperties?: Record<string, string>;
    };
    const bodyResp = await this.authedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(cloudId)}?alt=media`,
    );
    if (!bodyResp.ok) {
      throw new Error(`pullSlot body failed: ${bodyResp.status}`);
    }
    const json = (await bodyResp.json()) as unknown;
    const blob = parseCloudBlob(json);
    return {
      blob,
      etag: meta.md5Checksum ?? meta.version ?? meta.modifiedTime,
      updatedAt: meta.modifiedTime,
      sorterSlotId: meta.appProperties?.sorterSlotId,
    };
  }

  async pushSlot(
    cloudId: string | null,
    blob: AutosaveBlob,
    opts: CloudPushOptions,
  ): Promise<CloudPushResult> {
    const folder = readFolder();
    if (!folder) throw new Error('Pick a cloud folder first.');
    await this.refreshTokenIfNeeded();

    // Locked decision: strip the undo ring before upload. Personal
    // scale rationale — smaller blobs, no cross-device undo noise,
    // cloud is the source of truth so you'd never want to undo
    // something that happened on another device.
    const stripped: AutosaveBlob = { ...blob, undoRing: [] };
    const fileContent = buildCloudFileContent(stripped);

    // Optional stale-cache check. When `expectedEtag` is set and the
    // current cloud version differs, refuse the push with a typed
    // marker the App layer can pattern-match to show the confirm modal.
    // The App re-invokes pushSlot WITHOUT expectedEtag on user confirm.
    if (cloudId && opts.expectedEtag) {
      const currentEtag = await this.peekEtag(cloudId);
      if (currentEtag === null) {
        // 404 — file was deleted upstream. Fall through to the
        // create-new path below (clears cloudId so we don't try to
        // PATCH a missing id).
        cloudId = null;
      } else if (currentEtag !== opts.expectedEtag) {
        throw new CloudEtagMismatchError(currentEtag, opts.expectedEtag);
      }
    }

    // Resumable upload — the only browser-friendly pattern Google
    // actually supports cleanly. History of pivots that didn't work:
    //
    //   1. Multipart upload (uploadType=multipart, multipart/related
    //      body). The actual file IS created on Drive but Google's
    //      edge routes the response through a batch-style handler
    //      that strips CORS headers, so the browser blocks us from
    //      reading the id back and the file ends up orphaned.
    //
    //   2. Two-step (POST /drive/v3/files for metadata, then PATCH
    //      /upload/.../uploadType=media for content). Step 1 works
    //      cleanly. Step 2 returns 403 from Google's edge — drive.file
    //      scope apparently only treats files created VIA THE UPLOAD
    //      endpoint as "created by the app", and refuses subsequent
    //      content writes to files created via the regular API.
    //
    // Resumable upload solves both: the init call uses application/
    // json (CORS-friendly) AND creates the file via the upload
    // endpoint (satisfies drive.file scope). The content PUT goes to
    // the Location URL returned by init, which is on a same-origin
    // path that also supports CORS.
    //
    //   Init:    POST/PATCH /upload/drive/v3/files[/{id}]?uploadType=resumable
    //            body: metadata JSON
    //            response: 200 OK with Location header pointing to the upload URL
    //   Content: PUT <upload URL>
    //            body: raw file bytes
    //            response: 200 OK with file metadata JSON
    const metadata: Record<string, unknown> = {
      name: opts.desiredFilename,
      mimeType: 'application/json',
      appProperties: {
        sorterSlotId: opts.sorterSlotId,
        sorterDisplayName: opts.displayName,
      },
    };
    if (cloudId === null) {
      metadata.parents = [folder.folderId];
    }
    const contentBody = JSON.stringify(fileContent);
    // X-Upload-Content-Length needs the byte length, not the JS
    // string length — multi-byte chars would otherwise under-report.
    const contentByteLength = new TextEncoder().encode(contentBody).length;

    // Ask Drive to return md5Checksum on the final upload response so
    // we can stash a content-derived etag locally — see `peekEtag` for
    // why `md5Checksum` is preferred over `version`.
    const initUrl = cloudId
      ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(cloudId)}?uploadType=resumable&fields=id,modifiedTime,version,md5Checksum`
      : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,modifiedTime,version,md5Checksum`;
    const initMethod = cloudId ? 'PATCH' : 'POST';

    const initResp = await this.authedFetch(initUrl, {
      method: initMethod,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/json',
        'X-Upload-Content-Length': String(contentByteLength),
      },
      body: JSON.stringify(metadata),
    });
    if (initResp.status === 404 && cloudId !== null) {
      // Drive-side delete recovery (locked decision): the file we
      // were trying to update is gone. Fall back to creating a fresh
      // one under the chosen folder. The App layer detects this by
      // comparing the returned cloudId against the one it passed in.
      return this.pushSlot(null, blob, opts);
    }
    if (!initResp.ok) {
      throw new Error(
        `pushSlot init failed: ${initResp.status} ${await safeText(initResp)}`,
      );
    }
    const uploadUrl = initResp.headers.get('location');
    if (!uploadUrl) {
      throw new Error('Resumable upload init response missing Location header.');
    }

    // PUT the bytes. Even though the upload session token is baked
    // into the Location URL as a query param, we must also send the
    // bearer token here — without it Google's UploadServer (the
    // backend the upload URL points to) omits Access-Control-Allow-*
    // headers from the response, and the browser blocks us from
    // reading the file metadata back (CORS-style error) even though
    // the server-side upload succeeds (X-Goog-Upload-Status: final).
    // Sending Authorization triggers an extra preflight, but that's
    // cheap and predictable.
    const contentResp = await this.authedFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: contentBody,
    });
    if (!contentResp.ok) {
      throw new Error(
        `pushSlot content upload failed: ${contentResp.status} ${await safeText(contentResp)}`,
      );
    }
    const data = (await contentResp.json()) as {
      id?: string;
      modifiedTime?: string;
      version?: string;
      md5Checksum?: string;
    };
    if (!data.id || !data.modifiedTime) {
      throw new Error('pushSlot upload response was malformed.');
    }
    return {
      cloudId: data.id,
      etag: data.md5Checksum ?? data.version ?? data.modifiedTime,
      updatedAt: data.modifiedTime,
    };
  }

  async removeCloudSlot(cloudId: string): Promise<void> {
    await this.refreshTokenIfNeeded();
    const resp = await this.authedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(cloudId)}`,
      { method: 'DELETE' },
    );
    // 204 No Content on success; 404 is fine too (file already gone is
    // the desired end state).
    if (resp.status === 404 || resp.ok) return;
    throw new Error(`removeCloudSlot failed: ${resp.status} ${await safeText(resp)}`);
  }

  /**
   * Cheap one-trip metadata call that returns just the current etag.
   * Returns null on 404 so the caller can route to the create-new
   * fallback without throwing.
   *
   * Etag preference: `md5Checksum` first, then `version`, then
   * `modifiedTime`. We avoid `version` as the primary because Drive
   * bumps `version` during post-upload processing (label/index/parent
   * reconciliation) even when content didn't change, which produces
   * false-positive "cloud changed elsewhere" warnings on consecutive
   * same-machine pushes. `md5Checksum` is content-derived: identical
   * bytes round-trip to identical md5, and a real cross-device write
   * is guaranteed to change the bytes (and therefore the md5). The
   * `version`/`modifiedTime` fallbacks only fire for the rare Drive
   * file types where md5 is omitted (Google Docs etc.) — never our
   * own uploaded JSON.
   */
  private async peekEtag(cloudId: string): Promise<string | null> {
    const resp = await this.authedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(cloudId)}?fields=md5Checksum,version,modifiedTime`,
    );
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`peekEtag failed: ${resp.status}`);
    }
    const data = (await resp.json()) as {
      md5Checksum?: string;
      version?: string;
      modifiedTime?: string;
    };
    return data.md5Checksum ?? data.version ?? data.modifiedTime ?? null;
  }

  // ----- internal -----

  private async authedFetch(url: string, init?: RequestInit): Promise<Response> {
    const tokens = readTokens();
    if (!tokens) throw new Error('Not signed in.');
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${tokens.accessToken}`);
    return fetch(url, { ...init, headers });
  }
}

// ---------- helpers (URL / response) ----------

function redirectUri(): string {
  // Strip hash + search so the registered redirect URI exactly matches
  // {origin}{pathname}. OAuth providers reject any drift.
  return window.location.origin + window.location.pathname;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '<no body>';
  }
}

/**
 * Build the bytes uploaded to Drive: the same `SaveFile` envelope
 * shape `downloadSave` produces. Pushing the envelope (instead of just
 * `AutosaveBlob`) means a file in Drive can be downloaded by the user
 * via Drive's own UI and re-imported into the app via "Load save
 * file…" without any reshaping — round-trips cleanly through the
 * existing single-slot import path.
 */
function buildCloudFileContent(blob: AutosaveBlob): {
  version: 3;
  createdAt: string;
  items: AutosaveBlob['items'];
  progress: AutosaveBlob['progress'];
  undoRing: AutosaveBlob['undoRing'];
} {
  return {
    version: 3,
    createdAt: new Date().toISOString(),
    items: blob.items,
    progress: blob.progress,
    undoRing: blob.undoRing,
  };
}

/**
 * Typed error the App layer pattern-matches to render the pre-Push
 * stale-cache confirm modal. Carries both etags so the modal could
 * surface "your copy thinks the cloud is at version X, but it's
 * actually at Y" detail if we ever want to.
 */
export class CloudEtagMismatchError extends Error {
  readonly serverEtag: string;
  readonly expectedEtag: string;
  constructor(serverEtag: string, expectedEtag: string) {
    super(
      `Cloud copy was modified elsewhere (server etag=${serverEtag}, ` +
        `expected=${expectedEtag}).`,
    );
    this.name = 'CloudEtagMismatchError';
    this.serverEtag = serverEtag;
    this.expectedEtag = expectedEtag;
  }
}

/**
 * Validate inbound Drive file content. The body might be a SaveFile
 * envelope (what `downloadSave` produces and what `pushSlot` uploads)
 * or just an AutosaveBlob. Accept both shapes so a hand-edited file
 * pulled by the app still works.
 */
function parseCloudBlob(json: unknown): AutosaveBlob {
  if (!json || typeof json !== 'object') {
    throw new Error('Pulled file is not a valid sorter blob.');
  }
  const obj = json as {
    items?: unknown;
    progress?: unknown;
    undoRing?: unknown;
  };
  if (!obj.items || !obj.progress) {
    throw new Error('Pulled file is missing required fields.');
  }
  return {
    items: obj.items as AutosaveBlob['items'],
    progress: obj.progress as AutosaveBlob['progress'],
    undoRing: Array.isArray(obj.undoRing) ? (obj.undoRing as AutosaveBlob['undoRing']) : [],
  };
}

// ---------- gapi/picker ambient types ----------

/**
 * Narrow ambient types for the gapi + picker globals injected by
 * `https://apis.google.com/js/api.js`. Just enough to satisfy the
 * picker call site without pulling in `@types/gapi`.
 */
interface GapiNamespace {
  load: (lib: string, opts: { callback: () => void }) => void;
}

interface PickerResponseData {
  action: string;
  docs?: Array<{ id: string; name: string }>;
}

interface PickerNamespace {
  Action: { CANCEL: string; PICKED: string };
  ViewId: { FOLDERS: string };
  DocsView: new (viewId: string) => PickerDocsViewBuilder;
  PickerBuilder: new () => PickerBuilder;
}

interface PickerDocsViewBuilder {
  setSelectFolderEnabled(enabled: boolean): PickerDocsViewBuilder;
  setMimeTypes(mimeTypes: string): PickerDocsViewBuilder;
}

interface PickerBuilder {
  addView(view: PickerDocsViewBuilder): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setCallback(cb: (data: PickerResponseData) => void): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  build(): PickerInstance;
}

interface PickerInstance {
  setVisible(visible: boolean): void;
}

