import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Row } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, HostDialogs, makeDialogDraggable } from '@cawoodm/lit-dialogs';
import { watchDialogDirty } from '../chrome/dirty-guard.js';
import {
  USER_SAMPLES_SETTING,
  addUserSample,
  builtinSamples,
  parseUserSamples,
  removeUserSample,
  userSamplesFor,
  type SampleKind,
  type ScriptSample,
  type UserScriptSample,
} from './script-samples.js';
import { getContext } from '../app-context.js';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { requestVisibleRows } from '../table/visible-rows.js';
import { materializeColumnScript, materializeSummary } from '../table/materialize-script.js';

/**
 * Which script is being edited. They share this one editor because everything
 * around the textarea — draggable modal, Ctrl-Enter save, cancel semantics — is
 * identical; only the boilerplate, the wording and the samples dropdown differ.
 *
 * `render` / `validate` are a column's two scripts. `token` is a VIEW TOKEN's
 * script: the same `render(row)` shape and the same samples, but it formats what
 * a view SHOWS and never touches the stored cell.
 *
 * `viz-html` and `viz-script` are the two halves of a custom visualization. They
 * are here rather than in a textarea of their own because everything around the
 * box — the samples dropdown, the **+** that saves what you wrote, Ctrl-Enter,
 * the Undo after picking a sample — is exactly what writing one of these needs,
 * and a plain `text` settings field has none of it.
 */
export type ScriptKind = 'render' | 'validate' | 'token' | 'viz-html' | 'viz-script';

/**
 * The saved column a `render` script belongs to, which is what Run needs to
 * write to. Absent while a table is still being created — there are no rows to
 * write yet — and Run is hidden then.
 */
export interface ScriptTarget {
  tableId: string;
  field: string;
}

/**
 * Boilerplate inserted into a fresh script editor. Shows the required
 * `render(row)` signature and a minimal working example, so the user can hit
 * Save once and see the cell render without writing anything themselves.
 *
 * The return value replaces the stored value on its way into whatever
 * renderer the column has (or is shown as text when the column has none).
 */
const BOILERPLATE = `function render(row) {
  // \`row\` is the full row object — access any field by name (row.field).
  // Return the value this column should display.
  return row.name ?? '';
}
`;

/**
 * The same for a VIEW TOKEN, seeded with the field the token maps to (when it
 * maps to one) — the transform wanted is almost always "that cell, formatted",
 * so naming the field saves the user looking it up.
 */
function tokenBoilerplate(field: string): string {
  const read = field ? `row.${field}` : 'row.name';
  return `function render(row) {
  // \`row\` is the full row object — access any field by name (row.field).
  // Return what this token should show; HTML is rendered, not escaped.
  return ${read} ?? '';
}
`;
}

/**
 * The same for a validation script. Deliberately a rule that never fires: the
 * shape is the lesson, and a fresh column shouldn't start rejecting edits just
 * because the editor was opened and saved.
 */
const VALIDATE_BOILERPLATE = `function validate(value, row) {
  // \`value\` is what the user just typed; \`row\` is the rest of the row.
  // THROW to reject the edit — the message is what they will see.
  if (false) throw new Error('Explain what is wrong here.');
}
`;

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The user's samples out of the workspace settings. Never throws: the editor has
 * to open even when the store is unhappy, so a failed read is an empty list.
 */
async function readUserSamples(): Promise<UserScriptSample[]> {
  try {
    const ctx = await getContext();
    const row = await ctx.store.settings.findOne(USER_SAMPLES_SETTING);
    return parseUserSamples(row?.value);
  } catch {
    return [];
  }
}

/** Write the whole list back as one setting. */
async function writeUserSamples(all: ReadonlyArray<UserScriptSample>): Promise<void> {
  const ctx = await getContext();
  await ctx.store.settings.upsert({ name: USER_SAMPLES_SETTING, value: [...all] });
}

/**
 * Modal editor for a column's `script` source. Mounted once from `<app-shell>` and
 * accessed via the static `instance` accessor (same pattern as
 * `HostDialogs.instance`). `open()` returns a promise that resolves to
 * the new source on Save or `null` on Cancel.
 *
 * The textarea is the entire editing surface — deliberately plain to
 * stay inside the renderer bundle without pulling in a code editor
 * dependency. Power users who want full IntelliSense can paste from
 * their own editor.
 */
@customElement('script-editor-dialog')
export class ScriptEditorDialog extends LitElement {
  static instance: ScriptEditorDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        width: 720px;
        max-width: 92vw;
      }
      p.hint {
        margin: 0;
        color: #6b7280;
        font-size: 0.85rem;
      }
      p.hint code {
        font-family: ui-monospace, SFMono-Regular, monospace;
        background: #f3f4f6;
        padding: 0.05rem 0.25rem;
        border-radius: 0.2rem;
      }
      .samples {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
        color: #374151;
      }
      .samples select {
        font: inherit;
        padding: 0.3rem 0.4rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        flex: 1;
        min-width: 0;
      }
      button.link {
        background: transparent;
        border: 0;
        padding: 0;
        color: #2563eb;
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
      }
      button.link[disabled] {
        color: #9ca3af;
        text-decoration: none;
        cursor: default;
      }
      /* Beside the dropdown: 🗑 deletes the user sample currently loaded (disabled
         — not hidden — for a built-in, so the row's shape does not jump as you
         browse it), + keeps what is in the editor. Same pair, same glyphs, as the
         Import dialog's sample row. */
      button.icon {
        background: transparent;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        padding: 0.3rem 0.5rem;
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        flex: 0 0 auto;
      }
      button.icon:hover:not([disabled]) {
        border-color: #bfdbfe;
        background: #eff6ff;
      }
      button.icon.danger:hover:not([disabled]) {
        border-color: #fecaca;
        background: #fef2f2;
      }
      button.icon[disabled] {
        opacity: 0.4;
        cursor: default;
      }
      textarea {
        font:
          0.85rem ui-monospace,
          SFMono-Regular,
          monospace;
        padding: 0.6rem 0.75rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        min-height: 320px;
        resize: vertical;
        tab-size: 2;
      }
    `,
  ];

  @state() private text = '';
  @state() private columnLabel = '';
  @state() private kind: ScriptKind = 'render';
  /**
   * What the editor held before a sample was applied, so one dropdown pick
   * can't silently eat a hand-written rule. Cleared once the user types (they
   * are now editing the sample, not deciding whether to keep it) and on every
   * open.
   */
  @state() private undoText: string | null = null;
  /** The user's own samples, both kinds, as stored. Re-read on every open. */
  @state() private userSamples: UserScriptSample[] = [];
  /**
   * The user sample currently loaded in the editor, so the trash button knows
   * WHICH sample it deletes. Null for a built-in or for hand-written text — a
   * built-in sample is code and cannot be deleted.
   */
  @state() private pickedUserId: string | null = null;
  /** Where Run writes. Null hides the button — see `ScriptTarget`. */
  @state() private target: ScriptTarget | null = null;
  /** A run is in flight; Run and Save are held so neither can race the writes. */
  @state() private running = false;
  private dialogEl: HTMLDialogElement | null = null;
  private resolver: ((v: string | null) => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    ScriptEditorDialog.instance = this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (ScriptEditorDialog.instance === this) ScriptEditorDialog.instance = null;
  }

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    if (this.dialogEl) watchDialogDirty('script-editor', this.dialogEl);
  }

  /**
   * Open the editor with the given source and column label. Resolves to
   * the new source on Save, or `null` if the user cancels / dismisses.
   * Only one editor instance is active at a time; calling open() again
   * before the previous promise resolves will cancel the previous one.
   *
   * `opts.field` is the column a `token` script's token maps to; it only seeds
   * the boilerplate.
   */
  async open(initial: string, columnLabel: string, kind: ScriptKind = 'render', opts?: { field?: string; target?: ScriptTarget | undefined }): Promise<string | null> {
    if (this.resolver) {
      // Caller opened a new editor before resolving the previous one —
      // treat the old promise as cancelled so it doesn't hang.
      this.resolver(null);
      this.resolver = null;
    }
    this.kind = kind;
    this.undoText = null;
    this.pickedUserId = null;
    this.running = false;
    // Only a column's render script has cells to write; a validation rule
    // returns nothing and a view token never touches the stored value.
    this.target = kind === 'render' ? (opts?.target ?? null) : null;
    // Pre-fill with boilerplate so users opening a fresh column-script see
    // the expected shape instead of an intimidating empty textarea. An
    // existing script wins — we never overwrite the user's source.
    this.text = initial && initial.trim() ? initial : this.blankFor(kind, opts?.field ?? '');
    this.columnLabel = columnLabel ?? '';
    // Read on every open, not once: another dialog (or another device, through
    // sync) may have added a sample since the last time this one was shown.
    this.userSamples = await readUserSamples();
    await this.updateComplete;
    this.dialogEl?.showModal();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  /** The boilerplate a fresh editor of this kind starts from. */
  private blankFor(kind: ScriptKind, field: string): string {
    if (kind === 'validate') return VALIDATE_BOILERPLATE;
    if (kind === 'token') return tokenBoilerplate(field);
    // A custom visualization starts EMPTY, unlike every other kind. Its HTML
    // box has no required shape to demonstrate, and its script is optional —
    // pre-filling either would make an empty visualization impossible to save
    // and would hide the samples dropdown behind text nobody asked for.
    if (kind === 'viz-html' || kind === 'viz-script') return '';
    return BOILERPLATE;
  }

  private resolve(value: string | null) {
    const r = this.resolver;
    this.resolver = null;
    this.dialogEl?.close();
    if (r) r(value);
  }

  private onCancel = () => this.resolve(null);

  private onSubmit = (e: Event) => {
    e.preventDefault();
    this.resolve(this.text);
  };

  /**
   * Which sample list this editor draws on. A `token` script is `render(row)`
   * like a column's, so the two share one list — a sample saved from a column
   * is offered in a view's token editor and the other way round.
   */
  private get sampleKind(): SampleKind {
    if (this.kind === 'validate') return 'validate';
    if (this.kind === 'viz-html') return 'viz-html';
    if (this.kind === 'viz-script') return 'viz-script';
    return 'render';
  }

  /** What the dialog calls itself. A visualization's markup is not a "script". */
  private get heading(): string {
    if (this.kind === 'validate') return 'Edit validation';
    if (this.kind === 'viz-html') return 'Edit HTML';
    return 'Edit script';
  }

  /** The shipped samples for whichever script is being edited. */
  private get samples(): ReadonlyArray<ScriptSample> {
    return builtinSamples(this.sampleKind);
  }

  /** The user's own samples for this kind. */
  private get mySamples(): UserScriptSample[] {
    return userSamplesFor(this.userSamples, this.sampleKind);
  }

  /**
   * Replace the editor contents with a sample, remembering what was there. The
   * `<select>` is reset to its placeholder so picking the SAME sample again
   * (after an undo, say) still fires a change event.
   *
   * Option values are prefixed (`b:` built-in, `u:` the user's) because the two
   * groups share one dropdown and a bare index would collide.
   */
  private applySample(e: Event) {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    select.value = '';
    const sample = value.startsWith('u:') ? this.mySamples.find((s) => s.id === value.slice(2)) : this.samples[Number(value.slice(2))];
    if (!sample) return;
    this.undoText = this.text;
    this.text = sample.source;
    this.pickedUserId = value.startsWith('u:') ? value.slice(2) : null;
  }

  private undoSample() {
    if (this.undoText === null) return;
    this.text = this.undoText;
    this.undoText = null;
  }

  private onInput(e: Event) {
    this.text = (e.target as HTMLTextAreaElement).value;
    // They're editing the sample now, not still deciding about it.
    this.undoText = null;
  }

  /**
   * Save what is in the editor as a sample of this kind, under a name the user
   * gives. Saved from a token editor it still lands in the `render` list, so it
   * is offered on columns too.
   */
  private async saveAsSample() {
    if (!this.text.trim()) return;
    const dialogs = HostDialogs.instance;
    if (!dialogs) return;
    const label = await dialogs.prompt('Name this sample — it appears in the dropdown for every script of this kind.', '', 'Add to samples');
    if (label === null || !label.trim()) return;
    const sample: UserScriptSample = { id: newId(), kind: this.sampleKind, label: label.trim(), source: this.text };
    this.userSamples = addUserSample(this.userSamples, sample);
    this.pickedUserId = sample.id;
    await writeUserSamples(this.userSamples);
  }

  /** Delete the user sample currently loaded, after a confirm. */
  private async deletePickedSample() {
    const id = this.pickedUserId;
    const sample = id ? this.mySamples.find((s) => s.id === id) : undefined;
    const dialogs = HostDialogs.instance;
    if (!id || !sample || !dialogs) return;
    const ok = await dialogs.confirm(`Delete the sample "${sample.label}"? The script in the editor stays as it is.`, 'Delete sample');
    if (!ok) return;
    this.userSamples = removeUserSample(this.userSamples, id);
    this.pickedUserId = null;
    await writeUserSamples(this.userSamples);
  }

  /**
   * Run the script in the editor over the table's rows and write what it
   * returns into the cells.
   *
   * Two questions before anything is written, because both answers change the
   * result and neither has a safe default:
   *
   *  - **Which rows** — asked only when the grid is showing fewer than the
   *    table holds. With no filter on there is one possible answer, and a
   *    dialog that only ever has one answer is a click, not a choice.
   *  - **Keep or clear the script** — a kept script goes on computing, so the
   *    cells still show the computed value and the write is invisible until
   *    something exports or syncs them. Clearing it hands the column over to
   *    the data. Both are legitimate; guessing is not.
   *
   * The write itself is immediate and cannot be undone. Clearing the script is
   * NOT: it comes back as this dialog's result, so it lands with the columns
   * editor's own Save, like every other column edit.
   */
  private async runNow(): Promise<void> {
    const target = this.target;
    const dialogs = HostDialogs.instance;
    if (!target || !dialogs || this.running || !this.text.trim()) return;
    this.running = true;
    try {
      const ctx = await getContext();
      const coll = ctx.store.rows(target.tableId);
      const visible = requestVisibleRows(target.tableId);
      const all = await coll.find();
      const shown = visible?.rows ?? null;

      let targets: readonly Row[] = all;
      if (shown && shown.length < all.length) {
        const allLabel = `All ${all.length.toLocaleString()} rows`;
        const someLabel = `Only the ${shown.length.toLocaleString()} rows shown`;
        const scope = await dialogs.choice(`The grid is showing ${shown.length.toLocaleString()} of ${all.length.toLocaleString()} rows. Which should the script write?`, [allLabel, someLabel], 'Run script');
        if (scope === null) return;
        targets = scope === someLabel ? shown : all;
      }

      const keep = 'Write and keep the script';
      const clear = 'Write and clear the script';
      const answer = await dialogs.choice(
        `Write what this script returns into “${target.field}” for ${targets.length.toLocaleString()} ${targets.length === 1 ? 'row' : 'rows'}? The stored values are replaced and this cannot be undone. ` +
          'Keeping the script leaves the column computed and read-only; clearing it makes the written values the data.',
        [clear, keep],
        'Run script',
      );
      if (answer === null) return;

      setAppProgress({ label: `Writing “${target.field}”`, fraction: 0 });
      const result = await materializeColumnScript(coll, this.text, target.field, targets, (done, total) =>
        setAppProgress({ label: `Writing “${target.field}”`, fraction: total > 0 ? done / total : undefined, detail: `${done.toLocaleString()} of ${total.toLocaleString()}` }),
      );
      clearAppProgress();
      ctx.api.ui.dialogs.toast(materializeSummary(result, target.field), { kind: result.failed > 0 ? 'error' : 'success', title: 'Run script' });
      // Resolving closes the editor: the run IS the decision about this script.
      this.resolve(answer === clear ? '' : this.text);
    } catch (err) {
      clearAppProgress();
      await dialogs.alert(`Could not run the script: ${err instanceof Error ? err.message : String(err)}`, 'Run script');
    } finally {
      this.running = false;
    }
  }

  /** The explanation above the textarea — different job, different contract. */
  private renderHints() {
    if (this.kind === 'viz-html') {
      return html`
        <p class="hint">
          Plain HTML, drawn over the rows the grid is currently showing. The tokens describe the <strong>whole set</strong>, not one row: <code>$COUNT</code> is how many rows are on screen,
          <code>$SUM.amount</code> their total, and <code>$AVG.</code> <code>$MIN.</code> <code>$MAX.</code> <code>$DISTINCT.</code> work the same way. Anything that is not a token is left exactly as
          you wrote it.
        </p>
        <p class="hint">
          <code>$filter.country</code> renders one clickable pill per distinct value. Clicking one narrows the grid this pane is docked to — a visualization is a two-way street — and the grid's own
          funnel is where it shows and where you clear it.
        </p>
      `;
    }
    if (this.kind === 'viz-script') {
      return html`
        <p class="hint">
          Optional. Define <code>function render(rows, api) { … }</code>. It runs once per draw, <em>after</em> the HTML is in place. <code>rows</code> is what the grid is showing (each with a
          <code>.data</code> object); return a string to replace the container's markup, or return nothing and build elements in <code>api.el</code> yourself.
        </p>
        <p class="hint">
          <code>api.columns</code> is the column specs, and <code>api.filter(field, value)</code> / <code>api.sort(field)</code> ask the host grid to change — the same thing a
          <code>$filter.</code> pill does.
        </p>
      `;
    }
    if (this.kind === 'token') {
      return html`
        <p class="hint">
          Define <code>function render(row) { … }</code>. <code>row</code> is the full row object. What you return is what this token shows — the stored cell is never changed. The result goes into the
          template as HTML, so <code>markdownToHtml(row.body)</code> shows formatted text and <code>new Date(row.date).toLocaleString()</code> shows a local date.
        </p>
        <p class="hint">
          Only a plain <code>$TOKEN</code> runs the script. <code>$input.TOKEN</code> and <code>$filter.TOKEN</code> keep reading the mapped column, because one writes the cell back and the other must
          match the stored value. A scripted token needs no column at all.
        </p>
      `;
    }
    if (this.kind === 'validate') {
      return html`
        <p class="hint">
          Define <code>function validate(value, row) { … }</code>. It runs when someone edits a cell in this column by hand, after the Max / Unique / Not-null boxes have had their say.
          <strong>Throw to reject the edit</strong> — your message is what they are shown, and the cell snaps back. Return without throwing to accept it; the return value is ignored.
        </p>
        <p class="hint">
          <code>value</code> is the proposed new value, <code>row</code> the rest of the row, so a rule can compare columns. Imports, refreshes and sync are not edits and never run it.
        </p>
      `;
    }
    return html`
      <p class="hint">
        Define <code>function render(row) { … }</code>. <code>row</code> is the full row object. What you return is passed to the column's renderer, so the cell shows a computed value instead of the
        stored one — and the cell becomes read-only. A script that throws shows a small error chip in the cell.
      </p>
      <p class="hint">
        Besides the JS globals you can call <code>markdownToHtml(text)</code> (also <code>easydb.markdownToHtml</code>) — set this column's renderer to <code>html</code> so the result shows as
        formatted text rather than as its own source. A sample that needs a particular renderer says so in its first line; the dropdown can't set it for you.
      </p>
    `;
  }

  override render() {
    const validating = this.kind === 'validate';
    const mine = this.mySamples;
    const picked = this.pickedUserId ? mine.find((s) => s.id === this.pickedUserId) : undefined;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.onCancel}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>${this.heading}${this.columnLabel ? ` — ${this.columnLabel}` : ''}</h2>
            <div class="header-actions">
              ${this.target
                ? html`<button
                    type="button"
                    class="ghost"
                    data-testid="script-run"
                    title="Write what this script returns into the column’s cells"
                    ?disabled=${this.running || !this.text.trim()}
                    @click=${() => void this.runNow()}
                  >
                    Run…
                  </button>`
                : null}
              <button type="button" class="ghost" @click=${this.onCancel}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${this.running}>Save</button>
            </div>
          </div>
          <div class="dialog-body">
            ${this.renderHints()}
            <div class="samples">
              <label for="sample">Start from a sample</label>
              <select
                id="sample"
                title=${validating ? 'Replace the editor contents with a ready-made rule' : this.kind === 'viz-html' ? 'Replace the editor contents with a ready-made block of HTML' : 'Replace the editor contents with a ready-made script'}
                @change=${(e: Event) => this.applySample(e)}
              >
                <option value="">— choose —</option>
                ${mine.length ? html`<optgroup label="Your samples">${mine.map((s) => html`<option value=${`u:${s.id}`}>${s.label}</option>`)}</optgroup>` : null}
                <optgroup label="Built in">${this.samples.map((s, i) => html`<option value=${`b:${i}`}>${s.label}</option>`)}</optgroup>
              </select>
              <button
                type="button"
                class="icon danger"
                title=${picked ? `Delete the sample "${picked.label}"` : 'Pick one of your own samples to delete it'}
                ?disabled=${!picked}
                @click=${() => void this.deletePickedSample()}
              >
                🗑
              </button>
              <button
                type="button"
                class="icon"
                data-testid="sample-add"
                title="Add what is in the editor to the sample list for this kind of script"
                ?disabled=${!this.text.trim()}
                @click=${() => void this.saveAsSample()}
              >
                +
              </button>
              ${this.undoText !== null ? html`<button type="button" class="link" @click=${() => this.undoSample()}>Undo</button>` : null}
            </div>
            <textarea spellcheck="false" autofocus .value=${this.text} @input=${(e: Event) => this.onInput(e)}></textarea>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'script-editor-dialog': ScriptEditorDialog;
  }
}
