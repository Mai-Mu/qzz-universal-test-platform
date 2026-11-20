import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));
const skillUrl = new URL('../.agents/skills/qzz-test-case-writer/SKILL.md', import.meta.url);
const tempDir = await mkdtemp(path.join(tmpdir(), 'test-platform-mcp-'));
const dbPath = path.join(tempDir, 'test.db');
const backupDir = path.join(tempDir, 'backups');
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE test_cases (
    id TEXT PRIMARY KEY, project_id INTEGER DEFAULT 1, module_id INTEGER NOT NULL,
    module_name TEXT NOT NULL, bg_info TEXT, title TEXT NOT NULL, precondition TEXT,
    steps TEXT NOT NULL, expected TEXT NOT NULL, status TEXT DEFAULT 'untested',
    notes TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
  );
`);
db.close();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, TEST_PLATFORM_DB: dbPath, TEST_PLATFORM_BACKUP_DIR: backupDir },
  stderr: 'pipe'
});
const client = new Client({ name: 'test-platform-smoke', version: '1.0.0' });

const testPackage = {
  project: { name: 'MCP 回归项目', description: '隔离环境端到端测试' },
  documents: [{ title: '执行说明', content: '先执行主流程。' }],
  folders: [{
    name: 'P0 主流程',
    modules: [{
      name: '登录',
      background: '验证基础登录能力',
      cases: [{
        id: 'TC-P0-001',
        title: '账号密码登录',
        precondition: '账号已启用',
        steps: [
          { action: '1.输入正确账号密码并提交', expected: '1. 登录成功并进入首页' },
          { action: '2、读取最近登录时间', expected: '2、展示最近登录时间' },
          { action: '3.5 秒后刷新首页', expected: '3.A-01 会话标识保持不变' },
          { action: '核对提示中的 4. 号记录', expected: '提示包含 7. 登录成功' }
        ]
      }]
    }]
  }]
};
const normalizedSteps = [
  { action: '输入正确账号密码并提交', expected: '登录成功并进入首页' },
  { action: '读取最近登录时间', expected: '展示最近登录时间' },
  { action: '3.5 秒后刷新首页', expected: '3.A-01 会话标识保持不变' },
  { action: '核对提示中的 4. 号记录', expected: '提示包含 7. 登录成功' }
];
const stepActions = normalizedSteps.map(step => step.action);
const stepExpectations = normalizedSteps.map(step => step.expected);

try {
  await client.connect(transport);
  assert.match(client.getInstructions(), /get_test_case_guidelines/);
  assert.match(client.getInstructions(), /共用准备说明/);
  assert.match(client.getInstructions(), /省略列表序号/);
  const listedTools = await client.listTools();
  assert.deepEqual(listedTools.tools.map(tool => tool.name), [
    'get_test_case_guidelines', 'list_test_projects', 'get_test_project', 'validate_test_package',
    'import_test_package', 'get_import_result'
  ]);
  const guidelinesTool = listedTools.tools.find(tool => tool.name === 'get_test_case_guidelines');
  assert.equal(guidelinesTool.annotations?.readOnlyHint, true);
  const validateTool = listedTools.tools.find(tool => tool.name === 'validate_test_package');
  const folder = validateTool.inputSchema.properties.package.properties.folders.items;
  const module = folder.properties.modules.items;
  const caseFields = module.properties.cases.items.properties;
  assert.match(caseFields.precondition.description, /documents/);
  assert.match(caseFields.steps.items.properties.action.description, /列表序号/);

  const validate = parse(await client.callTool({
    name: 'validate_test_package', arguments: { mode: 'create', source: 'smoke', package: testPackage }
  }));
  assert.equal(validate.valid, true);
  assert.equal(validate.summary.cases, 1);

  const numberedBlankPackage = structuredClone(testPackage);
  numberedBlankPackage.folders[0].modules[0].cases[0].steps[0] = { action: '1.', expected: '1、' };
  const numberedBlank = parse(await client.callTool({
    name: 'validate_test_package',
    arguments: { mode: 'create', source: 'smoke', package: numberedBlankPackage }
  }));
  assert.equal(numberedBlank.valid, false);
  assert.ok(numberedBlank.errors.some(error => error.includes('steps[0].action 不能为空')));
  assert.ok(numberedBlank.errors.some(error => error.includes('steps[0].expected 不能为空')));

  const imported = parse(await client.callTool({
    name: 'import_test_package', arguments: { mode: 'create', source: 'smoke', package: testPackage }
  }));
  assert.equal(imported.imported, true);
  assert.equal(imported.summary.insertedCases, 1);
  assert.ok(imported.backupFilename);

  const duplicate = parse(await client.callTool({
    name: 'validate_test_package',
    arguments: { mode: 'append', source: 'smoke', package: { ...testPackage, project: { name: 'MCP 回归项目' } } }
  }));
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.summary.existingCaseConflicts, 1);

  const targetDb = new DatabaseSync(dbPath);
  targetDb.prepare(`
    UPDATE test_cases SET status = 'passed', notes = '保留执行信息', steps = ?, expected = ?
    WHERE project_id = 1 AND id = 'TC-P0-001'
  `).run(
    JSON.stringify(stepActions.map((action, index) => `${index + 1}. ${action}`)),
    JSON.stringify(stepExpectations.map((expected, index) => `${index + 1}. ${expected}`))
  );
  targetDb.close();
  const legacyProject = parse(await client.callTool({
    name: 'get_test_project', arguments: { projectName: 'MCP 回归项目' }
  }));
  assert.deepEqual(legacyProject.folders[0].modules[0].cases[0].steps, normalizedSteps);
  const updatedPackage = structuredClone(testPackage);
  updatedPackage.project = { name: 'MCP 回归项目' };
  updatedPackage.folders[0].modules[0].cases[0].title = '账号密码登录（更新）';
  const updated = parse(await client.callTool({
    name: 'import_test_package', arguments: { mode: 'upsert', source: 'smoke', package: updatedPackage }
  }));
  assert.equal(updated.imported, true);
  assert.equal(updated.summary.updatedCases, 1);

  const project = parse(await client.callTool({
    name: 'get_test_project', arguments: { projectName: 'MCP 回归项目' }
  }));
  const importedCase = project.folders[0].modules[0].cases[0];
  assert.equal(importedCase.title, '账号密码登录（更新）');
  assert.equal(importedCase.status, 'passed');
  assert.equal(importedCase.notes, '保留执行信息');
  assert.equal(importedCase.precondition, '账号已启用');
  assert.deepEqual(importedCase.steps, normalizedSteps);

  const result = parse(await client.callTool({
    name: 'get_import_result', arguments: { batchId: updated.batchId }
  }));
  assert.equal(result.status, 'completed');

  const secondPackage = structuredClone(testPackage);
  secondPackage.project = { name: 'MCP 第二项目', description: '验证项目级编号唯一性' };
  const secondImport = parse(await client.callTool({
    name: 'import_test_package', arguments: { mode: 'create', source: 'smoke', package: secondPackage }
  }));
  assert.equal(secondImport.imported, true);
  assert.equal(secondImport.summary.insertedCases, 1);

  const migratedDb = new DatabaseSync(dbPath);
  const primaryKey = migratedDb.prepare('PRAGMA table_info(test_cases)').all()
    .filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
  assert.deepEqual(primaryKey, ['project_id', 'id']);
  const storedCases = migratedDb.prepare("SELECT steps, expected FROM test_cases WHERE id = 'TC-P0-001'").all();
  assert.equal(storedCases.length, 2);
  for (const storedCase of storedCases) {
    assert.deepEqual(JSON.parse(storedCase.steps), stepActions);
    assert.deepEqual(JSON.parse(storedCase.expected), stepExpectations);
  }
  assert.equal(migratedDb.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 3);
  migratedDb.close();
  await verifyFreshCheckout();
  console.log('MCP smoke test passed: companion skill, fresh database, project-scoped IDs, imports and audit verified.');
} finally {
  await client.close().catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
}

async function verifyFreshCheckout() {
  const freshDbPath = path.join(tempDir, 'fresh-checkout', 'data', 'testcases.db');
  await assert.rejects(access(path.dirname(freshDbPath)), { code: 'ENOENT' });
  const freshClient = new Client({ name: 'test-platform-fresh-checkout-smoke', version: '1.0.0' });
  const freshTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: tempDir,
    env: { ...process.env, TEST_PLATFORM_DB: freshDbPath, TEST_PLATFORM_BACKUP_DIR: backupDir },
    stderr: 'pipe'
  });
  try {
    await freshClient.connect(freshTransport);
    await access(freshDbPath);
    const result = await freshClient.callTool({ name: 'get_test_case_guidelines' });
    assert.ok(!result.isError);
    assert.deepEqual(result.content, [{ type: 'text', text: await readFile(skillUrl, 'utf8') }]);
  } finally {
    await freshClient.close().catch(() => {});
  }
}

function parse(result) {
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
