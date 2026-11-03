import { createInterface } from 'node:readline/promises';
import { assertStrongPassword, hashPassword } from '../auth/passwords.js';
import { AuthService } from '../auth/service.js';
import { loadConfig } from '../config.js';
import { openDatabase, Store } from '../db.js';
import { randomToken } from '../utils/crypto.js';

interface Args {
  email?: string;
  password?: string;
  displayName?: string;
  admin: boolean;
  random: boolean;
  update: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    admin: false,
    random: false,
    update: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    switch (arg) {
      case '--email':
        args.email = next;
        index += 1;
        break;
      case '--password':
        args.password = next;
        index += 1;
        break;
      case '--display-name':
        args.displayName = next;
        index += 1;
        break;
      case '--admin':
        args.admin = true;
        break;
      case '--random':
        args.random = true;
        break;
      case '--update':
        args.update = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Opción desconocida: ${arg}`);
    }
  }
  return args;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'No hay terminal interactiva. Usa ADMIN_PASSWORD o --password, o genera una con --random.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const mutable = rl as unknown as { _writeToOutput?: (value: string) => void };
  const original = mutable._writeToOutput;
  mutable._writeToOutput = function write(value: string) {
    if (value.includes('Contraseña:')) {
      original?.call(this, value);
    } else {
      original?.call(this, '');
    }
  };
  try {
    const password = await rl.question('Contraseña (mínimo 12 caracteres): ');
    process.stdout.write('\n');
    return password;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Uso: npm run create-admin -- [opciones]

Opciones:
  --email <correo>          Correo de la cuenta (o variable ADMIN_EMAIL)
  --password <clave>        Contraseña (o ADMIN_PASSWORD; evita dejarla en el historial)
  --random                  Genera una contraseña aleatoria y la muestra una vez
  --display-name <texto>    Nombre visible
  --admin                   Crea el rol administrador
  --update                  Actualiza la contraseña si la cuenta ya existe
  --help                    Muestra esta ayuda

Ejemplo seguro:
  read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
  npm run create-admin -- --email tu@correo.com
`);
    return;
  }

  const config = loadConfig();
  const email = (args.email ?? process.env.ADMIN_EMAIL ?? (await prompt('Correo: ')))
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Correo inválido.');
  }
  let password =
    args.password ?? process.env.ADMIN_PASSWORD ?? (args.random ? null : await promptPassword());
  let generated: string | null = null;
  if (!password) {
    generated = randomToken(24);
    password = generated;
  }
  assertStrongPassword(password, email);

  const db = openDatabase(config.databasePath);
  const store = new Store(db);
  const auth = new AuthService(store, config);
  try {
    const existing = store.findUserByEmail(email);
    if (existing) {
      if (!args.update) {
        throw new Error(
          'Esa cuenta ya existe. Usa --update si quieres cambiar su contraseña, o inicia sesión.',
        );
      }
      const passwordHash = await hashPassword(password);
      store.updateUserPassword(existing.id, passwordHash, Date.now());
      store.deleteOtherSessions(existing.id);
      console.log(`Contraseña actualizada para ${email}. Sesiones existentes cerradas.`);
    } else {
      const user = await auth.createUser({
        email,
        password,
        displayName: args.displayName,
        role: args.admin ? 'admin' : 'user',
      });
      console.log(`Cuenta creada: ${user.email} (rol: ${user.role}).`);
    }
    if (generated) {
      console.log(`Contraseña generada (guárdala ahora, no se volverá a mostrar): ${generated}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error('[forge] Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
