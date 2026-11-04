import { describe, expect, it } from 'vitest';
import { touchesScriptConfiguration } from './commandRisk';

describe('touchesScriptConfiguration', () => {
  it('detecta package.json, scripts y configuración de CI', () => {
    expect(touchesScriptConfiguration(['package.json'])).toBe(true);
    expect(touchesScriptConfiguration(['apps/web/package.json'])).toBe(true);
    expect(touchesScriptConfiguration(['scripts/deploy.sh'])).toBe(true);
    expect(touchesScriptConfiguration(['.github/workflows/ci.yml'])).toBe(true);
    expect(touchesScriptConfiguration(['.gitlab-ci.yml'])).toBe(true);
    expect(touchesScriptConfiguration(['Jenkinsfile'])).toBe(true);
  });

  it('ignora cambios que no afectan a scripts', () => {
    expect(touchesScriptConfiguration([])).toBe(false);
    expect(touchesScriptConfiguration(['src/index.ts', 'README.md'])).toBe(false);
    expect(touchesScriptConfiguration(['docs/scripts/guide.md'])).toBe(false);
  });
});
