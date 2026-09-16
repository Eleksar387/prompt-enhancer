// Prompt Enhancer Bridge — drop a Scriptwriter export .zip, review the
// patched prompt/reference mapping for every clip, then Run to queue them
// all as separate ComfyUI executions of your own currently-loaded workflow.
//
// Deliberately framework-free (plain DOM) and defensive about ComfyUI's own
// internals — `app`/`api` are the two stable, public entry points this
// relies on; everything else here is our own markup.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PROMPT_NODE, IMAGE_NODE, DURATION_NODE, countImageSlots, hasPromptNode, hasDurationNode, patchForClip } from "./patch.js";

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children || []) node.append(c);
  return node;
}

// --- drag-to-reposition ------------------------------------------------------
//
// Both the button and the review panel are `position: fixed` at a guessed
// spot — which on at least one real ComfyUI theme landed right on top of the
// native Queue/Run button, blocking it entirely. Rather than guess a better
// fixed spot (any fixed spot can collide with some theme/resolution), make
// both draggable and remember wherever the user actually puts them.

function loadPos(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function savePos(key, pos) {
  try { localStorage.setItem(key, JSON.stringify(pos)); } catch {}
}

// Makes `el` draggable by mouse, dragging via `handle` (defaults to `el`
// itself). Position persists in localStorage under `key` and is restored on
// the next load/setup. Returns `wasDragged()` — true only in the brief
// window right after a real drag — so a caller whose handle also has its own
// click behavior (the button's "open file picker", the panel header's
// "collapse/expand") can skip that click instead of firing it right after a
// drag release (a native click still fires on mouseup over the same element
// even after real pointer movement in between).
function makeDraggable(el, handle, key) {
  handle = handle || el;
  const saved = loadPos(key);
  if (saved) {
    el.style.left = saved.left + "px";
    el.style.top = saved.top + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
  }
  handle.style.cursor = "move";
  let dragging = false, moved = false, startX, startY, startLeft, startTop, suppressUntil = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    const r = el.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; startLeft = r.left; startTop = r.top;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    moved = true;
    const left = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, startLeft + dx));
    const top = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop + dy));
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const r = el.getBoundingClientRect();
      savePos(key, { left: r.left, top: r.top });
      suppressUntil = Date.now() + 50; // covers the click event that fires right after this mouseup
    }
  });
  return { wasDragged: () => Date.now() < suppressUntil };
}

// --- networking --------------------------------------------------------------

async function uploadZip(file) {
  const res = await fetch("/prompt_enhancer/run_film", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data; // { runId, manifest }
}

async function pollHistory(promptId, { intervalMs = 2000, timeoutMs = 600000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`/history/${promptId}`);
    if (res.ok) {
      const hist = await res.json();
      const run = hist[promptId];
      if (run) {
        const status = run.status?.status_str;
        if (status === "success") return { ok: true };
        if (status === "error") return { ok: false, error: "ComfyUI reported an error — check its console." };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, error: "Timed out waiting for this clip." };
}

// --- UI ------------------------------------------------------------------

function buildReviewPanel(manifest, promptOutput, workflow, onClose) {
  // Docked to a corner, NOT a full-screen modal with a dark backdrop — a
  // modal blocked the whole canvas, including any preview node's live output
  // while clips were actually rendering, which defeats a big part of the
  // point of watching a run. This never covers the canvas at all, and a
  // minimize toggle shrinks it to a thin strip for while a run is going.
  document.getElementById("pe-bridge-panel")?.remove();
  const panel = el("div", {
    id: "pe-bridge-panel",
    style: {
      position: "fixed", top: "50px", right: "8px", zIndex: "9998",
      background: "#1e1e1e", color: "#ddd", width: "360px", maxHeight: "calc(100vh - 70px)",
      overflow: "auto", borderRadius: "8px", padding: "12px", fontFamily: "system-ui, sans-serif", fontSize: "13px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.5)", border: "1px solid #444",
    },
  });
  const body = el("div", {}, []);

  const slots = countImageSlots(promptOutput);
  const maxNeeded = Math.max(0, ...manifest.clips.map((c) => c.references.length));
  const promptOk = hasPromptNode(promptOutput);

  const minBtn = el("span", { title: "Minimize / expand" }, [document.createTextNode("▁")]);
  // Stays visible even while `body` is minimized, so a glance at the header
  // is enough to see progress without re-opening the panel over the canvas.
  const headerStatus = el("span", { style: { fontSize: "11px", color: "#8ab" } }, []);
  const header = el("div", {
    title: "Drag to move, click to collapse/expand",
    style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", gap: "8px" },
    onclick: () => {
      if (panelDrag.wasDragged()) return; // this click is the tail end of a drag, not a real click
      body.hidden = !body.hidden;
      minBtn.textContent = body.hidden ? "▢" : "▁";
    },
  }, [
    el("h3", { style: { margin: "0", fontSize: "13px" } }, [
      document.createTextNode(`📦 ${manifest.title || "Untitled"} — ${manifest.clips.length} clip(s)`),
    ]),
    headerStatus,
    minBtn,
  ]);
  panel.append(header, body);
  const panelDrag = makeDraggable(panel, header, "pe-bridge-panel-pos");

  const problems = [];
  if (!promptOk) problems.push(`Your loaded workflow has no ${PROMPT_NODE} node — add one before running.`);
  if (maxNeeded > slots) {
    problems.push(
      `A clip needs ${maxNeeded} reference image(s), but your loaded workflow only has ${slots} ${IMAGE_NODE} node(s) (by highest index+1). Add more, or this clip's extra references will be skipped.`
    );
  }
  if (problems.length) {
    body.append(el("div", {
      style: { background: "#4a2a2a", border: "1px solid #a55", borderRadius: "6px", padding: "8px", marginBottom: "12px" },
    }, problems.map((p) => el("div", {}, [document.createTextNode("⚠ " + p)]))));
  }

  // Non-blocking, distinct from `problems` above: a missing PEClipDuration
  // node doesn't stop anything from running, it just means every clip
  // renders at whatever fixed length the template already had — worth
  // knowing before a run, not worth refusing to run over.
  if (!hasDurationNode(promptOutput)) {
    body.append(el("div", {
      style: { background: "#3a3a2a", border: "1px solid #aa5", borderRadius: "6px", padding: "8px", marginBottom: "12px" },
    }, [document.createTextNode(
      `ℹ No ${DURATION_NODE} node found — every clip will use your template's fixed duration, not its own authored length. Add one and wire it into whatever controls clip length if you want per-clip durations.`
    )]));
  }

  const list = el("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
  manifest.clips.forEach((clip) => {
    const refLine = clip.references.length
      ? clip.references.map((r, i) => `#${i}: ${r.file.split("/").pop()}`).join("  ·  ")
      : "(no references — T2VA)";
    const preview = (clip.promptText || "").slice(0, 220).replace(/\s+/g, " ");
    list.append(el("div", {
      style: { border: "1px solid #444", borderRadius: "6px", padding: "8px" },
    }, [
      el("div", { style: { fontWeight: "bold" } }, [document.createTextNode(
        `Clip ${clip.clipNumber} — ${clip.sceneTitle || ""} · ${clip.mode} · ${clip.durationSec}s`
      )]),
      el("div", { style: { color: "#aaa", margin: "4px 0" } }, [document.createTextNode(refLine)]),
      el("div", { style: { color: "#ccc", fontStyle: "italic" } }, [document.createTextNode(preview + "…")]),
      el("div", { class: "pe-status", style: { marginTop: "4px", color: "#7ab" } }, []),
    ]));
  });
  body.append(list);

  const status = el("div", { style: { marginTop: "12px", minHeight: "18px" } }, []);
  const runBtn = el("button", {
    style: { marginTop: "12px", marginRight: "8px", padding: "6px 14px" },
    // Only a missing PEClipPrompt node is a hard blocker — a too-small
    // PEClipImage count is a per-clip warning (that clip's extra references
    // get skipped, everything else still runs), not a reason to block all of it.
    disabled: !promptOk,
  }, [document.createTextNode("▶ Run all clips")]);
  const closeBtn = el("button", { style: { marginTop: "12px", padding: "6px 14px" }, onclick: () => { panel.remove(); onClose?.(); } }, [
    document.createTextNode("Close"),
  ]);

  runBtn.addEventListener("click", async () => {
    runBtn.setAttribute("disabled", "true");
    // Auto-minimize once a run starts — this is the actual point of the
    // panel-not-modal change: leave the canvas (and any preview node) fully
    // visible for watching the run, not just clickable underneath.
    body.hidden = true;
    minBtn.textContent = "▢";
    const rows = list.querySelectorAll(".pe-status");
    for (let i = 0; i < manifest.clips.length; i++) {
      const clip = manifest.clips[i];
      const row = rows[i];
      headerStatus.textContent = `clip ${i + 1}/${manifest.clips.length} — queuing…`;
      row.textContent = "queuing…";
      try {
        const patched = patchForClip(promptOutput, clip);
        // `workflow` is the real captured graph (unpatched — recovering it
        // from a finished clip shows the template's placeholder text/paths,
        // not this specific clip's), not {}: an empty workflow object would
        // still render fine but strips this run's provenance from ComfyUI's
        // own history and breaks "drag the output back in to recover the graph".
        const resp = await api.queuePrompt(0, { output: patched, workflow });
        const promptId = resp?.prompt_id;
        if (!promptId) throw new Error("ComfyUI didn't return a prompt_id.");
        row.textContent = `queued (${promptId.slice(0, 8)}…) — rendering…`;
        headerStatus.textContent = `clip ${i + 1}/${manifest.clips.length} — rendering…`;
        const result = await pollHistory(promptId);
        row.textContent = result.ok ? "✓ done" : `✗ ${result.error}`;
        row.style.color = result.ok ? "#8c8" : "#c88";
      } catch (e) {
        row.textContent = `✗ ${e.message || e}`;
        row.style.color = "#c88";
      }
    }
    status.textContent = "All clips submitted.";
    headerStatus.textContent = "✓ all submitted";
  });

  body.append(runBtn, closeBtn, status);
  document.body.append(panel);
}

async function handleZipFile(file) {
  let data;
  try {
    data = await uploadZip(file);
  } catch (e) {
    alert(`Prompt Enhancer Bridge: couldn't stage that zip.\n\n${e.message || e}`);
    return;
  }
  let promptOutput, workflow;
  try {
    const g = await app.graphToPrompt();
    promptOutput = g.output;
    workflow = g.workflow;
  } catch (e) {
    alert(`Prompt Enhancer Bridge: couldn't read the currently loaded workflow.\n\n${e.message || e}`);
    return;
  }
  buildReviewPanel(data.manifest, promptOutput, workflow);
}

app.registerExtension({
  name: "PromptEnhancer.Bridge",
  async setup() {
    const input = el("input", { type: "file", accept: ".zip", style: { display: "none" } });
    input.addEventListener("change", () => {
      if (input.files[0]) handleZipFile(input.files[0]);
      input.value = "";
    });
    document.body.append(input);

    const button = el("button", {
      id: "pe-bridge-button",
      title: "Load a Prompt Enhancer Scriptwriter export .zip — drag to move",
      style: {
        position: "fixed", top: "8px", right: "180px", zIndex: "9999",
        padding: "6px 10px", borderRadius: "6px",
      },
    }, [document.createTextNode("📦 Load Film")]);
    document.body.append(button);
    const buttonDrag = makeDraggable(button, button, "pe-bridge-btn-pos");
    button.addEventListener("click", () => {
      if (buttonDrag.wasDragged()) return; // tail end of a drag, not a real click
      input.click();
    });

    // Also accept a direct drag-and-drop of the .zip anywhere on the page,
    // mirroring how ComfyUI already accepts a workflow-bearing PNG dropped
    // on the canvas.
    document.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === "file")) e.preventDefault();
    });
    document.addEventListener("drop", (e) => {
      const file = [...(e.dataTransfer?.files || [])].find((f) => f.name.endsWith(".zip"));
      if (!file) return;
      e.preventDefault();
      handleZipFile(file);
    });
  },
});
