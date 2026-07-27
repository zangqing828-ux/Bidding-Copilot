const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runBidSectionExtractionTask } = require('../core/technical-plan/orchestration/bidSectionExtractionTask.cjs');
const { TASK_ERROR_CODES } = require('../shared/contracts/technical-plan/taskContracts.cjs');

function readFixture(fileName) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', fileName);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWorkspaceHarness(markdown) {
  let state = {
    bidSectionMode: 'single',
    bidSections: [],
    bidSectionExtractionStatus: 'idle',
    bidSectionExtractionError: undefined,
  };

  return {
    store: {
      readOriginalTenderMarkdown() {
        return markdown;
      },
      readTenderMarkdown() {
        return markdown;
      },
      prepareBidSectionExtraction() {},
      updateTechnicalPlan(partial) {
        state = { ...state, ...partial };
        return state;
      },
      getState() {
        return state;
      },
    },
  };
}

function createAiService(responses, options = {}) {
  let calls = 0;
  const onCall = options.onCall || (() => {});
  return {
    getConfig: () => ({}),
    collectJsonResponse: async (request) => {
      onCall(request, calls + 1);
      calls += 1;
      const response = responses[calls - 1];
      if (typeof response === 'function') {
        return response(request);
      }
      return response;
    },
    requestJson: async (request) => {
      onCall(request, calls + 1);
      calls += 1;
      const response = responses[calls - 1];
      if (typeof response === 'function') {
        return response(request);
      }
      return response;
    },
    calls() {
      return calls;
    },
  };
}

function createNeverResolvingAiService(onCall) {
  return {
    getConfig: () => ({}),
    collectJsonResponse: async (request) => {
      onCall?.(request);
      return new Promise(() => {});
    },
    requestJson: async (request) => {
      onCall?.(request);
      return new Promise(() => {});
    },
  };
}

async function main() {
  const fixture = readFixture('technical-plan-characterization/j1-multi-section-selection.fixture.json');
  {
    const harness = createWorkspaceHarness(fixture.input.tenderMarkdown);
    const aiService = createAiService([fixture.input.sectionExtractionResponses[0]], {
      onCall: () => {
        // no-op
      },
    });
    const taskUpdates = [];

    await runBidSectionExtractionTask({
      payload: {},
      aiService,
      workspaceStore: harness.store,
      updateTask: (task, state) => {
        taskUpdates.push({ task, state });
      },
      signal: new AbortController().signal,
    });

    const state = harness.store.getState();
    assert.deepEqual(state.bidSections, fixture.expected.bidSections, '多标段 fixture 应完全对齐');
    assert.equal(state.bidSectionMode, 'multiple', '多标段提取应保持 multiple');
    assert.equal(state.bidSectionExtractionStatus, 'success', '多标段提取应成功');
    assert.equal(state.bidSectionExtractionError, undefined, '成功应无错误提示');
    assert.equal(aiService.calls(), 1, '多标段 fixture 应触发一次 AI 提取');
    assert.equal(taskUpdates[taskUpdates.length - 1]?.task?.status, 'success', '任务更新应进入 success');
  }

  {
    const singleMarkup = [
      '# 单标段项目',
      '本项目仅有一个标段。',
      '',
      '## 一标段：系统集成',
      '由乙方完成系统集成交付。',
      '',
    ].join('\n');
    const harness = createWorkspaceHarness(singleMarkup);
    const singleResponse = {
      sections: [
        {
          id: 'section-1',
          index: 1,
          unit: '标段',
          title: '一标段',
          headLine: '一标段：系统集成',
          description: '系统集成服务与交付。',
          includeRanges: [
            {
              startLine: 4,
              endLine: 5,
              reason: '一标段正文',
            },
          ],
          evidence: ['一标段：系统集成'],
        },
      ],
    };
    const aiService = createAiService([singleResponse]);

    await runBidSectionExtractionTask({
      payload: {},
      aiService,
      workspaceStore: harness.store,
      updateTask: () => {},
      signal: new AbortController().signal,
    });

    const state = harness.store.getState();
    assert.deepEqual(state.bidSections, singleResponse.sections, '单标段场景应保留单个标段结果');
    assert.equal(state.bidSectionMode, 'single', '单标段回退应将 mode 设为 single');
    assert.equal(state.bidSectionExtractionStatus, 'success', '单标段回退场景应成功');
  }

  {
    const harness = createWorkspaceHarness('单标段但入参异常');
    const aiService = createAiService([{
      sections: [{
        id: 'section-1',
        index: 1,
        unit: '标段',
        title: '一标段',
        headLine: '一标段',
        description: '测试',
        includeRanges: [{ startLine: 1, endLine: 1 }],
      }],
    }]);

    await assert.rejects(
      () => runBidSectionExtractionTask({
        payload: { unexpectedField: true },
        aiService,
        workspaceStore: harness.store,
        updateTask: () => {},
      }),
      (error) => error?.code === TASK_ERROR_CODES.INVALID_INPUT,
      '未知字段应触发 TASK_INVALID_INPUT',
    );
    assert.equal(aiService.calls(), 0, '入参校验失败前不应调用 AI');
  }

  {
    const harness = createWorkspaceHarness('pre-abort 文档内容');
    const aiService = createAiService([{}]);
    const controller = new AbortController();
    controller.abort('网络断开');

    await assert.rejects(
      () => runBidSectionExtractionTask({
        payload: {},
        aiService,
        workspaceStore: harness.store,
        updateTask: () => {},
        signal: controller.signal,
      }),
      (error) => error?.code === TASK_ERROR_CODES.ACCEPTANCE_ABORTED,
      '预先中断应返回 TASK_ACCEPTANCE_ABORTED',
    );
    assert.equal(aiService.calls(), 0, '预中断应不触发 AI 调用');
  }

  {
    const harness = createWorkspaceHarness('中途中断文本');
    const controller = new AbortController();
    const abortError = new Error('中途取消并传播原始错误');
    const inFlightAiService = createNeverResolvingAiService(() => {
      // keep as side effect placeholder
    });

    const running = runBidSectionExtractionTask({
      payload: {},
      aiService: inFlightAiService,
      workspaceStore: harness.store,
      updateTask: () => {},
      signal: controller.signal,
    });

    await wait(20);
    controller.abort(abortError);
    await assert.rejects(
      () => running,
      (error) => error === abortError,
      '中途取消应透传 signal.reason（Error 直接返回）',
    );
    assert.equal(harness.store.getState().bidSectionExtractionStatus, 'error', '中途取消后应落盘为错误态');
    assert.equal(harness.store.getState().bidSectionExtractionError, '中途取消并传播原始错误', '错误码透传后的 message 应保留');
  }

  console.log('WP-J portable bid-section extraction orchestration tests passed');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
