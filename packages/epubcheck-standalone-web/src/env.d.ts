/// <reference types="astro/client" />

// Vite worker URL imports (bundled worker script as a URL string).
declare module "*?worker&url" {
  const src: string;
  export default src;
}
