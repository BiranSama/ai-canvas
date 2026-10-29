const BASE_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
] as const

/**
 * Vite injects an inline React Refresh preamble only while a renderer dev URL
 * is active. Production bundles remain on a self-only script policy, plus
 * compiling WebAssembly, which the object selection's model runs on.
 */
export function rendererContentSecurityPolicy(rendererUrl: string | undefined): string {
  const scriptSource = rendererUrl ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" : "script-src 'self' 'wasm-unsafe-eval'"
  return [BASE_DIRECTIVES[0], scriptSource, ...BASE_DIRECTIVES.slice(1)].join('; ')
}
