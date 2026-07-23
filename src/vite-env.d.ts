/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAL_CLIENT_ID?: string;
  readonly VITE_MAL_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}
