import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, root), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const gpuOverride = read('docker-compose.gpu.yml');
const envExample = read('.env.example');
const healthcheck = read('docker/healthcheck.mjs');
const smokeTest = read('scripts/smoke-test.sh');

function serviceBlock(name: string): string {
  const match = compose.match(
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:|\\nnetworks:)`),
  );
  if (!match?.[1]) throw new Error(`No se encontró el servicio ${name} en docker-compose.yml`);
  return match[1];
}

describe('Dockerfile de producción', () => {
  it('compila y ejecuta con la misma versión fijada de Node', () => {
    expect(dockerfile).toMatch(/FROM node:22\.23\.4-bookworm-slim AS build/);
    expect(dockerfile).toMatch(/FROM node:22\.23\.4-bookworm-slim AS runtime/);
    expect(dockerfile).toContain('RUN npm ci --no-audit --no-fund');
    expect(dockerfile).toContain('npm prune --omit=dev');
  });

  it('ejecuta como usuario sin privilegios y no deja root por defecto', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^USER root$/m);
    expect(dockerfile).toContain('COPY --from=build --chown=node:node');
    expect(dockerfile).toContain('chown -R node:node /data /projects /app');
  });

  it('incluye healthcheck, señal de parada y solo artefactos de ejecución', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(dockerfile).toContain('CMD ["node", "docker/healthcheck.mjs"]');
    expect(dockerfile).toContain('/app/apps/server/dist');
    expect(dockerfile).toContain('/app/apps/web/dist');
    expect(runtime).not.toContain('python3 make g++');
  });
});

describe('docker-compose de producción', () => {
  const forge = serviceBlock('forge');
  const ollama = serviceBlock('ollama');

  it('exige un secreto de sesión externo y no usa credenciales por defecto', () => {
    expect(forge).toContain('SESSION_SECRET: ${SESSION_SECRET:?');
    expect(forge).not.toMatch(/SESSION_SECRET: [^$\n]+/);
    expect(forge).toContain('ALLOW_REGISTRATION: "false"');
    expect(forge).toContain('ALLOW_CUSTOM_RUNTIME: "false"');
    expect(forge).toMatch(/ENABLE_COMMAND_EXECUTION: \$\{ENABLE_COMMAND_EXECUTION:-false\}/);
  });

  it('solo publica la aplicación en loopback y nunca publica Ollama', () => {
    expect(forge).toMatch(/"127\.0\.0\.1:\$\{FORGE_HOST_PORT:-8080\}:8080"/);
    expect(ollama).toContain('expose:');
    expect(ollama).toContain('- "11434"');
    expect(ollama).not.toMatch(/^\s{4}ports:/m);
    expect(compose).not.toContain('network_mode: host');
    expect(compose).not.toContain('privileged: true');
    expect(compose).not.toContain('/var/run/docker.sock');
  });

  it('separa la red de runtime y limita capacidades del contenedor web', () => {
    expect(compose).toMatch(/^networks:$/m);
    expect(compose).toMatch(/^ {2}edge:$/m);
    expect(compose).toMatch(/^ {2}runtime:$/m);
    expect(forge).toMatch(/networks:\n\s+- edge\n\s+- runtime/);
    expect(ollama).toMatch(/networks:\n\s+- runtime/);
    expect(forge).toContain('read_only: true');
    expect(forge).toContain('no-new-privileges:true');
    expect(forge).toMatch(/cap_drop:\n\s+- ALL/);
    expect(forge).toContain('pids_limit: 256');
    expect(forge).toMatch(/mem_limit: \$\{FORGE_MEMORY_LIMIT:-1g\}/);
    expect(forge).toMatch(/cpus: \$\{FORGE_CPUS:-2\.0\}/);
    expect(forge).toContain('tmpfs:');
  });

  it('declara volúmenes persistentes, healthchecks y apagado ordenado', () => {
    expect(forge).toContain('forge-data:/data');
    expect(forge).toContain('forge-projects:/projects');
    expect(ollama).toContain('ollama-models:/root/.ollama');
    expect(compose).toMatch(/volumes:\n {2}forge-data:\n {2}forge-projects:\n {2}ollama-models:/);
    expect(forge).toContain('condition: service_healthy');
    expect(forge).toContain('test: ["CMD", "node", "docker/healthcheck.mjs"]');
    expect(ollama).toContain('ollama list >/dev/null 2>&1');
    expect(forge).toContain('stop_grace_period: 15s');
    expect(ollama).toContain('stop_grace_period: 20s');
  });

  it('mantiene el runtime apuntando a Ollama y limita modelos concurrentes', () => {
    expect(forge).toContain('OLLAMA_BASE_URL: http://ollama:11434');
    expect(forge).toContain('RUNTIME_ALLOWED_HOSTS: ollama');
    expect(forge).toContain('RUNTIME_ALLOWED_PORTS: "11434"');
    expect(ollama).toContain('OLLAMA_MAX_LOADED_MODELS: "1"');
    expect(ollama).toContain('OLLAMA_NUM_PARALLEL: "1"');
  });

  it('permite ajustar memoria y CPU de Ollama sin tocar el compose', () => {
    expect(ollama).toMatch(/mem_limit: \$\{OLLAMA_MEMORY_LIMIT:-12g\}/);
    expect(ollama).toMatch(/cpus: \$\{OLLAMA_CPUS:-4\.0\}/);
    expect(envExample).toContain('OLLAMA_MEMORY_LIMIT=12g');
  });
});

describe('override de GPU', () => {
  it('solicita el dispositivo NVIDIA sin publicar puertos', () => {
    expect(gpuOverride).toContain('driver: nvidia');
    expect(gpuOverride).toContain('capabilities: [gpu]');
    expect(gpuOverride).not.toContain('ports:');
    expect(gpuOverride).not.toContain('privileged: true');
  });
});

describe('plantilla de entorno', () => {
  it('no contiene secretos reales ni deja el secreto activo por defecto', () => {
    expect(envExample).toMatch(/^# SESSION_SECRET=\s*$/m);
    expect(envExample).not.toMatch(/^SESSION_SECRET=.+$/m);
    expect(envExample).toContain('ENABLE_COMMAND_EXECUTION=false');
    expect(envExample).toContain('ALLOW_REGISTRATION=false');
    expect(envExample).toContain('PROJECTS_ROOT');
  });
});

describe('healthcheck del contenedor', () => {
  it('consulta /readyz y no imprime secretos ni datos sensibles', () => {
    expect(healthcheck).toContain('/readyz');
    expect(healthcheck).toContain('127.0.0.1');
    expect(healthcheck).toContain('AbortSignal.timeout');
    expect(healthcheck).not.toMatch(/SESSION_SECRET|OLLAMA_AUTH_TOKEN|password/i);
  });
});

describe('smoke test de despliegue', () => {
  it('comprueba /healthz y /readyz sin enviar credenciales', () => {
    expect(smokeTest).toContain('/healthz');
    expect(smokeTest).toContain('/readyz');
    expect(smokeTest).toContain('curl');
    expect(smokeTest).toMatch(/FORGE_BASE_URL/);
    expect(smokeTest).not.toMatch(/SESSION_SECRET|OLLAMA_AUTH_TOKEN|password|cookie/i);
  });
});
