// The send dialog: a text the panel built (a review, one thread) goes to an
// agent of the shown space with `hc send`, after an optional note. The panel
// opens it as an overlay of this same mod:
//   openOverlay({ mod: "commit-review", kind: "dialog", props: { dialog: true, title, text, sent } })
// `sent` names a shared key that is set to the send time once the text went
// out, so the panel submits the comments the text carried. Enter or
// ctrl-enter sends, Esc closes.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Popover } from "gpui-base";
import { agents, focused, hc, run, notify, props, closeOverlay, theme, settings, setShared } from "herdr";

const ICONS = "mods/commit-review";
// The text is pasted into the agent's terminal; some agents are slow with, or
// cut short, a paste this long.
const LONG = 8000;
// The preview shows this many lines; all of them are sent.
const PREVIEW_LINES = 400;

const nameOf = (agent) => agent.program?.name ?? agent.app ?? agent.address;

export class SendDialog {
  init(cx) {
    const p = props() ?? {};
    this.title = String(p.title ?? ""); this.text = String(p.text ?? ""); this.sentKey = p.sent ?? null;
    this.pick = null; this.choosing = false; this.sending = false; this.confirm = false; this.error = null;
    this.handle = cx.focus_handle();
    this.note = TextareaState.new({ placeholder: "A note before the text (optional)…", rows: 2 });
    this.note.set_auto_grow(2, 5);
    // Enter sends; shift-enter is the textarea's own newline.
    this.note.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    this.note.on("change", (_e, cx) => { this.confirm = false; this.error = null; cx.notify(); });
    this.note.focus();
    cx.timer.after(300, () => this.note.focus());
  }

  close() { closeOverlay(props()?.overlay); }

  // The agents of the shown space; the one picked, else the focused one, else an idle one, else the first.
  candidates() {
    const space = focused()?.space;
    return agents().filter((a) => a.space === space);
  }
  target() {
    const list = this.candidates();
    return list.find((a) => a.address === this.pick) ?? list.find((a) => a.focused) ?? list.find((a) => a.status === "idle") ?? list[0] ?? null;
  }

  send(cx) {
    if (this.sending) return;
    const agent = this.target();
    if (!agent) { this.error = "No agent runs in this space. Start one, then send again."; cx.notify(); return; }
    // A blocked agent is answering a question of its own: typing goes into that
    // question, so it takes a second press.
    const blocked = agent.status === "blocked";
    if (blocked && !this.confirm) { this.confirm = true; cx.notify(); return; }
    const message = [this.note.value().trim(), this.text.trim()].filter(Boolean).join("\n\n");
    this.sending = true; this.error = null;
    cx.spawn(async (cx) => {
      const r = await hc(["send", ...(blocked ? ["--force"] : []), agent.address, message]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      this.sending = false;
      if (r.code !== 0) { this.error = (r.stderr || r.stdout).trim().slice(0, 300) || "hc send failed"; this.confirm = false; cx.notify(); return; }
      if (this.sentKey) setShared(this.sentKey, Date.now());
      notify({ title: `Sent to ${nameOf(agent)}`, body: this.title, level: "success" });
      run("agent.focus", { terminal: agent.address });
      this.close();
    });
    cx.notify();
  }

  render(cx) {
    const t = theme(), list = this.candidates(), agent = this.target();
    const dot = (a) => div().size(7).flex_none().rounded(4).bg(t[a.status] ?? t.unknown);
    const button = (id, label, primary, action, disabled) => h_flex().id(id).h(30).px(14).items_center().rounded(8).text_size(12.5).font_medium()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(disabled, (e) => e.opacity(0.5)).when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action)).child(label);
    const agentBox = (a, opens) => h_flex().id("send-to").h(28).px(9).gap(7).items_center().rounded(7).border_1().border_color(this.choosing ? t.accent : t.input).bg(t.raised)
      .when(opens, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .child(dot(a)).child(div().text_size(12).child(`${nameOf(a)} · ${a.tab_name}`)).child(div().text_size(10.5).text_color(t.dim).child(a.status))
      .when(opens, (e) => e.child(svg(`${ICONS}/chevron-down.svg`).size(12).text_color(t.dim)));
    const lines = this.text.split("\n"), shown = lines.slice(0, PREVIEW_LINES);
    const status = this.confirm && agent ? `${nameOf(agent)} is waiting for an answer. Send anyway?`
      : agent ? `Goes to ${nameOf(agent)} as one message · Enter sends` : "Start an agent in this space first";
    return v_flex().id("send-dialog").size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        else if (e.key === "enter" && (e.modifiers?.control || e.modifiers?.platform)) { this.send(cx); cx.stop_propagation(); }
      })
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(15).font_semibold().child("Send to an agent"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(!list.length
        ? div().text_size(12).text_color(t.muted).child("No agent runs in this space.")
        : h_flex().gap(8).items_center()
          .child(div().text_size(11.5).text_color(t.dim).child("To"))
          .child(list.length === 1 ? agentBox(agent, false)
            : Popover.new("send-agents").open(this.choosing).on_open_change((open, cx) => { this.choosing = open; cx.notify(); })
              .trigger(agentBox(agent, true))
              .content(v_flex().mt(4).min_w(260).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md()
                .children(list.map((a) => h_flex().id(`send-to-${a.address}`).h(28).px(8).gap(7).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => { this.pick = a.address; this.confirm = false; this.choosing = false; cx.notify(); })
                  .child(dot(a)).child(div().flex_1().text_size(12).child(`${nameOf(a)} · ${a.tab_name}`)).child(div().text_size(10.5).text_color(t.dim).child(a.status))
                  .child(a.address === agent?.address ? svg(`${ICONS}/check.svg`).size(12).text_color(t.accent) : div().w(12)))))))
      .child(Textarea.new(this.note).w_full().px(10).py(8).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().text_size(11).text_color(t.dim).child(`Sent after your note · ${lines.length} lines`))
      .child(div().id("send-text-x").flex_1().min_h(80).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_x_scrollbar()
        .child(v_flex().id("send-text").h_full().overflow_y_scrollbar().p(8).font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted).whitespace_nowrap()
          .children(shown.map((l) => div().h(16).flex_none().child(l || " ")))
          .when(lines.length > shown.length, (e) => e.child(div().text_color(t.dim).child(`… and ${lines.length - shown.length} more lines`)))))
      .when(this.text.length > LONG, (e) => e.child(div().text_size(11).text_color(t.blocked).whitespace_normal()
        .child(`This is ${Math.round(this.text.length / 1024)} KB pasted into the agent's terminal; some agents are slow with that much, or cut it short. Sending fewer threads at a time avoids it.`)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(11.5).text_color(t.ansi1).whitespace_normal().child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(this.confirm ? t.blocked : t.dim).child(status))
        .child(button("send-cancel", "Cancel", false, () => this.close(), false))
        .child(button("send-go", this.sending ? "Sending…" : this.confirm ? "Send anyway" : "Send", true, (_e, cx) => this.send(cx), this.sending || !agent)));
  }
}
