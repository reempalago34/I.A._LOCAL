import picomatch from 'picomatch';

/**
 * Patrones de archivos. Todos se evalúan sin distinguir mayúsculas y minúsculas
 * (`nocase`), de modo que `.ENV` o `SERVER.PEM` no se cuelan en el contexto.
 *
 * Las carpetas de dependencias, caché y control de versiones se tratan aparte
 * (`ALWAYS_BLOCKED_DIRECTORIES`) porque deben bloquearse a cualquier
 * profundidad. Las salidas de compilación (`ROOT_OUTPUT_DIRECTORIES`) solo se
 * bloquean en la raíz del proyecto: así `src/build/index.ts` sigue siendo un
 * archivo de código accesible.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // Secretos con nombres o extensiones concretas. Evitamos patrones amplios
  // como `*token*` o `*secret*`, que bloqueaban código legítimo.
  '.env',
  '.env.*',
  '*.env',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ppk',
  '*.kdbx',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'credentials.json',
  'credentials.yml',
  'credentials.yaml',
  'credentials.toml',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
  '*.secret',
  '*.secrets',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.aws/**',
  '.ssh/**',
  '.gnupg/**',
  // Salidas de compilación solo en la raíz.
  'dist',
  'dist/**',
  'build',
  'build/**',
  'out',
  'out/**',
  'target',
  'target/**',
  'coverage',
  'coverage/**',
  '.next',
  '.next/**',
  '.nuxt',
  '.nuxt/**',
  // Archivos binarios o que no aportan al contexto.
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.bmp',
  '*.tiff',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.mkv',
  '*.wav',
  '*.flac',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.bz2',
  '*.xz',
  '*.7z',
  '*.rar',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.bin',
  '*.class',
  '*.jar',
  '*.war',
  '*.o',
  '*.obj',
  '*.a',
  '*.lib',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.otf',
  '*.eot',
  '*.pdf',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

/** Carpetas que nunca deben recorrerse, estén donde estén. */
const ALWAYS_BLOCKED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.aws',
  '.ssh',
  '.gnupg',
]);

/** Salidas de compilación: solo se bloquean si están en la raíz del proyecto. */
const ROOT_OUTPUT_DIRECTORIES = new Set([
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
]);

export interface ExclusionMatcher {
  isExcluded(relativePath: string): boolean;
  patterns: string[];
}

export function createExclusionMatcher(userPatterns: readonly string[] = []): ExclusionMatcher {
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS, ...sanitizePatterns(userPatterns)];
  const matchers = patterns.map((pattern) =>
    picomatch(pattern, { dot: true, nocase: true, bash: true }),
  );

  return {
    patterns,
    isExcluded(relativePath: string): boolean {
      const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      if (!normalized) return false;
      const segments = normalized.split('/').filter(Boolean);
      const lowerSegments = segments.map((segment) => segment.toLowerCase());
      for (const segment of lowerSegments) {
        if (ALWAYS_BLOCKED_DIRECTORIES.has(segment)) return true;
      }
      // Solo la primera carpeta cuenta como salida de compilación del proyecto.
      if (lowerSegments.length > 0 && ROOT_OUTPUT_DIRECTORIES.has(lowerSegments[0]!)) {
        return true;
      }
      const basename = segments.at(-1) ?? normalized;
      if (isObviouslySecretName(basename)) return true;
      return matchers.some((matcher) => matcher(normalized) || matcher(basename));
    },
  };
}

export function sanitizePatterns(patterns: readonly string[]): string[] {
  return patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0 && pattern.length <= 200)
    .filter((pattern) => !pattern.startsWith('!'))
    .filter((pattern) => !pattern.includes('\0'))
    .slice(0, 100);
}

/**
 * Capa adicional y acotada para nombres evidentemente sensibles. No se usa
 * `token` ni `secret` sueltos: `tokenizer.ts`, `src/auth/token.ts` y
 * `design-tokens.css` son código legítimo. Se exigen nombres completos o
 * combinaciones con separadores (`api_token`, `my-secret-value`).
 */
export function isObviouslySecretName(name: string): boolean {
  if (!name) return false;
  if (/^(?:\.env|\.env\..+|.+\..+env)$/i.test(name)) return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwd|api[_-]?key|api[_-]?token|access[_-]?token|private[_-]?key)(?:$|[._-])/i.test(
    name,
  );
}
