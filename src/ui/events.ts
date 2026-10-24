import type { SidecarEvent } from '../../sidecar/src/protocol';
import { renderPriorities, renderTasks } from './board';
import { activate, renderComposer, renderHeader, renderProcesses, renderProjects, renderSession } from './chrome';
import { closeDocs, docsView, refreshDocs, renderDocs } from './docs';
import { $ } from './dom';
import { loginUrl, onLoginEvent } from './login';
import { onCreateEvent } from './newproject';
import { onProbe, probe } from './providers';
import { afterAnswer, askQuestions, noteReply, openQuestion, renderQuestions, scrollToEnd, userMessage } from './questions';
import { nextQueued, startFreed, waitingQueued, startQueued, trackLane } from './queue';
import { onMcpServers } from './settings';
import { active, editorList, newProject, projects, providerList, saveOpenProjects, setEditorList, setProviderList } from './state';
import { assistantDelta, assistantFinal, emptyTranscript, markAnswered, notice, permissionRequest, toolResult, toolUse, settleTools } from './transcript';
import { refreshWorktrees, renderWorktreeView, renderWorktrees } from './worktrees';
import { onSubagentLog, recordAgentEvent, renderSubagentView } from './subagents';
import { notify } from './notify';
import { clearQueuedTurns, endTurn, noteToolUse, onRewound, startTurn } from './changes';
import { noteGauges, renderUsageView, setPlanLimit } from './usage';
import { workstreamFile } from './workstreams';
import { onGitChanges, renderGit, setFetchMinutes } from './git';
import { reopenProjects } from './app';

// ---------- events ----------

export let pendingOpen: string | null = null;
// The project to show once everything has reopened, read once at start-up.
export let restoreActive: string | null = null;
export const setPendingOpen = (dir: string | null) => (pendingOpen = dir);
export const setRestoreActive = (dir: string | null) => (restoreActive = dir);

export function onEvent(e: SidecarEvent): void {
  switch (e.type) {
    case 'ready':
      return;
    case 'providers':
      setProviderList(e.list);
      renderComposer();
      renderSession();
      return;
    case 'probe':
      return onProbe(e.requestId, e.ok, e.models, e.error);
    case 'createProgress':
    case 'projectCreated':
      return onCreateEvent(e);
    case 'editors':
      setEditorList(e.list);
      return;
    case 'openProjects':
      return reopenProjects(e.list, e.active);
    case 'gitSettings':
      setFetchMinutes(e.fetchMinutes);
      $<HTMLSelectElement>('fetch-minutes').value = String(e.fetchMinutes);
      return;
    case 'mcpServers':
      return onMcpServers(e);
    case 'auth':
    case 'loginUrl':
    case 'loginLine':
    case 'loginDone':
      return onLoginEvent(e);
    case 'globalNotice':
      if (active) notice(active, e.level, e.text);
      else console.warn(e.text);
      if ($<HTMLDialogElement>('provider-dialog').open) $('probe-status').textContent = e.text;
      return;
  }

  if (e.type === 'project') {
    let p = projects.get(e.project);
    if (!p) {
      p = newProject(e.project, e.name);
      projects.set(e.project, p);
      saveOpenProjects();
    } else {
      // A replay (window reloaded): rebuild the transcript from scratch.
      p.liveText.clear();
      p.toolCards.clear();
      p.permissionCards.clear();
      p.pending.clear();
    }
    p.framework = e.framework;
    p.mode = e.permissionMode;
    p.providerId = e.providerId;
    p.replaying = true;
    emptyTranscript(p);
    if (!active || restoreActive === p.dir || pendingOpen === p.dir) {
      if (restoreActive === p.dir) restoreActive = null;
      if (pendingOpen === p.dir) pendingOpen = null;
      activate(p);
    } else renderProjects();
    return;
  }

  const p = projects.get(e.project);
  if (!p) return;
  const isActive = p === active;
  const markUnseen = () => {
    if (!isActive && !p.replaying) p.unseen = true;
  };

  switch (e.type) {
    case 'replayDone':
      p.replaying = false;
      refreshWorktrees(p);
      // The subagent lane may have moved on while the window was away.
      trackLane(p);
      p.transcript.scrollTop = p.transcript.scrollHeight;
      break;
    case 'closed':
      p.transcript.remove();
      projects.delete(e.project);
      saveOpenProjects();
      if (docsView?.project === e.project) closeDocs();
      if (isActive) activate([...projects.values()][0]);
      else renderProjects();
      return;
    case 'session':
      p.session = e.info;
      break;
    case 'commands':
      p.commands = e.commands;
      return;
    case 'gitChanges':
      return onGitChanges(p, e);
    case 'git':
      p.git = e.info;
      if (isActive) renderGit();
      return;
    case 'usage':
      p.usage = e.usage;
      if (docsView?.project === p.dir && docsView.usage) renderUsageView(p);
      if (isActive) renderSession();
      return;
    case 'gauges':
      noteGauges(p, e.gauges);
      if (isActive) renderSession();
      return;
    case 'planLimit':
      setPlanLimit(e.limit);
      if (isActive) renderSession();
      return;
    case 'mode':
      p.mode = e.mode;
      if (isActive) renderComposer();
      break;
    case 'provider':
      p.providerId = e.providerId;
      p.session = undefined;
      p.lastTurn = undefined;
      if (isActive) {
        renderComposer();
        renderSession();
      }
      break;
    case 'busy': {
      // Nothing left to answer: messages folded into an earlier turn won't get turns of their own.
      if (!e.busy) clearQueuedTurns(p);
      const finished = p.busy && !e.busy;
      if (finished) markUnseen();
      p.busy = e.busy;
      p.status = e.status;
      if (finished && !p.replaying) {
        // Tell the person when nothing else is about to start: the work, or the whole queue, is done.
        const held = p.holdQueue || !!p.lastTurn?.stopped;
        const more = !held && (nextQueued(p) || (!p.laneRun && nextQueued(p, undefined, 'subagent')));
        if (!more && !p.lastTurn?.stopped) {
          notify(p, p.queueRan ? 'queueDone' : 'finished', p.lastReply?.split('\n').find((l) => l.trim())?.slice(0, 140));
          p.queueRan = false;
        }
        startQueued(p);
      }
      break;
    }
    case 'user':
      startTurn(p, e);
      userMessage(p, e.text, e.action, e.attachments);
      scrollToEnd(p);
      p.freshTurn = true;
      break;
    case 'assistantDelta':
      return assistantDelta(p, e.msgId, e.index, e.text);
    case 'assistantText':
      recordAgentEvent(p, e);
      assistantFinal(p, e.msgId, e.text, e.parent);
      if (e.parent) return;
      noteReply(p, e.msgId, e.text);
      p.lastReply = e.text;
      if (isActive) renderQuestions();
      return;
    case 'askQuestions':
      askQuestions(p, e.id, e.questions);
      notify(p, 'needsYou', e.questions[0]?.question);
      break;
    case 'thinking':
      return;
    case 'toolUse':
      recordAgentEvent(p, e);
      noteToolUse(p, e.name, e.input, e.parent);
      return toolUse(p, e.id, e.name, e.input, e.parent);
    case 'toolResult':
      recordAgentEvent(p, e);
      return toolResult(p, e.toolUseId, e.isError, e.preview);
    case 'subagentLog':
      return onSubagentLog(p, e.agentId, e.events);
    case 'rewound':
      return onRewound(p, e);
    case 'permissionRequest':
      permissionRequest(p, e.id, e.toolName, e.input, e.reason);
      notify(p, 'needsYou', `Wants to use ${e.toolName}.`);
      break;
    case 'permissionResolved':
      if (p.asked.delete(e.id) && isActive) {
        if (docsView?.question === `ask:${e.id}`) afterAnswer(p);
        else renderQuestions();
      }
      return markAnswered(p, e.id, 'Cancelled');
    case 'turnEnd':
      settleTools(p, !!e.stopped);
      p.lastTurn = e;
      endTurn(p);
      if (!p.replaying) refreshWorktrees(p);
      if (e.stopped) notice(p, 'info', 'Stopped.');
      else if (e.isError) notice(p, 'error', e.errors?.length ? e.errors.join('\n') : 'The turn ended with an error.');
      break;
    case 'processes': {
      // A subagent that just finished may have left a worktree to review.
      const live = (list: typeof e.list) => list.filter((x) => x.kind === 'subagent' && ['running', 'pending'].includes(x.status)).length;
      const ended = live(e.list) < live(p.processes);
      p.processes = e.list;
      trackLane(p);
      if (ended && !p.replaying) refreshWorktrees(p);
      if (docsView?.subagent && isActive) renderSubagentView(p);
      break;
    }
    case 'worktrees':
      p.worktrees = e.list;
      if (isActive) {
        renderWorktrees();
        if (docsView?.worktree) renderWorktreeView(p);
      }
      return;
    case 'worktreeDiff':
      if (docsView?.worktree === e.path && docsView.requestId === e.requestId) {
        docsView.diff = e.diff;
        renderWorktreeView(p);
      }
      return;
    case 'tasks': {
      const before = p.tasks.length ? waitingQueued(p) : undefined;
      p.tasks = e.files;
      p.docs = new Set(e.docs);
      p.docQuestions = e.questions ?? [];
      refreshDocs(p);
      if (before) startFreed(p, before);
      break;
    }
    case 'priorities':
      p.priorities = e.order;
      p.subagentLane = new Set(e.subagent ?? []);
      p.laneRun = e.laneRun ?? undefined;
      break;
    case 'docs':
      if (docsView && docsView.project === p.dir && docsView.requestId === e.requestId) {
        docsView.docs = e.docs;
        renderDocs();
      }
      return;
    case 'notice':
      notice(p, e.level, e.text);
      break;
  }

  renderProjects();
  if (!isActive) return;
  switch (e.type) {
    case 'session':
    case 'turnEnd':
      return renderSession();
    case 'busy':
      renderPriorities(p);
      return renderComposer();
    case 'processes':
      // A workstream's subagent starting or ending changes its state on the board.
      if (workstreamFile(p)) {
        renderTasks();
        if (docsView?.workstreams) renderDocs();
      }
      return renderProcesses();
    case 'askQuestions':
      // Claude waits on the answer, so the question opens straight away unless you're mid-way through something else.
      if (!p.replaying && (!docsView || docsView.question)) openQuestion(p, `ask:${e.id}`);
      else renderQuestions();
      return renderComposer();
    case 'tasks':
    case 'priorities':
      renderTasks();
      renderQuestions();
      renderHeader();
      if (docsView) renderDocs();
      return;
  }
}
