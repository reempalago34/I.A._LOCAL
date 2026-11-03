import { hash, verify } from '@node-rs/argon2';
import { AppError } from '../utils/errors.js';

// Algorithm.Argon2id (2) es el valor por defecto del paquete, pero el enum es
// un `const enum` ambiental y no puede referenciarse con isolatedModules.
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

const COMMON_PASSWORDS = new Set([
  '123456789012',
  'password1234',
  'password12345',
  'qwertyuiop123',
  'administrador',
  'contraseña123',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'iloveyou1234',
]);

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export function assertStrongPassword(password: string, email?: string): void {
  if (password.length < 12) {
    throw new AppError(400, 'WEAK_PASSWORD', 'La contraseña debe tener al menos 12 caracteres.');
  }
  if (password.length > 200) {
    throw new AppError(400, 'WEAK_PASSWORD', 'La contraseña no puede superar 200 caracteres.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError(400, 'WEAK_PASSWORD', 'Esa contraseña es demasiado común. Elige otra.');
  }
  if (email && password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) {
    throw new AppError(400, 'WEAK_PASSWORD', 'La contraseña no debe contener tu correo.');
  }
  if (new Set(password).size < 5) {
    throw new AppError(400, 'WEAK_PASSWORD', 'La contraseña es demasiado repetitiva.');
  }
}
