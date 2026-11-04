import { describe, expect, it } from 'vitest';
import { analyzeProposalSensitivity } from '../src/proposals/sensitivity.js';

describe('analyzeProposalSensitivity', () => {
  it('marca secretos, CI, despliegue, scripts y autenticación', () => {
    for (const path of [
      'credentials.json',
      '.env',
      '.github/workflows/ci.yml',
      '.gitlab-ci.yml',
      'package.json',
      'scripts/deploy.sh',
      'Dockerfile',
      'docker-compose.yml',
      'src/auth/token.ts',
      'src/security/passwords.ts',
    ]) {
      expect(analyzeProposalSensitivity(path).sensitive, path).toBe(true);
    }
  });

  it('no marca código o documentación normal', () => {
    for (const path of [
      'README.md',
      'src/index.ts',
      'src/build/index.ts',
      'design-tokens.css',
      'docs/scripts/guide.md',
    ]) {
      expect(analyzeProposalSensitivity(path).sensitive, path).toBe(false);
    }
  });
});
