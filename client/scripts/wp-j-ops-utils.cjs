const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REDACTED = '<redacted>';

function redactText(value) {
  let text = String(value || '');
  const secretValues = [
    process.env.YIBIAO_SIDECAR_SECRET,
    process.env.MAINQUEST_OAUTH_CLIENT_SECRET,
    process.env.SESSION_SECRET,
    process.env.CONFIG_ENCRYPTION_KEY,
  ].filter((item) => item && item.length >= 4);
  for (const secret of secretValues) text = text.split(secret).join(REDACTED);
  text = text.replace(/(?:\/Users|\/home|\/root|\/tmp|\/data|\/var\/lib|\/opt)\/[^\s"']+/g, '<path>');
  text = text.replace(/((?:secret|token|password|api[_-]?key|clientSecret)\s*[:=]\s*)([^,\s}]+)/gi, `$1${REDACTED}`);
  return text.slice(0, 500);
}

function safeRead(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function check(name, status, message, extra = {}) {
  const extraFields = { ...extra };
  delete extraFields.message;
  const result = {
    name,
    status,
    ...(message || extra.message ? { message: redactText(message || extra.message) } : {}),
    ...extraFields,
  };
  if (status !== 'ok') {
    const stableName = String(name).replace(/[^a-z0-9]+/gi, '_').toUpperCase();
    result.code ||= `WP_J_${stableName}_${String(status).toUpperCase()}`;
    result.component ||= 'wp-j-operations';
    result.run_id ||= 'wp-j-doctor';
    result.retryable ??= status === 'warn';
    result.action ||= `检查 ${name} 对应的部署配置与运行状态`;
    result.docs ||= 'docs/runbooks/wp-j-agent-sidecar.md';
  }
  return result;
}

function blockForService(composeSource, serviceName) {
  const marker = `  ${serviceName}:`;
  const start = composeSource.indexOf(`${marker}\n`);
  if (start < 0) return '';
  const bodyStart = start + marker.length + 1;
  const remainder = composeSource.slice(bodyStart);
  const nextService = remainder.search(/^  \S/m);
  return nextService < 0 ? remainder : remainder.slice(0, nextService);
}

function runStaticChecks() {
  const checks = [];
  const dockerfile = safeRead('Dockerfile');
  const compose = safeRead('docker-compose.yml');
  const runnerDockerfile = safeRead('docker/agent-runner/Dockerfile');
  const requiredDocs = [
    'docs/runbooks/wp-j-agent-sidecar.md',
    'docs/runbooks/wp-j-gates-and-fixtures.md',
    'docs/runbooks/wp-j-rollback.md',
  ];

  if (!dockerfile) {
    checks.push(check('web_dockerfile', 'fail', '主 Dockerfile 不存在'));
  } else {
    const runnerAssetsMarker = dockerfile.indexOf(' AS runner-assets');
    const webStages = runnerAssetsMarker >= 0 ? dockerfile.slice(0, runnerAssetsMarker) : dockerfile;
    const operationalLines = webStages.split('\n').filter((line) => /^\s*(RUN|COPY|ADD|ENV|ARG|ENTRYPOINT|CMD|FROM)\b/.test(line));
    const forbidden = ['opencode', 'ripgrep', 'fd-find', 'fdfind', 'jq', 'prlimit', 'curl'];
    const leaked = forbidden.filter((term) => operationalLines.some((line) => line.toLowerCase().includes(term)));
    checks.push(leaked.length === 0
      ? check('web_image_tools', 'ok', 'Web production stage 未引入 Runner 工具')
      : check('web_image_tools', 'fail', `Web production stage 包含受限工具：${leaked.join(', ')}`));
    checks.push(/FROM node:[^\n]+ AS agent-runner/.test(dockerfile)
      ? check('agent_runner_target', 'ok', '主 Dockerfile 提供 agent-runner target')
      : check('agent_runner_target', 'fail', '主 Dockerfile 缺少 agent-runner target'));
    checks.push(/FROM web-runtime AS production/.test(dockerfile)
      ? check('production_target', 'ok', '默认 production target 指向 Web Runtime')
      : check('production_target', 'fail', '缺少 Web production target'));
  }

  if (!compose) {
    checks.push(check('compose', 'fail', 'docker-compose.yml 不存在'));
  } else {
    const runner = blockForService(compose, 'agent-runner');
    checks.push(/profiles:\s*\["j-agent"\]/.test(runner)
      ? check('compose_profile', 'ok', 'Runner 使用 j-agent profile')
      : check('compose_profile', 'fail', 'Runner 缺少 j-agent profile'));
    checks.push(!/^\s+ports:/m.test(runner)
      ? check('compose_runner_ports', 'ok', 'Runner 未发布公开端口')
      : check('compose_runner_ports', 'fail', 'Runner 不得声明 ports'));
    const requiredSecurity = [
      ['read_only', /read_only:\s*true/],
      ['no_new_privileges', /no-new-privileges:true/],
      ['seccomp', /seccomp=\.\/docker\/agent-runner\/seccomp\/agent-runner\.json/],
      ['cap_drop_all', /cap_drop:[\s\S]*?\n\s+- ALL/],
      ['tmpfs', /tmpfs:/],
      ['pids_limit', /pids_limit:\s*128/],
      ['memory_limit', /mem_limit:\s*768m/],
      ['cpu_limit', /cpus:\s*1(?:\.0)?/],
      ['ulimits', /ulimits:/],
    ];
    for (const [name, pattern] of requiredSecurity) {
      checks.push(pattern.test(runner)
        ? check(`compose_${name}`, 'ok', `Runner ${name} 已声明`)
        : check(`compose_${name}`, 'fail', `Runner 缺少 ${name}`));
    }
    checks.push(/agent-internal:[\s\S]*?internal:\s*true/.test(compose)
      ? check('compose_internal_network', 'ok', 'agent-internal 为 internal network')
      : check('compose_internal_network', 'fail', '缺少 agent-internal internal network'));
    checks.push(/web:[\s\S]*?web-egress[\s\S]*?agent-internal/.test(compose)
      ? check('compose_dual_network', 'ok', 'Web 同时加入出网与内部网络')
      : check('compose_dual_network', 'fail', 'Web 双网络拓扑不完整'));
  }

  if (!runnerDockerfile) {
    checks.push(check('runner_dockerfile', 'fail', 'Runner Dockerfile 不存在'));
  } else {
    checks.push(/USER 10001:10001/.test(runnerDockerfile) && !/^EXPOSE\s/m.test(runnerDockerfile)
      ? check('runner_image_boundary', 'ok', 'Runner 镜像非 root 且无 EXPOSE')
      : check('runner_image_boundary', 'fail', 'Runner 镜像身份或端口边界不符合要求'));
  }

  for (const doc of requiredDocs) {
    checks.push(safeRead(doc)
      ? check(`doc_${path.basename(doc)}`, 'ok', '运行手册存在')
      : check(`doc_${path.basename(doc)}`, 'fail', '运行手册缺失'));
  }
  return checks;
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'ignore' });
  return result.status === 0;
}

function runDoctor({ includeDocker = true } = {}) {
  const checks = runStaticChecks();
  const enabledValue = process.env.AGENT_QUALITY_ENABLED === undefined
    ? process.env.AGENT_SIDECAR_ENABLED
    : process.env.AGENT_QUALITY_ENABLED;
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(enabledValue || '').trim().toLowerCase());
  const secret = String(process.env.YIBIAO_SIDECAR_SECRET || '').trim();
  if (!enabled) {
    checks.push(check('sidecar_feature_flag', 'warn', 'Agent Quality 未开启，Runner 仅作为 j-agent profile 使用'));
  } else if (!secret || secret === 'change-me-before-production') {
    checks.push(check('sidecar_secret', 'fail', 'Sidecar 已开启但缺少部署注入的 secret'));
  } else {
    checks.push(check('sidecar_secret', 'ok', 'Sidecar secret 已注入（值不输出）'));
  }
  if (includeDocker) {
    checks.push(commandAvailable('docker')
      ? check('docker', 'ok', 'Docker CLI 可用')
      : check('docker', 'warn', 'Docker CLI 不可用，跳过容器级检查'));
    if (commandAvailable('docker', ['compose', 'version'])) {
      checks.push(check('docker_compose', 'ok', 'Docker Compose 可用'));
    } else {
      checks.push(check('docker_compose', 'warn', 'Docker Compose 不可用，跳过 Compose 级检查'));
    }
  }
  const hasFail = checks.some((item) => item.status === 'fail');
  const hasWarn = checks.some((item) => item.status === 'warn');
  return { status: hasFail ? 'fail' : (hasWarn ? 'warn' : 'ok'), checks };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  REPO_ROOT,
  redactText,
  check,
  runStaticChecks,
  runDoctor,
  printResult,
};
