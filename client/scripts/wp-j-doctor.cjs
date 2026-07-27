const { runDoctor, printResult } = require('./wp-j-ops-utils.cjs');

const result = runDoctor();
printResult(result);
if (result.status === 'fail') process.exitCode = 1;
