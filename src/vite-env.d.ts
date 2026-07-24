/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANIPLAYLIST_PROXY_URL?: string;
  readonly VITE_MAL_CLIENT_ID?: string;
  readonly VITE_MAL_PROXY_URL?: string;
  readonly VITE_SPOTIFY_CLIENT_ID?: string;
  readonly VITE_SPOTIFY_CLIENT_SECRET?: string;
  readonly VITE_SPOTIFY_OAUTH_CALLBACK_URL?: string;
  readonly VITE_SPOTIFY_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}
