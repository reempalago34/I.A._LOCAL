import { isObviouslySecretName } from '../files/exclusions.js';

export interface ProposalSensitivity {
  sensitive: boolean;
  reason?: string;
}

const CI_PATHS = [
  '.gitlab-ci.yml',
  '.travis.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'jenkinsfile',
  'appveyor.yml',
];

const DEPLOYMENT_NAMES = [
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'procfile',
  'makefile',
  'nginx.conf',
];

/**
 * Marca propuestas que merecen una confirmación adicional: secretos,
 * configuración de CI/despliegue, scripts y código de autenticación. No bloquea
 * la propuesta; solo la señala en la API y en la UI.
 */
export function analyzeProposalSensitivity(rawPath: string): ProposalSensitivity {
  const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const name = path.split('/').at(-1) ?? path;

  if (isObviouslySecretName(name)) {
    return {
      sensitive: true,
      reason:
        'Puede contener secretos, credenciales o claves. Revisa el diff y evita aplicar cambios no verificados.',
    };
  }
  if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
    return {
      sensitive: true,
      reason: 'Modifica la configuración de integración continua (GitHub Actions).',
    };
  }
  if (path.startsWith('.circleci/') || path.startsWith('.buildkite/') || CI_PATHS.includes(name)) {
    return {
      sensitive: true,
      reason: 'Modifica la configuración de integración continua.',
    };
  }
  if (name === 'package.json') {
    return {
      sensitive: true,
      reason:
        'Modifica dependencias o scripts que pueden ejecutarse al instalar, compilar o probar.',
    };
  }
  if (path.startsWith('scripts/') || DEPLOYMENT_NAMES.includes(name)) {
    return {
      sensitive: true,
      reason: 'Modifica scripts o configuración de despliegue que pueden ejecutar código.',
    };
  }
  if (
    path.startsWith('auth/') ||
    path.startsWith('src/auth/') ||
    path.includes('/auth/') ||
    /(?:^|\/)(?:security|crypto|sessions?|passwords?|jwt)(?:\/|\.|$)/.test(path)
  ) {
    return {
      sensitive: true,
      reason: 'Modifica código de autenticación, sesiones o criptografía.',
    };
  }
  return { sensitive: false };
}
