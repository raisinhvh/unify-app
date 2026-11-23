/**
 * Agents › General: everything about agents that is not one subagent profile.
 *
 *   Explorer        its model (Off until one is picked) and whether it returns code ranges
 *   Helper models   chat names, review, file summaries and the Smart Auto decider with its ranks, each under
 *                   the switch that uses it (the child rows fold away while the switch is off)
 *   Subagents       how many run at once, images to the parent, blocking the providers' own agent tools
 *   Messaging       agent-to-agent messages
 *
 * Every change is posted at once and shows when the engine echoes it.
 */
import { For, type JSX } from 'solid-js';
import { post } from '../../bridge';
import { ModelPicker } from '../../components';
import { Collapse } from '../../motion';
import { viewState } from '../../store';
import { agentsScreenRow } from '../settings/catalog';
import { SettingRows } from '../settings/SettingControls';
import { AgentRow, ModelChoiceRows, withModel } from './rows';

function SectionHeading(props: { title: string; note?: string }): JSX.Element {
  return (
    <div class="ag-section-head">
      <h2 class="ag-section-heading">{props.title}</h2>
      {props.note && <p class="ag-section-note type-caption">{props.note}</p>}
    </div>
  );
}

function SmartAutoRanks(): JSX.Element {
  const ranks = () => viewState.smartAutoRanks ?? [];
  const setRank = (index: number, model: string) => {
    const next = ranks().map((rank, position) => (position === index ? withModel(rank, model) : rank));
    post({ type: 'saveSmartAutoRanks', ranks: next.map(rank => ({ ...rank, model: rank.model ?? '' })) });
  };
  return (
    <For each={ranks()}>
      {(rank, index) => (
        <AgentRow
          label={`Rank ${index() + 1}`}
          caption={rank.note || (index() === 0 ? 'The smartest model the decider can pick.' : 'A cheaper choice for simpler messages.')}
          depth={1}
        >
          <ModelPicker
            variant="regular"
            smartAuto={false}
            placement="bottom-end"
            value={rank.model}
            placeholder="Choose a model"
            title={`Smart Auto rank ${index() + 1}`}
            onChange={model => setRank(index(), model)}
          />
        </AgentRow>
      )}
    </For>
  );
}

export function GeneralPage(): JSX.Element {
  const autoName = () => !!viewState.features.autoName;
  const reviewAgent = () => !!viewState.features.reviewAgent;
  const smartAuto = () => !!viewState.features.smartAuto;
  const explorerOn = () => !!viewState.explorerModel?.model;
  return (
    <section class="ag-page" aria-label="Agents">
      <header class="ag-page-header">
        <div class="ag-page-heading">
          <h1 class="ag-title">Agents</h1>
          <p class="ag-page-status">The explorer, helper models and how subagents run. Each profile has its own page.</p>
        </div>
      </header>

      <SectionHeading
        title="Explorer"
        note="A read-only subagent the main agent sends to search and read code. It returns only the answer, so the chat keeps its context small."
      />
      <ModelChoiceRows
        label="Explorer model"
        caption="Runs every explorer the main agent starts."
        emptyCaption="The explorer is off until you pick a model."
        noneLabel="Off"
        choice={viewState.explorerModel ?? {}}
        onSave={explorerModel => post({ type: 'saveExplorerModel', explorerModel })}
      />
      <Collapse open={explorerOn()}>
        <SettingRows rows={[agentsScreenRow('feature:agents.explorerRanges')]} />
      </Collapse>

      <SectionHeading title="Helper models" note="Small jobs outside the chat. A fast, cheap model is best for each." />
      <SettingRows rows={[agentsScreenRow('engine:autoName')]} />
      <Collapse open={autoName()}>
        <ModelChoiceRows
          label="Name model"
          caption="Only sees your first message."
          emptyCaption="None set, so each chat is named by its own model."
          noneLabel="Same as the chat"
          depth={1}
          choice={viewState.nameModel ?? {}}
          onSave={nameModel => post({ type: 'saveNameModel', nameModel })}
        />
      </Collapse>
      <SettingRows rows={[agentsScreenRow('engine:reviewAgent')]} />
      <Collapse open={reviewAgent()}>
        <ModelChoiceRows
          label="Review model"
          caption="Reads the working copy and checks every criterion."
          emptyCaption="Pick a model, or each /job stops when it reaches review."
          depth={1}
          choice={viewState.reviewModel ?? {}}
          onSave={reviewModel => post({ type: 'saveReviewModel', reviewModel })}
        />
      </Collapse>
      <ModelChoiceRows
        label="Summary model"
        caption="Summarises files the built-in outlines cannot read. Runs in the background."
        emptyCaption="Only needed for languages without a built-in outline."
        noneLabel="None"
        choice={viewState.summaryModel ?? {}}
        onSave={summaryModel => post({ type: 'saveSummaryModel', summaryModel })}
      />
      <SettingRows rows={[agentsScreenRow('engine:smartAuto')]} />
      <Collapse open={smartAuto()}>
        <ModelChoiceRows
          label="Decider model"
          caption="Sees your message and the last few exchanges, then picks a rank below."
          emptyCaption="Pick a decider model to use Smart Auto."
          depth={1}
          choice={viewState.deciderModel ?? {}}
          onSave={deciderModel => post({ type: 'saveDeciderModel', deciderModel })}
        />
        <SmartAutoRanks />
      </Collapse>

      <SectionHeading title="Subagents" note="How subagents run, whichever profile they use." />
      <SettingRows
        rows={[
          agentsScreenRow('feature:agents.maxParallel'),
          agentsScreenRow('feature:agents.imagesToParent'),
          agentsScreenRow('feature:agents.blockNativeAgents'),
        ]}
      />

      <SectionHeading title="Messaging" />
      <SettingRows
        rows={[
          agentsScreenRow('feature:agents.messaging'),
          agentsScreenRow('feature:agents.messaging.scope'),
          agentsScreenRow('feature:agents.messaging.showInChat'),
        ]}
      />
    </section>
  );
}
