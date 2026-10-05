import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync, utimesSync } from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../src/config.js';
import { loadProject, contentDigest } from '../src/core/project.js';
import { auditProject } from '../src/core/audit.js';
import { runVerify } from '../src/core/verify.js';

// VERIFY_OBSOLETO compara o CONTEÚDO provado (digest gravado pelo verify),
// não o mtime: merge, rebase e checkout limpo regravam os arquivos com data
// nova sem mudar nada do que foi provado.

const SPEC = `# Spec: Entrega

> feature: entrega
> status: em-implementacao

## Histórias

### US-001 — Aluno entrega dever

Como aluno, quero enviar, para que corrijam.

#### AC-001 — Entrega no prazo

- **Dado** aluno autenticado
- **Quando** envia antes do prazo
- **Então** registra "no prazo"
`;

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onpspec-digest-'));
  roots.push(root);
  const files = {
    'onpspec.config.json': JSON.stringify({
      testCommand: `node -e "console.log('ok 1 - AC-001 no prazo @spec:AC-001')"`,
      reporter: 'tap',
    }),
    '.spec/features/entrega/spec.md': SPEC,
    'src/entrega.js': 'export const prazo = 1;\n',
    'test/entrega.test.js': `test('AC-001 no prazo @spec:AC-001', () => {});\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function load(root) {
  return loadProject(loadConfig(root));
}

function obsoletos(root) {
  return auditProject(load(root), { ci: true }).findings.filter((f) => f.code === 'VERIFY_OBSOLETO');
}

// Simula o checkout limpo: todo arquivo de código e teste ganha data nova.
function tocarTudo(root, quando) {
  for (const rel of ['src/entrega.js', 'test/entrega.test.js']) {
    utimesSync(path.join(root, rel), quando, quando);
  }
}

const FUTURO = new Date(Date.now() + 3_600_000);
const PASSADO = new Date(Date.now() - 3_600_000);

test('verify grava o digest do conteúdo de código e testes', () => {
  const root = makeProject();
  const { record } = runVerify(load(root), 'entrega');
  assert.match(record.digest, /^sha256:[0-9a-f]{64}$/);
  const gravado = JSON.parse(readFileSync(path.join(root, '.spec/verification/entrega.json'), 'utf-8'));
  assert.equal(gravado.digest, record.digest);
  assert.equal(gravado.results['AC-001'].status, 'pass');
});

test('checkout limpo sem mudança de conteúdo: mtime novo não acusa VERIFY_OBSOLETO', () => {
  const root = makeProject();
  runVerify(load(root), 'entrega');
  tocarTudo(root, FUTURO);
  assert.deepEqual(obsoletos(root), []);
});

test('conteúdo mudou: VERIFY_OBSOLETO mesmo com mtime anterior ao verify', () => {
  const root = makeProject();
  runVerify(load(root), 'entrega');
  writeFileSync(path.join(root, 'src/entrega.js'), 'export const prazo = 2;\n');
  tocarTudo(root, PASSADO);
  const achados = obsoletos(root);
  assert.equal(achados.length, 1);
  assert.equal(achados[0].severity, 'erro');
});

test('arquivo novo ou renomeado muda o digest e acusa VERIFY_OBSOLETO', () => {
  const novo = makeProject();
  runVerify(load(novo), 'entrega');
  writeFileSync(path.join(novo, 'src/extra.js'), 'export const x = 0;\n');
  utimesSync(path.join(novo, 'src/extra.js'), PASSADO, PASSADO);
  assert.equal(obsoletos(novo).length, 1);

  const renomeado = makeProject();
  runVerify(load(renomeado), 'entrega');
  renameSync(path.join(renomeado, 'src/entrega.js'), path.join(renomeado, 'src/entrega2.js'));
  assert.equal(obsoletos(renomeado).length, 1);
});

test('registro legado sem digest segue pelo mtime e pede verify para gravar o digest', () => {
  const root = makeProject();
  mkdirSync(path.join(root, '.spec/verification'), { recursive: true });
  writeFileSync(
    path.join(root, '.spec/verification/entrega.json'),
    JSON.stringify({
      feature: 'entrega',
      timestamp: PASSADO.toISOString(),
      results: { 'AC-001': { status: 'pass', testName: 'AC-001 @spec:AC-001' } },
    })
  );
  const achados = obsoletos(root);
  assert.equal(achados.length, 1);
  assert.match(achados[0].message, /digest/);
});

test('contentDigest: estável sob mudança de mtime, sensível a conteúdo e caminho', () => {
  const root = makeProject();
  const files = ['src/entrega.js', 'test/entrega.test.js'];
  const antes = contentDigest(root, files);
  tocarTudo(root, FUTURO);
  assert.equal(contentDigest(root, files), antes);
  assert.equal(contentDigest(root, [...files].reverse()), antes);
  assert.notEqual(contentDigest(root, ['src/entrega.js']), antes);
  writeFileSync(path.join(root, 'src/entrega.js'), 'export const prazo = 3;\n');
  assert.notEqual(contentDigest(root, files), antes);
});
