import { ArrowUp, BookOpen, Captions, EyeOff, Film, Gauge, History, LayoutPanelLeft, Mic, MousePointerClick, MessageSquare, RotateCcw, Scissors, Square, Terminal, Type, User, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/backend";
import { timecode, type Word } from "../lib/edl";

const LAYOUT_LABELS: Record<string, string> = { camera: "camera only", screen: "screen only", side: "side by side" };

interface Props {
  messages: ChatMessage[];
  running: boolean;
  words: Word[];
  onSend: (text: string) => void;
  onStop: () => void;
  onSeekWord: (i: number) => void;
}

const SUGGESTIONS = ["Tighten the opening", "Zoom in on the key moments", "Turn on bold captions"];

/** What Claude did with a tool, in a line. */
function Action({ m, words, onSeekWord }: { m: ChatMessage; words: Word[]; onSeekWord: (i: number) => void }) {
  const from = Number(m.input?.from);
  const to = Number(m.input?.to);
  const span = Number.isInteger(from) && Number.isInteger(to) ? words.slice(from, to + 1).map((w) => w.text).join(" ") : "";
  if (m.tool === "get_edit")
    return (
      <div className="action quiet">
        <BookOpen size={13} /> Read the edit
      </div>
    );
  if (m.tool === "add_clip")
    return (
      <div className="action">
        <Film size={13} />
        <span className="what">
          Made a new clip <span className="why">· {m.input?.reason ?? ""}</span>
        </span>
        <span className="mono">{timecode(Number(m.input?.start) || 0)}</span>
      </div>
    );
  if (m.tool === "remove_clip")
    return (
      <div className="action quiet">
        <Film size={13} /> Took out its clip at {timecode(Number(m.input?.start) || 0)}
      </div>
    );
  if (m.tool === "add_text")
    return (
      <div className="action" onClick={() => Number.isInteger(from) && onSeekWord(from)}>
        <Type size={13} />
        <span className="what">
          Added text "{String(m.input?.text ?? "")}" <span className="why">· {m.input?.reason ?? ""}</span>
        </span>
      </div>
    );
  if (m.tool === "remove_text")
    return (
      <div className="action quiet">
        <Type size={13} /> Took its text off {span ? `"${span}"` : ""}
      </div>
    );
  if (m.tool === "resolve_note")
    return (
      <div className="action quiet">
        <MessageSquare size={13} /> Dealt with note {String(m.input?.note ?? "")}: {String(m.input?.reply ?? "")}
      </div>
    );
  if (m.tool === "add_note")
    return (
      <div className="action" onClick={() => Number.isInteger(Number(m.input?.at)) && onSeekWord(Number(m.input?.at))}>
        <MessageSquare size={13} />
        <span className="what">Left you a note: {String(m.input?.text ?? "")}</span>
      </div>
    );
  if (m.tool === "speed_up" || m.tool === "blur")
    return (
      <div className="action" onClick={() => Number.isInteger(from) && onSeekWord(from)}>
        {m.tool === "blur" ? <EyeOff size={13} /> : <Gauge size={13} />}
        <span className="what">
          {m.tool === "blur" ? "Blurred" : `Sped up ${Number(m.input?.rate) || ""}x`} "{span}" <span className="why">· {m.input?.reason ?? ""}</span>
        </span>
      </div>
    );
  if (m.tool === "swap_background")
    return (
      <div className="action" onClick={() => Number.isInteger(from) && onSeekWord(from)}>
        <User size={13} />
        <span className="what">
          Swapped the background on "{span}" <span className="why">· {m.input?.reason ?? ""}</span>
        </span>
      </div>
    );
  if (m.tool === "set_layout")
    return (
      <div className="action" onClick={() => Number.isInteger(from) && onSeekWord(from)}>
        <LayoutPanelLeft size={13} />
        <span className="what">
          Changed the layout to {LAYOUT_LABELS[String(m.input?.mode)] ?? String(m.input?.mode ?? "")} on "{span}" <span className="why">· {m.input?.reason ?? ""}</span>
        </span>
      </div>
    );
  if (m.tool === "save_version" || m.tool === "open_version")
    return (
      <div className="action quiet">
        <History size={13} /> {m.tool === "save_version" ? "Saved version" : "Opened version"} "{String(m.input?.name ?? "")}"
      </div>
    );
  if (m.tool === "cut_retakes")
    return (
      <div className="action quiet">
        <Scissors size={13} /> Cut the takes you marked
      </div>
    );
  if (m.tool === "zoom_to_clicks")
    return (
      <div className="action quiet">
        <MousePointerClick size={13} /> Zoomed in where you clicked
      </div>
    );
  if (m.tool === "remove_effect")
    return (
      <div className="action quiet">
        {m.input?.kind === "blur" ? <EyeOff size={13} /> : <Gauge size={13} />} Took off its {m.input?.kind === "blur" ? "blur" : "speed-up"} on "{span}"
      </div>
    );
  if (m.tool === "set_voice")
    return (
      <div className="action quiet">
        <Mic size={13} /> {m.input?.polish ? "Voice polished on export" : "Voice as recorded"}
      </div>
    );
  if (m.tool === "add_rule")
    return (
      <div className="action quiet">
        <BookOpen size={13} /> Saved a rule: {String(m.input?.text ?? "")}
      </div>
    );
  if (m.tool === "Bash" || m.tool === "Write" || m.tool === "Read") {
    const cmd = String(m.input?.command ?? m.input?.file_path ?? "").trim();
    const what = m.tool === "Bash" ? `Ran ${cmd.split(/\s+/)[0] || "a command"}` : m.tool === "Write" ? "Wrote a file" : "Read a file";
    return (
      <div className="action quiet" title={cmd}>
        <Terminal size={13} /> {what}
      </div>
    );
  }
  if (m.tool === "set_captions")
    return (
      <div className="action quiet">
        <Captions size={13} /> {m.input?.on === false ? "Captions off" : `Captions on (${m.input?.style === "clean" ? "clean" : "bold"})`}
      </div>
    );
  const [Icon, label] =
    m.tool === "cut_words"
      ? [Scissors, "Cut"]
      : m.tool === "zoom_in"
        ? [ZoomIn, "Zoom in on"]
        : m.tool === "remove_zoom"
          ? [ZoomOut, "Unzoom"]
          : m.tool === "restore_words"
            ? [RotateCcw, "Put back"]
            : [BookOpen, m.tool ?? "Used a tool"];
  return (
    <button className="action" onClick={() => words[from] && onSeekWord(from)} title="Show this in the video">
      <Icon size={13} />
      <span className="what">
        {label} <span className="words">{span}</span>
        {m.input?.reason && <span className="why"> · {m.input.reason}</span>}
      </span>
      {words[from] && <span className="mono">{timecode(words[from].start)}</span>}
    </button>
  );
}

export function Chat(p: Props) {
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [p.messages.length, p.running]);

  const send = (t = text) => {
    const v = t.trim();
    if (!v || p.running) return;
    p.onSend(v);
    setText("");
  };

  return (
    <div className="chat">
      <div className="panel-body" ref={box}>
        {p.messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask Claude to change the edit. It sees the transcript and what's been cut, and its changes show in blue for you to keep or restore.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {p.messages.map((m, i) =>
          m.role === "action" ? (
            <Action key={i} m={m} words={p.words} onSeekWord={p.onSeekWord} />
          ) : (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ),
        )}
        {p.running && (
          <div className="msg claude working">
            <span className="pulse" /> Working
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder="Ask Claude to change the edit…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing a space shouldn't play the video
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {p.running ? (
          <button className="btn icon" title="Stop" onClick={p.onStop}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className="btn icon primary" title="Send (Return)" disabled={!text.trim()} onClick={() => send()}>
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
