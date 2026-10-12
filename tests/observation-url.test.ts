import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import type { RunEvent } from '@/src/messaging/contract';
import { FakeChatModel } from '@/src/agent/models';
import { FakePageTools } from '@/src/agent/tools';
import { startRun } from '@/src/agent/run';

describe('observation events', () => {
  it('each observation in the run log names the page the snapshot was taken of', async () => {
    const urls = ['https://www.ebay.com/sch/i.html?_nkw=a', 'https://www.ebay.com/itm/123456789012'];
    const page = new FakePageTools({ snapshots: urls.map((url, i) => ({ text: `page ${i}`, tokens: 2, url })) });
    const leader = new FakeChatModel({
      label: 'leader',
      respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'p', subgoals: ['s'] } }),
    });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'extract_text', args: { signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read',
      config: { leaderModel: 'fake/l', followerModel: 'fake/f', observe: 'dom', planningInterval: 10, maxSteps: 5, inputFidelity: 'in-page' },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: 'observation-url',
    }).done;

    expect(ended.status).toBe('done');
    expect(events.flatMap((e) => (e.kind === 'observation' ? [e.url] : []))).toEqual(urls);
  });

  it.each(['both', 'pixels'] as const)('a screenshot that times out in %s mode costs one observation, not the run', async (observe) => {
    class StalledCapture extends FakePageTools {
      override async screenshot(): Promise<never> {
        throw new Error('captureVisibleTab failed: captureVisibleTab did not answer in 20000ms');
      }
    }
    const page = new StalledCapture({ snapshots: [{ text: 'the results page', tokens: 4, url: 'https://shop.test/s?q=ram' }] });
    const leader = new FakeChatModel({ label: 'leader', respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'p', subgoals: ['s'] } }) });
    const follower = new FakeChatModel({ label: 'follower', respond: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok' } }) });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read',
      config: { leaderModel: 'fake/l', followerModel: 'fake/f', observe, planningInterval: 10, maxSteps: 5, inputFidelity: 'in-page' },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: `stalled-capture-${observe}`,
    }).done;

    expect(ended.status).toBe('done');
    expect(events.find((e) => e.kind === 'observation')).toMatchObject({ hasScreenshot: false, url: 'https://shop.test/s?q=ram' });
    const prompt = JSON.stringify(follower.calls[0]!.messages);
    expect(prompt).toContain('No screenshot this step (captureVisibleTab failed');
    expect(prompt).toContain('the results page');
  });

  it('in both mode a lost screenshot still leaves the current page text, not only the unchanged-page note', async () => {
    // CodeRabbit review on PR #53: on an unchanged page the prompt carries only
    // the unchanged-page note, and once trimFollowerHistory has removed the
    // snapshot it points at, a failed capture left the follower with no page
    // text and no image.
    class SucceedsOnceThenStalls extends FakePageTools {
      #shots = 0;
      override async screenshot() {
        this.#shots += 1;
        if (this.#shots > 1) throw new Error('captureVisibleTab failed: captureVisibleTab did not answer in 20000ms');
        return { dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 10, height: 10 };
      }
    }
    const page = new SucceedsOnceThenStalls({
      snapshots: [{ text: 'the occluded page', tokens: 4, url: 'https://shop.test/a' }],
    });
    const leader = new FakeChatModel({ label: 'leader', respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'p', subgoals: ['s'] } }) });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read',
      config: { leaderModel: 'fake/l', followerModel: 'fake/f', observe: 'both', planningInterval: 10, maxSteps: 5, inputFidelity: 'in-page' },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: 'both-lost-screenshot',
    }).done;

    expect(ended.status).toBe('done');
    const observations = events.filter((e) => e.kind === 'observation');
    expect(observations[1]).toMatchObject({ hasScreenshot: false, unchanged: true });
    // The step-2 prompt names the lost capture AND still carries the page text,
    // even though the snapshot digest called the page unchanged.
    const step2 = JSON.stringify(follower.calls[1]!.messages);
    expect(step2).toContain('No screenshot this step (captureVisibleTab failed');
    expect(step2).toContain('the occluded page');
  });

  it('pixels observations record the page url on success too, without sending the DOM', async () => {
    // Codex review on PR #53: on a pixels-only run with a working capture the
    // observation named no page at all, so URL-based run logging and harness
    // scoring went blind exactly when pixels mode worked.
    const page = new FakePageTools({ snapshots: [{ text: 'pixels probe text', tokens: 3, url: 'https://shop.test/p/123' }] });
    const leader = new FakeChatModel({ label: 'leader', respond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'p', subgoals: ['s'] } }) });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'extract_text', args: { signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'ok' } },
    });
    const events: RunEvent[] = [];
    const ended = await startRun({
      prompt: 'read',
      config: { leaderModel: 'fake/l', followerModel: 'fake/f', observe: 'pixels', planningInterval: 10, maxSteps: 5, inputFidelity: 'in-page' },
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: 'pixels-url',
    }).done;

    expect(ended.status).toBe('done');
    const observations = events.filter((e) => e.kind === 'observation');
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation).toMatchObject({ hasScreenshot: true, url: 'https://shop.test/p/123' });
    }
    // The url probe reads a snapshot for its url alone: its text stays out of the prompt.
    expect(JSON.stringify(follower.calls.map((c) => c.messages))).not.toContain('pixels probe text');
  });
});
