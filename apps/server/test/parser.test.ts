import { describe, expect, it } from 'vitest';
import { parseAssistantOutput, validateCommandText } from '../src/chat/parser.js';

describe('parseAssistantOutput', () => {
  it('extrae propuestas write y delete con etiquetas', () => {
    const parsed = parseAssistantOutput(`Revisé tu proyecto.

<proposal path="src/app.ts" action="write">
export const answer = 42;
</proposal>
<proposal path="src/old.ts" action="delete"></proposal>
<command>npm test</command>`);

    expect(parsed.proposals).toEqual([
      { path: 'src/app.ts', action: 'write', content: 'export const answer = 42;\n' },
      { path: 'src/old.ts', action: 'delete', content: '' },
    ]);
    expect(parsed.commands).toEqual([{ command: 'npm test' }]);
    expect(parsed.displayContent).toContain('Revisé tu proyecto.');
    expect(parsed.displayContent).toContain('src/app.ts');
    expect(parsed.displayContent).toContain('1 comando(s) propuesto(s)');
    expect(parsed.displayContent).not.toContain('<proposal');
    expect(parsed.displayContent).not.toContain('<command>');
    expect(parsed.warnings).toEqual([]);
  });

  it('extrae propuestas desde fences file: y proposal:', () => {
    const parsed = parseAssistantOutput(
      '```file:src/a.ts\nexport const a = 1;\n```\n\n```proposal:src/b.ts\nexport const b = 2;\n```',
    );
    expect(parsed.proposals).toEqual([
      { path: 'src/a.ts', action: 'write', content: 'export const a = 1;\n' },
      { path: 'src/b.ts', action: 'write', content: 'export const b = 2;\n' },
    ]);
  });

  it('bloquea traversal y rutas inválidas con advertencias', () => {
    const parsed = parseAssistantOutput(`<proposal path="../outside.ts">x</proposal>
<proposal path="/etc/passwd">x</proposal>
<proposal action="write">x</proposal>`);
    expect(parsed.proposals).toEqual([]);
    expect(parsed.warnings.length).toBe(3);
    expect(parsed.warnings[0]).toContain('inválida');
  });

  it('ignora propuestas duplicadas y rechaza acciones desconocidas', () => {
    const parsed = parseAssistantOutput(`<proposal path="src/a.ts" action="write">
uno
</proposal>
<proposal path="src/a.ts" action="write">
dos
</proposal>
<proposal path="src/b.ts" action="replace">
tres
</proposal>`);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.path).toBe('src/a.ts');
    expect(parsed.warnings.some((warning) => warning.includes('duplicada'))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes('Acción no soportada'))).toBe(true);
  });

  it('permite </proposal> dentro del contenido y usa el último cierre', () => {
    const parsed = parseAssistantOutput(`<proposal path="docs/ejemplo.md" action="write">
Texto que menciona </proposal> literalmente.
Más contenido.
</proposal>
<proposal path="src/b.ts" action="write">
export const b = 2;
</proposal>`);

    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.proposals[0]?.content).toBe(
      'Texto que menciona </proposal> literalmente.\nMás contenido.\n',
    );
    expect(parsed.proposals[1]?.content).toBe('export const b = 2;\n');
    expect(parsed.displayContent).not.toContain('<proposal');
  });

  it('avisa y no crea propuestas cuando la respuesta está truncada sin cierre', () => {
    const parsed = parseAssistantOutput(`<proposal path="src/a.ts" action="write">
export const incompleto = true;
`);
    expect(parsed.proposals).toEqual([]);
    expect(parsed.warnings.some((warning) => warning.includes('sin etiqueta de cierre'))).toBe(
      true,
    );
  });

  it('limita la cantidad de propuestas y comandos', () => {
    const proposals = Array.from(
      { length: 25 },
      (_, index) => `<proposal path="src/file-${index}.ts">x</proposal>`,
    ).join('\n');
    const commands = Array.from(
      { length: 8 },
      (_, index) => `<command>npm run ${index}</command>`,
    ).join('\n');
    const parsed = parseAssistantOutput(`${proposals}\n${commands}`);
    expect(parsed.proposals).toHaveLength(20);
    expect(parsed.commands).toHaveLength(5);
    expect(parsed.warnings.some((warning) => warning.includes('máximo 20'))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes('máximo 5'))).toBe(true);
  });

  it('ignora comandos vacíos o demasiado largos', () => {
    const parsed = parseAssistantOutput(
      `<command>   </command>\n<command>${'npm '.repeat(200)}</command>`,
    );
    expect(parsed.commands).toEqual([]);
    expect(parsed.warnings.some((warning) => warning.includes('demasiado largo'))).toBe(true);
  });
});

describe('validateCommandText', () => {
  it('acepta comandos simples y comillas equilibradas', () => {
    expect(validateCommandText('npm test')).toEqual({ ok: true, argv: ['npm', 'test'] });
    expect(validateCommandText('git status --short')).toEqual({
      ok: true,
      argv: ['git', 'status', '--short'],
    });
    expect(validateCommandText(`node -e "console.log('ok')"`)).toEqual({
      ok: true,
      argv: ['node', '-e', "console.log('ok')"],
    });
  });

  it('rechaza operadores de shell y sustitución', () => {
    for (const command of [
      'npm test && rm -rf .',
      'npm test; ls',
      'cat file | grep x',
      'echo hi > out.txt',
      'echo < in.txt',
      'echo `id`',
      'echo $(id)',
      'echo $HOME',
    ]) {
      expect(validateCommandText(command).ok).toBe(false);
    }
  });

  it('rechaza rutas absolutas, traversal y asignaciones de entorno', () => {
    expect(validateCommandText('cat /etc/passwd').ok).toBe(false);
    expect(validateCommandText('node C:\\Windows\\x.js').ok).toBe(false);
    expect(validateCommandText('cat ../secret').ok).toBe(false);
    expect(validateCommandText('FOO=bar node server.js').ok).toBe(false);
    expect(validateCommandText('git --git-dir=.git status').ok).toBe(false);
    expect(validateCommandText('git --work-tree=/tmp status').ok).toBe(false);
  });

  it('rechaza comandos vacíos, multilínea y comillas sin cerrar', () => {
    expect(validateCommandText('   ').ok).toBe(false);
    expect(validateCommandText('npm test\nrm -rf /').ok).toBe(false);
    expect(validateCommandText('node "unclosed').ok).toBe(false);
    expect(validateCommandText('x'.repeat(501)).ok).toBe(false);
  });
});
