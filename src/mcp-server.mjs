import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ensurePlatformSchema } = require('./lib/platform-db.cjs');
const {
  getImportResult,
  getProject,
  importPackage,
  listProjects,
  validatePackage
} = require('./lib/test-package-service.cjs');

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDir, '..');
const testCaseSkillPath = path.join(projectRoot, '.agents', 'skills', 'qzz-test-case-writer', 'SKILL.md');
const dbPath = path.resolve(process.env.TEST_PLATFORM_DB || path.join(projectRoot, 'data', 'testcases.db'));
const backupDir = path.resolve(process.env.TEST_PLATFORM_BACKUP_DIR || path.join(projectRoot, 'data', 'backups'));
await mkdir(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
ensurePlatformSchema(db);

const projectDocumentsGuidance = '将项目范围、共用准备说明、环境、通用测试数据、执行注意事项和验收口径集中写在项目说明。';
const preconditionGuidance = '仅写执行当前用例必需的初始状态和专用数据，保留影响结果的条件和数值。共用准备说明写入 documents，需要时引用其中相关段落。';
const stepTextGuidance = '填写正文，省略列表序号和项目符号，保留有业务含义的编号和数值。';
const importInstructions = [
  '生成测试用例或规范化外部用例时，先调用 get_test_case_guidelines 读取项目配套技能，按规范生成或整理并复核。',
  '默认交付用例。目标明确时可调用 validate_test_package 只读预检。用户明确要求导入时，确认目标、预检通过后再调用 import_test_package。',
  '按项目、目录、模块和用例组织。依据原始资料保留业务条件、数据和验收口径。',
  `项目说明 documents。${projectDocumentsGuidance}`,
  `用例前置条件 precondition。${preconditionGuidance}`,
  `每个 steps 元素只包含这一步的操作 action 和对应预期 expected。步骤顺序由数组表达。${stepTextGuidance}`,
  '用 list_test_projects 确认目标项目。预检返回 errors 时，修正后重新预检。'
].join('\n');

const projectSelectorSchema = {
  type: 'object',
  properties: {
    projectId: { type: 'integer', minimum: 1, description: '平台项目 ID。与 projectName 二选一。' },
    projectName: { type: 'string', minLength: 1, description: '平台项目名称。与 projectId 二选一。' }
  },
  additionalProperties: false
};

const packageSchema = {
  type: 'object',
  required: ['project', 'folders'],
  additionalProperties: false,
  properties: {
    project: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer', minimum: 1 },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' }
      }
    },
    documents: {
      type: 'array',
      description: projectDocumentsGuidance,
      items: {
        type: 'object',
        required: ['title', 'content'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1 },
          content: { type: 'string', description: '支持 Markdown 列表、引用和表格。' }
        }
      }
    },
    folders: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'modules'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          modules: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'cases'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1 },
                background: { type: 'string' },
                cases: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'title', 'steps'],
                    additionalProperties: false,
                    properties: {
                      id: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$',
                        description: '项目内稳定且唯一的用例编号，例如 TC-P0-001。'
                      },
                      title: { type: 'string', minLength: 1 },
                      precondition: { type: 'string', description: preconditionGuidance },
                      steps: {
                        type: 'array',
                        minItems: 1,
                        description: '按执行顺序逐步填写，每一步包含一组操作和对应预期。页面根据数组顺序展示步骤。',
                        items: {
                          type: 'object',
                          required: ['action', 'expected'],
                          additionalProperties: false,
                          properties: {
                            action: { type: 'string', minLength: 1, description: `本步操作。${stepTextGuidance}` },
                            expected: { type: 'string', minLength: 1, description: `本步预期结果。${stepTextGuidance}` }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

const importInputSchema = {
  type: 'object',
  required: ['mode', 'package'],
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['create', 'append', 'upsert'],
      description: 'create 新建项目；append 只追加且拒绝重复编号；upsert 按编号新增或更新并保留执行状态和备注。'
    },
    source: { type: 'string', description: '来源文档、任务或 Codex 会话的简短说明。' },
    package: packageSchema
  }
};

const tools = [
  {
    name: 'get_test_case_guidelines',
    description: '读取项目自带的测试用例 Skill。适用于根据需求生成用例、将外部用例规范化，以及复核用例的可执行性与平台适配。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_test_projects',
    description: '列出测试平台现有项目及用例、模块数量。新建或追加前应先调用，避免选错项目。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_test_project',
    description: '读取一个项目的说明、目录、模块、用例、状态和备注。增量生成或更新前使用。',
    inputSchema: projectSelectorSchema
  },
  {
    name: 'validate_test_package',
    description: '预检结构化测试包，不写数据库。正式导入前必须先调用并解决所有 errors。',
    inputSchema: importInputSchema
  },
  {
    name: 'import_test_package',
    description: '以事务导入已预检的测试包。导入前自动备份，失败时整体回滚并记录批次结果。',
    inputSchema: importInputSchema
  },
  {
    name: 'get_import_result',
    description: '按批次 ID 查询导入模式、来源、备份、统计结果或失败原因。',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      additionalProperties: false,
      properties: { batchId: { type: 'integer', minimum: 1 } }
    }
  }
];

const server = new Server(
  { name: 'universal-test-platform-mcp', version: '2.0.0' },
  { capabilities: { tools: {} }, instructions: importInstructions }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'get_test_case_guidelines') {
      const text = await readFile(testCaseSkillPath, 'utf8');
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'list_test_projects') return jsonResult({ projects: listProjects(db) });

    if (name === 'get_test_project') {
      const project = getProject(db, args);
      return project
        ? jsonResult(project)
        : jsonResult({ error: 'Project not found' }, true);
    }

    if (name === 'validate_test_package') {
      return jsonResult(publicValidation(validatePackage(db, args)));
    }

    if (name === 'import_test_package') {
      const result = importPackage(db, args, { dbPath, backupDir });
      return jsonResult(result, !result.imported);
    }

    if (name === 'get_import_result') {
      const result = getImportResult(db, Number(args.batchId));
      return result
        ? jsonResult(result)
        : jsonResult({ error: 'Import batch not found' }, true);
    }

    return jsonResult({ error: `Unknown tool: ${name}` }, true);
  } catch (error) {
    return jsonResult({ error: error.message }, true);
  }
});

function publicValidation(result) {
  const { normalized, ...publicResult } = result;
  return publicResult;
}

function jsonResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Universal Test Platform MCP v2 connected (${dbPath})`);
