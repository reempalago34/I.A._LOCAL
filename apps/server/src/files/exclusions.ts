import picomatch from 'picomatch';

export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  '.git',
  '.git/**',
  '.hg',
  '.hg/**',
  '.svn',
  '.svn/**',
  'node_modules',
  'node_modules/**',
  'dist',
  'dist/**',
  'build',
  'build/**',
  'out',
  'out/**',
  'coverage',
  'coverage/**',
  '.next',
  '.next/**',
  '.nuxt',
  '.nuxt/**',
  '.cache',
  '.cache/**',
  '.turbo',
  '.turbo/**',
  '.parcel-cache',
  '.parcel-cache/**',
  '.venv',
  '.venv/**',
  'venv',
  'venv/**',
  'venv/**',
  '__pycache__',
  '__pycache__/**',
  '.pytest_cache',
  '.pytest_cache/**',
  'target',
  'target/**',
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
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '*.kdbx',
  'credentials*',
  'secrets*',
  '*secret*',
  '*token*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.aws/**',
  '.ssh/**',
  '.gnupg/**',
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

const DIRECTORY_SEGMENT_BLOCKLIST = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'target',
  '.aws',
  '.ssh',
  '.gnupg',
]);

export interface ExclusionMatcher {
  isExcluded(relativePath: string): boolean;
  patterns: string[];
}

export function createExclusionMatcher(userPatterns: readonly string[] = []): ExclusionMatcher {
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS, ...sanitizePatterns(userPatterns)];
  const matchers = patterns.map((pattern) =>
    picomatch(pattern, { dot: true, nocase: false, bash: true }),
  );

  return {
    patterns,
    isExcluded(relativePath: string): boolean {
      const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      if (!normalized) return false;
      const segments = normalized.split('/').filter(Boolean);
      for (const segment of segments) {
        if (DIRECTORY_SEGMENT_BLOCKLIST.has(segment.toLowerCase())) return true;
      }
      const basename = segments.at(-1) ?? normalized;
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

export function isObviouslySecretName(name: string): boolean {
  return /(?:^|[._-])(?:env|secret|secrets|token|tokens|credential|credentials|password|passwd|apikey|api_key|privatekey)(?:$|[._-])/i.test(
    name,
  );
}
