import type { ModelInfo, Readiness } from '@/src/messaging';
import type { InputFidelity, ObserveMode } from '@/src/storage';
import { Button } from '../components/Button';
import { Field, Section } from '../components/Card';
import { ModelSelect } from '../components/ModelSelect';
import { NumberField } from '../components/NumberField';
import { RadioGroup } from '../components/RadioGroup';
import { Toggle } from '../components/Toggle';
import { MAX_STEPS, PLANNING_INTERVAL } from '../state/gate';
import { isWaiting, type AreaStatus } from '../state/status';
import { useConfig } from '../state/useConfig';
import { ReadinessRow } from './ReadinessRow';

const OBSERVE_OPTIONS = [
  { value: 'dom' as const, label: 'DOM', title: 'Navigate from the accessibility/DOM snapshot.' },
  { value: 'pixels' as const, label: 'Pixels', title: 'Navigate from screenshots.' },
  { value: 'both' as const, label: 'Both', title: 'Send both the DOM snapshot and a screenshot.' },
] satisfies ReadonlyArray<{ value: ObserveMode; label: string; title: string }>;

export function SetupSection({
  models,
  modelsStatus,
  modelsError,
  onRefreshModels,
  readiness,
  readinessStatus,
  onRefreshReadiness,
}: {
  models: ModelInfo[];
  modelsStatus: AreaStatus;
  modelsError?: string;
  onRefreshModels: () => void;
  readiness?: Readiness;
  readinessStatus: AreaStatus;
  onRefreshReadiness: () => void;
}) {
  const { config, update, reset } = useConfig();
  const escalated: boolean = config.inputFidelity === 'escalated';

  return (
    <div className="space-y-4">
      <ReadinessRow readiness={readiness} status={readinessStatus} onRefresh={onRefreshReadiness} />

      <Section
        title="Models"
        actions={
          <Button variant="ghost" onClick={onRefreshModels}>
            reload
          </Button>
        }
        hint={
          modelsError ? (
            <span className="text-rose-600 dark:text-rose-400">{modelsError}</span>
          ) : isWaiting(modelsStatus) ? (
            'Waiting for the worker to send the model list.'
          ) : (
            `${models.length} models. Free models and NVIDIA Nemotron are listed first.`
          )
        }
      >
        <div className="space-y-2">
          <Field label="Leader" htmlFor="leader-model" hint="Plans and re-plans the objective.">
            <ModelSelect
              id="leader-model"
              label="Leader model"
              models={models}
              value={config.leaderModel}
              onChange={(id) => update({ leaderModel: id })}
            />
          </Field>
          <Field label="Follower" htmlFor="follower-model" hint="Acts, and signals when to hand control back.">
            <ModelSelect
              id="follower-model"
              label="Follower model"
              models={models}
              value={config.followerModel}
              onChange={(id) => update({ followerModel: id })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Observation">
        <Field label="Observe mode" hint="How the agent perceives the page.">
          <RadioGroup
            name="observe"
            aria-label="Observe mode"
            value={config.observe}
            options={OBSERVE_OPTIONS}
            onChange={(observe) => update({ observe })}
          />
        </Field>
      </Section>

      <Section title="Cadence">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Planning interval"
            htmlFor="planning-interval"
            hint="Steps between Leader re-plans."
          >
            <NumberField
              id="planning-interval"
              value={config.planningInterval}
              min={PLANNING_INTERVAL.min}
              max={PLANNING_INTERVAL.max}
              onChange={(planningInterval) => update({ planningInterval })}
            />
          </Field>
          <Field label="Max steps" htmlFor="max-steps" hint="Safety valve, not the normal handoff.">
            <NumberField
              id="max-steps"
              value={config.maxSteps}
              min={MAX_STEPS.min}
              max={MAX_STEPS.max}
              onChange={(maxSteps) => update({ maxSteps })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Input fidelity">
        <div className="flex items-start gap-2">
          <Toggle
            id="input-fidelity"
            label="Escalate to trusted input"
            checked={escalated}
            onChange={(on) =>
              update({ inputFidelity: (on ? 'escalated' : 'in-page') satisfies InputFidelity })
            }
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">
              {escalated ? 'Escalated (debugger/CDP)' : 'In-page events'}
            </p>
            <p data-testid="fidelity-explainer" className="text-[11px] leading-snug text-muted">
              Escalated input is delivered through chrome.debugger, so Chrome shows its
              &ldquo;is debugging this browser&rdquo; banner while it is attached.
            </p>
          </div>
        </div>
      </Section>

      <div className="border-t border-line pt-3">
        <Button variant="ghost" onClick={reset}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
