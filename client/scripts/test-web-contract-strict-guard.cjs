const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_MACHINE_MARKER = 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE';

function isExpectedPendingFailureGuardResult(result) {
  if (!result || result.status !== 1 || result.error) {
    return false;
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const markerCount = (output.match(new RegExp(EXPECTED_MACHINE_MARKER, 'g')) || []).length;
  if (markerCount !== 1) {
    return false;
  }

  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const summaryLines = lines.filter((line) => /^失败:\s*1$/.test(line.trim()));
  if (summaryLines.length !== 1) {
    return false;
  }

  const failLines = lines.filter((line) => /^  - /.test(line));
  if (failLines.length !== 1) {
    return false;
  }
  if (!/^  - strict 模式不允许 pending（当前 [1-9][0-9]*）$/.test(failLines[0])) {
    return false;
  }

  if (/\bstack\b|uncaught|unhandled|Error:/i.test(output)) {
    return false;
  }

  return true;
}

function runSelfCheck() {
  const testCases = [
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1\n  - strict 模式不允许 pending（当前 45）',
      stderr: '',
      error: null,
      expected: true,
    },
    {
      status: 1,
      stdout: '失败: 1\n  - strict 模式不允许 pending（当前 45）',
      stderr: '',
      error: null,
      expected: false,
    },
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1\n  - 参数校验失败',
      stderr: '',
      error: null,
      expected: false,
    },
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1\n  - strict 模式不允许 pending（当前 45）\n  - strict 模式不允许 pending（当前 46）',
      stderr: '',
      error: null,
      expected: false,
    },
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1\n  - strict 模式不允许 pending（当前 45）',
      stderr: 'stack: at Object.someFunction (/tmp/test.js:1:1)',
      error: null,
      expected: false,
    },
    {
      status: 0,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1\n  - strict 模式不允许 pending（当前 45）',
      stderr: '',
      error: null,
      expected: false,
    },
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\nCONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1\n  - strict 模式不允许 pending（当前 45）',
      stderr: '',
      error: null,
      expected: false,
    },
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 1 extra\n  - strict 模式不允许 pending（当前 45）',
      stderr: '',
      error: null,
      expected: false,
    },
    {
      status: 1,
      stdout: 'CONTRACT_STRICT_GUARD=EXPECTED_PENDING_FAILURE\n失败: 2\n  - strict 模式不允许 pending（当前 45）\n  - cleanup workspace 失败',
      stderr: '',
      error: null,
      expected: false,
    },
  ];

  testCases.forEach((item) => {
    const actual = isExpectedPendingFailureGuardResult(item);
    if (actual !== item.expected) {
      console.error('strict-guard 自检失败，判定逻辑与预期不一致');
      process.exit(1);
    }
  });
}

runSelfCheck();

const result = spawnSync(process.execPath, [path.join(__dirname, 'test-web-contract.cjs'), '--strict'], {
  encoding: 'utf8',
  stdio: 'pipe',
  env: {
    ...process.env,
  },
  cwd: path.join(__dirname, '..'),
});

const passed = isExpectedPendingFailureGuardResult(result);
if (!passed) {
  console.error('strict-guard 失败：未观察到仅 pending 失败相关的严格失败模式');
  process.exit(1);
}

console.log('strict-guard 通过：strict 仅报告 pending 失败并包含预期机器标记');
process.exit(0);
