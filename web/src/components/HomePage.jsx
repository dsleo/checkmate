import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function HomePage({
  fileError,
  files,
  selectedFile,
  isReviewing,
  progress,
  status,
  preflight,
  logs,
  math,
  macroText,
  macroFileName,
  handleFileSelection,
  loadSelectedFile,
  startReview
}) {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const onClick = (event) => {
      if (!event.target.closest(".picker-wrap")) {
        setPickerOpen(false);
      }
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  const agentList =
    preflight?.paperType === "ml"
      ? ["Structural", "Notation", "Rhetoric", "Science", "Critical"]
      : ["Structural", "Notation", "Rhetoric", "Critical"];

  const handleSelectionAndReview = async (fileList) => {
    const result = await handleFileSelection(fileList);
    if (!result?.text) return;
    setHasStarted(true);
    startReview({
      overrideLatex: result.text,
      overrideMacroText: result.macroText ?? macroText,
      onFirst: () => navigate("/review"),
      onFinal: () => {}
    });
  };

  return (
    <div className="home-shell">
      <div className="home-hero">
        <p className="eyebrow">Academic Reviewer App</p>
        <h1>Stress-test your LaTeX with multi-agent peer review.</h1>
        <p className="lead">
          Upload a LaTeX file, run the review, and receive structured feedback with
          actionable fixes.
        </p>
      </div>

      <div className="home-cta">
        <div className="picker-wrap">
          <button
            className="primary split-main"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            Review Your Paper
          </button>
          <button
            type="button"
            className={`split-toggle ${pickerOpen ? "open" : ""}`}
            onClick={() => setPickerOpen((prev) => !prev)}
            aria-label="Choose file or folder"
          >
            ▾
          </button>
          {pickerOpen && (
            <div className="picker-dropdown">
              <button
                type="button"
                onClick={() => {
                  setPickerOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                Select file
              </button>
              <button
                type="button"
                onClick={() => {
                  setPickerOpen(false);
                  dirInputRef.current?.click();
                }}
              >
                Select folder
              </button>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tex"
          onChange={(e) => handleSelectionAndReview(e.target.files)}
          hidden
        />
        <input
          ref={dirInputRef}
          type="file"
          accept=".tex"
          webkitdirectory="true"
          directory="true"
          multiple
          onChange={(e) => handleSelectionAndReview(e.target.files)}
          hidden
        />
        {files.length > 0 && (
          <select
            className="file-select"
            value={selectedFile}
            onChange={(e) => loadSelectedFile(e.target.value)}
          >
            {files.map((file) => (
              <option key={file.name} value={file.name}>
                {file.webkitRelativePath || file.name}
              </option>
            ))}
          </select>
        )}
        {macroText && macroFileName && (
          <p className="muted">Loaded macros from {macroFileName}.</p>
        )}
        {fileError && <p className="error">{fileError}</p>}

        {(isReviewing || hasStarted) && (
          <div className="processing-panel">
            <div className="processing-line">
              <h3>Processing</h3>
              {preflight?.paperType && (
                <span className="muted processing-note">
                  {preflight.paperType === "ml"
                    ? "This looks like a Machine Learning paper."
                    : preflight.paperType === "math"
                      ? "This looks like a Mathematics paper."
                      : "This looks like a Computer Science paper."}
                </span>
              )}
            </div>
            {math?.status === "processing" && (
              <span className="status-pill success">Math agent running</span>
            )}
            <div className="progress">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="status-list">
              {agentList.map((name) => (
                <div key={name} className="status-item">
                  <span>{name}</span>
                  <span>
                    {status[name]?.status === "processing" ? (
                      <span className="status-processing">
                        {status[name]?.detail?.message
                          ? status[name].detail.message
                          : "processing"}{" "}
                        <span className="dots">...</span>
                      </span>
                    ) : status[name]?.status === "completed" ? (
                      "done"
                    ) : (
                      status[name]?.status || "idle"
                    )}
                  </span>
                </div>
              ))}
              {preflight?.paperType === "math" &&
                math?.status &&
                math.status !== "skipped" && (
                  <div className="status-item">
                    <span>Proof Review</span>
                    <span>
                      {math.status === "processing" ? (
                        <span className="status-processing">
                          {`processing ${math.completed || 0}/${math.total || 0}`}{" "}
                          <span className="dots">...</span>
                        </span>
                      ) : (
                        math.status || "idle"
                      )}
                    </span>
                  </div>
                )}
            </div>
            {status.Structural?.error && (
              <p className="error">Structural error: {status.Structural.error}</p>
            )}
            {logs.length > 0 && (
              <div className="log-panel">
                <div className="log-title">Live log</div>
                <div className="log-body">
                  {logs.map((entry, idx) => (
                    <div key={`${entry.ts}-${idx}`} className="log-line">
                      <span className="log-time">{entry.ts.slice(11, 19)}</span>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
