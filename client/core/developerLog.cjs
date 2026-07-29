function createNoopDeveloperLogger() {
  return {
    enabled: false,
    filePath: '',
    logId: '',
    write() {},
  };
}

module.exports = { createNoopDeveloperLogger };
