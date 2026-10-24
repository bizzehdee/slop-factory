import type { AskedQuestion, OpenQuestion, SentAction } from '../../sidecar/src/protocol';
import { submit } from './app';
import { renderHeader } from './chrome';
import { closeDocs, docsView, renderDocs, setDocsView, showDoc } from './docs';
import { $, h, md } from './dom';
import { field } from './providers';
import { Proj, active, send } from './state';
import { appendEntry, markAnswered } from './transcript';

// ---------- questions ----------

export interface ChatQuestion {
  id: string;
  text: string;
}

export const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * The questions in one of Claude's replies: list items and prose lines with a question mark,
 * and every item of a list under a "Questions" line. A list item keeps the options under it.
 */
export function extractQuestions(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let fence = false;
  let underQuestions = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line.trim()) continue;
    const item = LIST_ITEM.exec(line);
    if (!item) {
      // A short lead-in such as "Questions:" or "**Open questions**", not any sentence that mentions them.
      underQuestions = !line.includes('?') && /\bquestions?\b/i.test(line) && line.trim().length <= 80 && (/:\**\s*$/.test(line) || /^\s*(#{1,6}\s|\*\*)/.test(line));
      if (line.includes('?')) out.push(line.replace(/^\s*(#{1,6}\s+|>\s*)/, '').trim());
      continue;
    }
    if (!item[2].includes('?') && !underQuestions) continue;
    // A recommended choice is an answer on offer, not a question.
    if (!item[2].includes('?') && /\(recommended\)/i.test(item[2])) continue;
    const indent = item[1].length;
    const parts = [item[2].trim()];
    for (; i + 1 < lines.length; i++) {
      const sub = /^(\s*)\S/.exec(lines[i + 1]);
      if (!sub || sub[1].length <= indent) break;
      parts.push(lines[i + 1].trim());
    }
    out.push(parts.join('\n'));
  }
  return out;
}

export function noteReply(p: Proj, msgId: string, text: string): void {
  if (p.freshTurn) {
    p.chatQuestions = [];
    p.freshTurn = false;
  }
  extractQuestions(text).forEach((q, n) => p.chatQuestions.push({ id: `chat:${msgId}:${n}`, text: q }));
}

export function askQuestions(p: Proj, id: string, questions: AskedQuestion[]): void {
  p.pending.add(id);
  p.asked.set(id, questions);
  const card = h(
    'div',
    { class: 'permission ask-note', role: 'group', 'aria-label': 'The agent has questions for you' },
    h('p', { class: 'permission-title' }, questions.length === 1 ? 'The agent has a question for you' : `The agent has ${questions.length} questions for you`),
    h('p', { class: 'permission-reason' }, questions.map((q) => q.question).join(' · ')),
    h('div', { class: 'permission-actions' }, h('button', { class: 'button primary', type: 'button', onclick: () => openQuestion(p, `ask:${id}`) }, 'Answer')),
  );
  p.permissionCards.set(id, card);
  appendEntry(p, card);
}

export const RECOMMENDED = /\s*\((recommended)\)\s*$/i;

/** Claude's AskUserQuestion call as a form: every question in the call is answered together. */
export function askForm(p: Proj, id: string, questions: AskedQuestion[]): { body: HTMLElement; actions: HTMLElement[] } {
  const picks = questions.map(() => new Set<string>());
  const others = questions.map(() => '');
  const submit = h('button', { class: 'button primary', type: 'button', disabled: true }, questions.length > 1 ? 'Submit answers' : 'Submit answer') as HTMLButtonElement;
  const complete = () => questions.every((_, i) => picks[i].size > 0 && (!picks[i].has('__other') || others[i].trim()));
  const refresh = () => (submit.disabled = !complete());
  const settle = (outcome: string) => {
    p.asked.delete(id);
    markAnswered(p, id, outcome);
    afterAnswer(p);
  };
  submit.addEventListener('click', () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = [...picks[i]].map((l) => (l === '__other' ? others[i].trim() : l)).join(', ');
    });
    send({ type: 'answerQuestions', project: p.dir, id, answers });
    settle('Answered');
  });

  const blocks = questions.map((q, i) => {
    const name = `${id}:${i}`;
    const type = q.multiSelect ? 'checkbox' : 'radio';
    const choose = (value: string, on: boolean) => {
      if (!q.multiSelect) picks[i].clear();
      if (on) picks[i].add(value);
      else picks[i].delete(value);
      refresh();
    };
    const other = h('input', { class: 'ask-other-text', type: 'text', placeholder: 'Your own answer', 'aria-label': `Your own answer to: ${q.question}` }) as HTMLInputElement;
    const otherPick = h('input', { type, name, value: '__other', 'aria-label': 'Use your own answer' }) as HTMLInputElement;
    other.addEventListener('input', () => {
      others[i] = other.value;
      if (others[i].trim() && !otherPick.checked) {
        otherPick.checked = true;
        choose('__other', true);
      } else refresh();
    });
    otherPick.addEventListener('change', () => choose('__other', otherPick.checked));
    return h(
      'fieldset',
      { class: 'ask-q' },
      h('legend', {}, q.header ? h('span', { class: 'ask-header' }, q.header) : null, h('span', { class: 'ask-question' }, q.question)),
      q.multiSelect ? h('p', { class: 'ask-hint' }, 'Choose any that apply') : null,
      ...q.options.map((o) => {
        const recommended = RECOMMENDED.test(o.label);
        const input = h('input', { type, name, value: o.label }) as HTMLInputElement;
        input.addEventListener('change', () => choose(o.label, input.checked));
        return h(
          'label',
          { class: `ask-option${recommended ? ' recommended' : ''}` },
          input,
          h(
            'span',
            { class: 'ask-option-body' },
            h('span', { class: 'ask-option-label' }, o.label.replace(RECOMMENDED, ''), recommended ? h('span', { class: 'badge' }, 'Recommended') : null),
            o.description ? h('span', { class: 'ask-option-desc' }, o.description) : null,
          ),
        );
      }),
      h('label', { class: 'ask-option other' }, otherPick, other),
    );
  });

  const dismiss = h(
    'button',
    {
      class: 'button quiet',
      type: 'button',
      title: 'The agent carries on and you answer in your next message',
      onclick: () => {
        send({ type: 'answerQuestions', project: p.dir, id });
        settle('Dismissed: answer in the conversation');
      },
    },
    'Answer in chat instead',
  );
  return { body: h('div', { class: 'ask-form' }, ...blocks), actions: [submit, dismiss] };
}

export interface QuestionRow {
  id: string;
  text: string;
  source?: OpenQuestion;
}

export const where = (q: QuestionRow) => (q.source ? `${q.source.rel}, Open questions` : 'asked in the conversation');
export const questionTitle = (text: string) => text.split('\n')[0].replace(/\*\*|__|`/g, '');

export function openRows(p: Proj): QuestionRow[] {
  return [
    ...p.chatQuestions.filter((q) => !p.answeredQuestions.has(q.id)).map((q) => ({ id: q.id, text: q.text })),
    ...p.docQuestions.filter((q) => !p.answeredQuestions.has(q.id)).map((q) => ({ id: q.id, text: q.text, source: q })),
  ];
}

/** Send the answers typed so far: the given questions, or every one with a draft. */
export function sendAnswers(p: Proj, only?: string[]): void {
  const rows = openRows(p).filter((q) => (!only || only.includes(q.id)) && p.answerDrafts.get(q.id)?.trim());
  if (!rows.length) return;
  const lines = rows.map((q, n) => `${n + 1}. ${questionTitle(q.text)} (${where(q)})\n   Answer: ${p.answerDrafts.get(q.id)!.trim().replace(/\n/g, '\n   ')}`);
  send({
    type: 'send',
    project: p.dir,
    text:
      `My answers to open questions:\n\n${lines.join('\n\n')}` +
      (rows.some((q) => q.source) ? '\n\nRecord each decision in the document that owns it and take it off that Open questions list, as the project-planning standard says.' : ''),
  });
  for (const q of rows) {
    p.answeredQuestions.add(q.id);
    p.answerDrafts.delete(q.id);
    p.selectedQuestions.delete(q.id);
  }
  afterAnswer(p);
}

/** Have Claude ask the given questions (or the selected ones) as multiple choice, with recommendations. */
export function askAsChoices(p: Proj, only?: string[]): void {
  const rows = openRows(p).filter((q) => (only ? only.includes(q.id) : p.selectedQuestions.has(q.id)));
  if (!rows.length) return;
  send({
    type: 'send',
    project: p.dir,
    text:
      'Ask me these open questions with the AskUserQuestion tool, at most four per call. Check the code and the plan first so the ' +
      'options are grounded. Give each question 2 to 4 distinct options with a short description, and end the label of every ' +
      'option you recommend with " (Recommended)": at least one per question, more where several are good. When I answer, record ' +
      'each decision where its question lives and take it off that Open questions list.\n\n' +
      rows.map((q, n) => `${n + 1}. ${q.text.replace(/\n/g, ' ')} (${where(q)})`).join('\n'),
  });
  for (const q of rows) p.selectedQuestions.delete(q.id);
  if (docsView?.question) closeDocs();
  renderQuestions(true);
}

/** After answering from the popup, move on to the next open question, or close it. */
export function afterAnswer(p: Proj): void {
  renderQuestions(true);
  if (!docsView?.question || docsView.project !== p.dir) return;
  const next = [...p.asked.keys()].map((id) => `ask:${id}`)[0] ?? openRows(p).find((r) => !r.source?.leftOpen)?.id;
  if (next) openQuestion(p, next);
  else closeDocs();
}

export function openQuestion(p: Proj, id: string): void {
  setDocsView({ project: p.dir, key: `question:${id}`, requestId: '', tab: '', docs: [], question: id });
  questionViewKey = '';
  renderDocs();
  renderHeader();
  renderQuestions(true);
  $('docs-panel').hidden = false;
  ($('docs-body').querySelector<HTMLElement>('textarea, input') ?? $('docs-close')).focus();
}

export let questionViewKey = '';
export const resetQuestionView = () => (questionViewKey = '');

/** The question popup, in the docs panel. Rebuilt only when it shows something else, so drafts and picks survive. */
export function renderQuestionView(p: Proj | undefined, id: string): void {
  const key = `${p?.dir}|${id}`;
  if (key === questionViewKey) return;
  questionViewKey = key;
  $('docs-tabs').hidden = true;
  const body = $('docs-body');
  const actions = $('docs-actions');
  actions.hidden = false;
  const askId = id.startsWith('ask:') ? id.slice(4) : undefined;
  const asked = p && askId ? p.asked.get(askId) : undefined;
  const row = p && !askId ? openRows(p).find((r) => r.id === id) : undefined;

  if (p && askId && asked) {
    $('docs-ref').textContent = 'The agent is asking';
    $('docs-title').textContent = asked.length > 1 ? `${asked.length} questions` : asked[0].header || 'A question';
    const form = askForm(p, askId, asked);
    body.replaceChildren(form.body);
    actions.replaceChildren(...form.actions);
    return;
  }
  if (!p || !row) {
    $('docs-ref').textContent = '';
    $('docs-title').textContent = 'Question';
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, 'This question has been answered.')));
    actions.replaceChildren();
    actions.hidden = true;
    return;
  }

  $('docs-ref').textContent = row.source ? row.source.doc : 'From the conversation';
  $('docs-title').textContent = questionTitle(row.text);
  const text = h('div', { class: 'q-full' });
  text.innerHTML = md(row.text);
  const answer = h('textarea', { class: 'q-answer', rows: 4, placeholder: 'Your answer', 'aria-label': 'Your answer' }) as HTMLTextAreaElement;
  answer.value = p.answerDrafts.get(id) ?? '';
  const sendBtn = h('button', { class: 'button primary', type: 'button', disabled: !answer.value.trim(), onclick: () => sendAnswers(p, [id]) }, 'Send answer') as HTMLButtonElement;
  answer.addEventListener('input', () => {
    p.answerDrafts.set(id, answer.value);
    sendBtn.disabled = !answer.value.trim();
    renderQuestions();
  });
  answer.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      sendAnswers(p, [id]);
    }
  });
  const left = row.source?.leftOpen;
  const parts: HTMLElement[] = [];
  if (row.source) {
    const src = row.source;
    parts.push(h('p', { class: 'docs-path' }, h('button', { class: 'link-button', type: 'button', onclick: () => showDoc(p, src.rel, src.doc) }, `${src.rel}, line ${src.line + 1}`)));
  }
  if (left) parts.push(h('p', { class: 'q-tag' }, typeof left === 'string' ? `You left this open on ${left}` : 'You left this open'));
  parts.push(
    text,
    h('label', { class: 'q-answer-label' }, h('span', {}, 'Your answer'), answer),
    h('p', { class: 'field-hint' }, 'Ctrl+Enter to send. Or have the agent ask it as multiple choice, with the options it recommends.'),
  );
  body.replaceChildren(...parts);
  actions.replaceChildren(sendBtn, h('button', { class: 'button', type: 'button', onclick: () => askAsChoices(p, [id]) }, 'Ask me as choices'));
}

export let questionsKey = '';

/** The list in the right bar: one line per question; clicking one opens it. */
export function renderQuestions(force = false): void {
  const p = active;
  const section = $('questions-section');
  if (!p) {
    section.hidden = true;
    questionsKey = '';
    return;
  }
  const rows = openRows(p);
  const asked = [...p.asked.entries()];
  const openId = docsView?.project === p.dir ? docsView.question : undefined;
  const key = JSON.stringify([p.dir, asked.map(([id]) => id), rows.map((r) => [r.id, !!p.answerDrafts.get(r.id)?.trim()]), openId]);
  const count = asked.reduce((n, [, qs]) => n + qs.length, 0) + rows.filter((r) => !r.source?.leftOpen).length;
  $('questions-count').textContent = count ? `${count} open` : '';
  section.hidden = !asked.length && !rows.length;
  if (!force && key === questionsKey) return updateQuestionActions(p);
  questionsKey = key;

  const item = (id: string, label: string, extra: { pick?: boolean; tag?: string; cls?: string }) => {
    const li = h('li', { class: `q-row${extra.cls ? ` ${extra.cls}` : ''}${openId === id ? ' open' : ''}` });
    if (extra.pick) {
      const pick = h('input', { type: 'checkbox', class: 'q-pick', title: 'Select to have the agent ask it as multiple choice', 'aria-label': `Select: ${label}` }) as HTMLInputElement;
      pick.checked = p.selectedQuestions.has(id);
      pick.addEventListener('change', () => {
        if (pick.checked) p.selectedQuestions.add(id);
        else p.selectedQuestions.delete(id);
        updateQuestionActions(p);
      });
      li.append(pick);
    } else li.append(h('span', { class: 'q-dot', 'aria-hidden': 'true' }));
    li.append(
      h(
        'button',
        { class: 'q-open', type: 'button', title: label, onclick: () => openQuestion(p, id) },
        h('span', { class: 'q-label' }, label),
        extra.tag ? h('span', { class: 'q-tag' }, extra.tag) : null,
        p.answerDrafts.get(id)?.trim() ? h('span', { class: 'q-tag draft' }, 'draft') : null,
      ),
    );
    return li;
  };

  const groups: HTMLElement[] = [];
  if (asked.length) {
    groups.push(
      h('div', { class: 'q-group asking' }, h('h3', {}, 'The agent is asking'), h('ul', { class: 'q-list' }, ...asked.flatMap(([id, qs]) => qs.map((q) => item(`ask:${id}`, q.question, { cls: 'asking' }))))),
    );
  }
  const chat = rows.filter((r) => !r.source);
  if (chat.length) groups.push(h('div', { class: 'q-group' }, h('h3', {}, 'From the conversation'), h('ul', { class: 'q-list' }, ...chat.map((r) => item(r.id, questionTitle(r.text), { pick: true })))));
  const byDoc = new Map<string, QuestionRow[]>();
  for (const r of rows) if (r.source) byDoc.set(r.source.rel, [...(byDoc.get(r.source.rel) ?? []), r]);
  for (const [rel, list] of byDoc) {
    groups.push(
      h(
        'div',
        { class: 'q-group' },
        h('h3', {}, h('button', { class: 'link-button q-doc', type: 'button', title: `Open ${rel}`, onclick: () => showDoc(p, rel, list[0].source!.doc) }, list[0].source!.doc)),
        h('ul', { class: 'q-list' }, ...list.map((r) => item(r.id, questionTitle(r.text), { pick: true, tag: r.source?.leftOpen ? 'left open' : undefined, cls: r.source?.leftOpen ? 'left-open' : undefined }))),
      ),
    );
  }
  if (rows.length) {
    groups.push(
      h(
        'div',
        { class: 'q-actions' },
        h('button', { class: 'button', type: 'button', id: 'q-ask', title: 'The agent asks the selected questions as multiple choice, with its recommendations', onclick: () => askAsChoices(p) }, 'Ask as choices'),
        h('button', { class: 'button', type: 'button', id: 'q-send', onclick: () => sendAnswers(p) }, 'Send drafts'),
      ),
    );
  }
  $('questions').replaceChildren(...groups);
  updateQuestionActions(p);
}

export function updateQuestionActions(p: Proj): void {
  const rows = openRows(p);
  const drafts = rows.filter((q) => p.answerDrafts.get(q.id)?.trim()).length;
  const picked = rows.filter((q) => p.selectedQuestions.has(q.id)).length;
  const sendBtn = document.getElementById('q-send') as HTMLButtonElement | null;
  const askBtn = document.getElementById('q-ask') as HTMLButtonElement | null;
  if (sendBtn) {
    sendBtn.hidden = !drafts;
    sendBtn.textContent = drafts > 1 ? `Send ${drafts} drafts` : 'Send draft';
  }
  if (askBtn) {
    askBtn.disabled = !picked;
    askBtn.textContent = picked ? `Ask ${picked} as choices` : 'Select to ask as choices';
  }
}

export const ACTION_LABEL: Record<SentAction, string> = { start: 'Start now', startSubagent: 'Start in subagent', reinvestigate: 'Reinvestigate', summarise: 'Summarise', runWorkstreams: 'Run workstreams', findWorkstreams: 'Find workstreams', commit: 'Commit changes' };

export function userMessage(p: Proj, text: string, action?: { kind: SentAction; key: string }, attachments: string[] = []): void {
  p.transcript.querySelector('.empty')?.remove();
  if (action) {
    // Board buttons send a prompt on your behalf; show what was sent, folded.
    const el = h(
      'details',
      { class: 'msg user action' },
      h('summary', {}, h('span', { class: 'action-kind' }, ACTION_LABEL[action.kind]), ` ${action.key}`),
      h('div', { class: 'action-prompt' }, text),
    );
    return appendEntry(p, el);
  }
  const files = attachments.length ? h('div', { class: 'msg-attachments' }, ...attachments.map((n) => h('span', { class: 'attachment-chip sent' }, n))) : null;
  appendEntry(p, h('div', { class: 'msg user' }, text, files));
}

/** Your own message always brings the conversation to the bottom, wherever you had scrolled. */
export function scrollToEnd(p: Proj): void {
  if (!p.replaying) p.transcript.scrollTop = p.transcript.scrollHeight;
}
