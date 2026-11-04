/**
 * Indica si alguna propuesta aplicada en esta sesión tocó la configuración de
 * scripts o CI. Se usa para avisar antes de ejecutar `npm test`/`npm run ...`.
 */
export function touchesScriptConfiguration(paths: readonly string[]): boolean {
  return paths.some((rawPath) => {
    const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const name = path.split('/').at(-1) ?? path;
    if (name === 'package.json') return true;
    if (path.startsWith('scripts/')) return true;
    if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) return true;
    if (path.startsWith('.circleci/') || path.startsWith('.buildkite/')) return true;
    return [
      '.gitlab-ci.yml',
      '.travis.yml',
      'azure-pipelines.yml',
      'bitbucket-pipelines.yml',
      'jenkinsfile',
      'appveyor.yml',
    ].includes(name);
  });
}
