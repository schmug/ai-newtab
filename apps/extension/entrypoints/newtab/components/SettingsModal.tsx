import { useState } from "react";
import {
  DEFAULT_LOCAL_BASE_URL,
  MODEL_CHOICES,
  PROVIDER_CHOICES,
  listLocalModels,
  normalizeBaseUrl,
  normalizeBlockList,
  type HomepageModel,
  type ProviderId,
} from "@homepage/agent-core";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { btn } from "./ui";

export function SettingsModal({
  initialPrompt,
  blockedSites,
  model,
  onChangeModel,
  provider,
  onChangeProvider,
  hasApiKey,
  localBaseUrl,
  onChangeLocalBaseUrl,
  localModel,
  onChangeLocalModel,
  autoRebuild,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void;
  provider: ProviderId;
  onChangeProvider: (next: ProviderId) => void;
  /** Switching back to the API without a key lands on the key-setup screen. */
  hasApiKey: boolean;
  localBaseUrl: string;
  onChangeLocalBaseUrl: (next: string) => void;
  localModel: string | null;
  onChangeLocalModel: (next: string | null) => void;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[]) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [urlDraft, setUrlDraft] = useState(localBaseUrl);
  const [localModels, setLocalModels] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const commitUrl = () => {
    const next = normalizeBaseUrl(urlDraft) || DEFAULT_LOCAL_BASE_URL;
    setUrlDraft(next);
    if (next !== localBaseUrl) onChangeLocalBaseUrl(next);
  };

  const checkConnection = async () => {
    commitUrl();
    setChecking(true);
    setCheckError(null);
    try {
      const models = await listLocalModels(normalizeBaseUrl(urlDraft) || DEFAULT_LOCAL_BASE_URL);
      setLocalModels(models);
      if (models.length === 0) setCheckError("Connected, but the server has no models. Pull or load one first.");
      // Pick the first model if none is chosen yet, so a build can start right away.
      else if (!localModel || !models.includes(localModel)) onChangeLocalModel(models[0]);
    } catch (err) {
      setLocalModels(null);
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Sites the agent never reads
          <textarea
            value={blockedDraft}
            onChange={(e) => setBlockedDraft(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 120, marginTop: 8, padding: 12, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="blocked-sites-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One per line. Subdomains are included. Use *.example.com for wildcards.
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}>
          Engine
          <select
            value={provider}
            onChange={(e) => onChangeProvider(e.target.value as ProviderId)}
            style={select}
          >
            {PROVIDER_CHOICES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {provider === "anthropic" ? (
          <>
            <label style={{ ...indented, marginTop: 10 }}>
              Model
              <select value={model} onChange={(e) => onChangeModel(e.target.value as HomepageModel)} style={select}>
                {MODEL_CHOICES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {!hasApiKey && (
              <p style={help}>You&apos;ll be asked for your Anthropic API key when you close Settings.</p>
            )}
          </>
        ) : (
          <>
            <label style={{ ...indented, marginTop: 10 }}>
              Server
              <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={commitUrl}
                placeholder={DEFAULT_LOCAL_BASE_URL}
                spellCheck={false}
                style={{ ...select, flex: 1, fontFamily: "ui-monospace, monospace" }}
              />
              <button
                onClick={checkConnection}
                disabled={checking}
                style={{ ...btn, padding: "4px 10px", fontSize: 13, opacity: checking ? 0.6 : 1 }}
              >
                {checking ? "Checking…" : "Check connection"}
              </button>
            </label>
            <label style={{ ...indented, marginTop: 10 }}>
              Model
              {localModels && localModels.length > 0 ? (
                <select value={localModel ?? ""} onChange={(e) => onChangeLocalModel(e.target.value)} style={select}>
                  {localModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={localModel ?? ""}
                  onChange={(e) => onChangeLocalModel(e.target.value.trim() || null)}
                  placeholder="Check connection to list models"
                  spellCheck={false}
                  style={{ ...select, flex: 1, fontFamily: "ui-monospace, monospace" }}
                />
              )}
            </label>
            {checkError && <p style={{ ...help, color: "#a02620" }}>{checkError}</p>}
            <p style={help}>
              Any OpenAI-compatible server works: Ollama (default above) or LM Studio
              (http://localhost:1234/v1). Your history and pages stay on this machine.
            </p>
          </>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          Every
          <select
            value={intervalHours}
            disabled={!autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {REBUILD_INTERVAL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h === 24 ? "24 hours (daily)" : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background once your homepage is this old, so
          your next tab shows a fresh one.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button onClick={() => onSave(draft, normalizeBlockList(blockedDraft.split("\n")))} style={btn}>
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}

const select = { padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" } as const;
const indented = { display: "flex", alignItems: "center", gap: 8, marginLeft: 24, color: "#333", fontSize: 14 } as const;
const help = { color: "#888", fontSize: 12, margin: "6px 0 0 24px" } as const;
