import { useState } from "react";
import { btn } from "./ui";

export function ApiKeySetup({
  onSave,
  onUseLocal,
}: {
  onSave: (key: string) => void;
  /** Skip the key and build with a model running on this machine instead. */
  onUseLocal: () => void;
}) {
  const [value, setValue] = useState("");
  const valid = value.trim().startsWith("sk-ant-");

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your Anthropic API key</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        The agent runs inside this extension and talks to the Anthropic API directly. Your key
        is stored in <code>chrome.storage.local</code> on this machine and is never sent
        anywhere else.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sk-ant-..."
        style={{
          width: "100%",
          padding: 12,
          fontSize: 14,
          borderRadius: 4,
          border: "1px solid #ddd",
          fontFamily: "ui-monospace, monospace",
        }}
      />
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid}
        onClick={() => onSave(value.trim())}
      >
        Save key
      </button>
      <p style={{ color: "#555", lineHeight: 1.6, marginTop: 32 }}>
        Rather keep everything on this machine?{" "}
        <button
          onClick={onUseLocal}
          style={{ background: "none", border: "none", padding: 0, color: "#06c", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
        >
          Use a local model instead
        </button>{" "}
        (Ollama, LM Studio, or any OpenAI-compatible server).
      </p>
    </div>
  );
}
