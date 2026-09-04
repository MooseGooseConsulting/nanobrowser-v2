import { describe, expect, it } from 'vitest';

import { allowPaidFromOptions, checkModelPolicy, isFreeModelId } from './modelPolicy';

const FREE_LEADER = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const FREE_FOLLOWER = 'nvidia/nemotron-3.5-lightning:free';

describe('isFreeModelId', () => {
  it('accepts the OpenRouter :free suffix', () => {
    expect(isFreeModelId(FREE_LEADER)).toBe(true);
    expect(isFreeModelId(FREE_FOLLOWER)).toBe(true);
  });

  it('rejects the paid twin of a free model, which differs only by the suffix', () => {
    expect(isFreeModelId('nvidia/nemotron-3.5-lightning')).toBe(false);
    expect(isFreeModelId('nvidia/nemotron-3-ultra-550b-a55b')).toBe(false);
  });

  it('is not fooled by ":free" appearing anywhere but the end', () => {
    expect(isFreeModelId('vendor/:free-lunch')).toBe(false);
    expect(isFreeModelId('vendor/model:free:latest')).toBe(false);
  });
});

describe('checkModelPolicy', () => {
  it('allows the free Nemotron pair the user authorised', () => {
    expect(checkModelPolicy({ leaderModel: FREE_LEADER, followerModel: FREE_FOLLOWER })).toEqual({
      ok: true,
    });
  });

  it('refuses a paid leader and names it', () => {
    const result = checkModelPolicy({
      leaderModel: 'deepseek/deepseek-v3.2',
      followerModel: FREE_FOLLOWER,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('deepseek/deepseek-v3.2');
    expect(result.ok === false && result.reason).toContain('leader');
  });

  it('refuses a paid follower even when the leader is free', () => {
    const result = checkModelPolicy({
      leaderModel: FREE_LEADER,
      followerModel: 'z-ai/glm-5.3-flash',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('follower');
  });

  it('names both roles when both are paid', () => {
    const result = checkModelPolicy({
      leaderModel: 'deepseek/deepseek-v3.2',
      followerModel: 'z-ai/glm-5.3-flash',
    });
    expect(result.ok === false && result.reason).toContain('leader');
    expect(result.ok === false && result.reason).toContain('follower');
    expect(result.ok === false && result.reason).toContain('are not a free');
  });

  it('says how to override, so the refusal is not a dead end', () => {
    const result = checkModelPolicy({ leaderModel: 'openai/gpt-5', followerModel: FREE_FOLLOWER });
    expect(result.ok === false && result.reason).toContain('allowPaidModels=true');
  });

  it('lets an explicit override through', () => {
    const result = checkModelPolicy(
      { leaderModel: 'openai/gpt-5', followerModel: 'openai/gpt-5' },
      { allowPaid: true },
    );
    expect(result).toEqual({ ok: true });
  });

  it('ignores empty model ids, which the readiness gate rejects first', () => {
    expect(checkModelPolicy({ leaderModel: '', followerModel: '' })).toEqual({ ok: true });
  });
});

describe('allowPaidFromOptions', () => {
  it('is off when the option is absent, which is every ordinary run', () => {
    expect(allowPaidFromOptions(undefined)).toBe(false);
    expect(allowPaidFromOptions({})).toBe(false);
    expect(allowPaidFromOptions({ observe: 'dom' })).toBe(false);
  });

  it('accepts the string forms the CLI produces, since --option values arrive as text', () => {
    expect(allowPaidFromOptions({ allowPaidModels: 'true' })).toBe(true);
    expect(allowPaidFromOptions({ allowPaidModels: '1' })).toBe(true);
    expect(allowPaidFromOptions({ allowPaidModels: true })).toBe(true);
  });

  it('treats every other value as off rather than truthy', () => {
    expect(allowPaidFromOptions({ allowPaidModels: 'false' })).toBe(false);
    expect(allowPaidFromOptions({ allowPaidModels: 'yes' })).toBe(false);
    expect(allowPaidFromOptions({ allowPaidModels: 0 })).toBe(false);
  });
});
