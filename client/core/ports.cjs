const PORT_METHODS = Object.freeze({
  config: Object.freeze(['load', 'save']),
  fileParser: Object.freeze(['parseDocument']),
  ai: Object.freeze(['withQueueScope', 'pauseQueueScope', 'resumeQueueScope']),
  agent: Object.freeze(['bindSelectedRuntime', 'close']),
  renderer: Object.freeze(['renderMermaidToPng', 'renderHtmlToPng']),
  exporter: Object.freeze(['buildDocxBuffer']),
  taskEvents: Object.freeze(['subscribe', 'close']),
});

function describeRequiredMethods(name) {
  const methods = PORT_METHODS[name];
  if (!methods) {
    throw new Error(`未知端口声明: ${name}`);
  }
  return methods;
}

function assertPort(name, implementation) {
  const methods = describeRequiredMethods(name);

  if (!implementation || (typeof implementation !== 'object' && typeof implementation !== 'function')) {
    throw new Error(`端口 ${name} 需要对象实现，当前为 ${typeof implementation}`);
  }

  const missingMethods = [];
  for (const method of methods) {
    if (typeof implementation[method] !== 'function') {
      missingMethods.push(method);
    }
  }

  if (missingMethods.length) {
    throw new Error(`端口 ${name} 缺少必需方法: ${missingMethods.join(', ')}`);
  }

  return implementation;
}

module.exports = {
  PORT_METHODS: Object.freeze({ ...PORT_METHODS }),
  assertPort,
};
