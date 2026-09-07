import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, ConfigProvider, Upload, theme as antdTheme } from "antd";
import type { UploadProps } from "antd";
import type { ChangeEvent, DragEvent } from "react";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { uiToEngineLocale } from "./demo/locales";
import { useEpubcheck } from "../worker/useEpubcheck";
import type { ValidationResult } from "../worker/types";
import { formatConsoleReport } from "../worker/vendor";
import {
  ACCEPT,
  DEFAULT_LOCALE,
  DEFAULT_VERSION,
  modeForFile,
} from "./demo/constants";
import { VERDICT, verdictDetail, type RunKind } from "./demo/verdict";
import {
  gatherFromDroppedDirectory,
  gatherFromWebkitDirectory,
  type GatheredDirectory,
} from "./demo/directory";
import { toRow, type Row } from "./demo/table";
import {
  downloadText,
  type PreparedReport,
  type ReportFormat,
} from "./demo/reports";
import { Header } from "./demo/Header";
import { FeatureGrid } from "./demo/FeatureGrid";
import { InputCard } from "./demo/InputCard";
import { ResultsCard } from "./demo/ResultsCard";
import { Footer } from "./demo/Footer";

// Outer shell: establishes the antd theme so the body can read theme tokens
// (via useToken) — the verdict colours are mirrored from the same live tokens
// the severity tags use, which only exist inside this ConfigProvider.
export default function EpubcheckDemo() {
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: {
          // antd's default secondary/description text (45% black) reads too
          // faded on this page; darken all of it together to 70% black.
          colorTextDescription: "rgba(0, 0, 0, 0.70)",
        },
      }}
    >
      <App>
        <DemoBody />
      </App>
    </ConfigProvider>
  );
}

function DemoBody() {
  const { token } = antdTheme.useToken();
  // Themed notification API (inside <App>), so the completion popup picks up the
  // ConfigProvider theme instead of antd's context-less static message warning.
  const { notification } = App.useApp();
  // The severity-tag text colour per hue lives on the theme token as
  // `<family>7` (antd genPresetColor). Index the live token the same way.
  const tokenColors = token as unknown as Record<string, string>;
  const {
    status,
    initializing,
    cancel,
    reportError,
    result,
    error,
    liveMessages,
    validate,
    validateUrl,
    validateDirectory,
  } = useEpubcheck();
  // Hidden <input webkitdirectory> the "Select folder" button drives. The
  // directory attributes are non-standard, so they are set imperatively (React
  // has no typed props for them) once the element mounts.
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Hidden <input type="file"> the "Select EPUB file" button drives, carrying
  // the same accept list as the dropzone so standalone files still work.
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);
  // Raw-output word-wrap. Default OFF: each line is preserved and scrolls
  // sideways; ON soft-wraps long epubcheck lines. Not persisted.
  const [wrapRawOutput, setWrapRawOutput] = useState(false);
  const validating = status === "validating";

  // Options-row state. Every default here (Default profile, usage off) builds an
  // empty args array, so a default English run is byte-identical to today.
  const [profile, setProfile] = useState<string>("DEFAULT");
  // Engine message-locale, seeded from the active UI locale so choosing a UI
  // language also preselects the matching engine language when one exists
  // (ko -> ko-KR, en -> the engine default, everything else 1:1); the user can
  // still override this select afterwards. A UI-language switch reloads the page
  // (Paraglide's default setLocale behavior), so this initializer re-runs with
  // the newly stored locale. With no stored locale it resolves to the English
  // default, keeping the default run unchanged.
  const [locale, setLocale] = useState<string>(
    () => uiToEngineLocale(getLocale()) ?? DEFAULT_LOCALE,
  );
  const [showUsage, setShowUsage] = useState(false);
  const [version, setVersion] = useState<string>(DEFAULT_VERSION);
  // Optional EPUBCheck message-override text (Advanced options), edited in a
  // textarea and/or loaded from a file. Empty/whitespace = none; when it has
  // content it rides along with every kind of run (file, folder, sample, URL)
  // as the library's customMessages string.
  const [customMessages, setCustomMessages] = useState("");
  // Trimmed override text, or undefined when blank — the exact value the run
  // helpers forward to validate()/validateUrl()/validateDirectory().
  const customMessagesArg = customMessages.trim() ? customMessages : undefined;
  // The http(s) URL typed into the input row. Empty = nothing to validate.
  const [url, setUrl] = useState("");

  // The static HTML ships html lang="en" because the build is a single baseLocale
  // (English) render. Reflect the client-side active UI locale on the document
  // element so browsers and assistive tech see the language actually shown after
  // a stored-locale load or a switch. og:locale stays en_US in the static <head>:
  // this is a fully client-switched static page with no per-locale URL, so social
  // and SEO crawlers read the served English HTML (an accepted limitation noted in
  // index.astro); there is no non-hacky way to vary a static meta tag per client.
  useEffect(() => {
    document.documentElement.lang = getLocale();
  }, []);

  // Assemble the epubcheck CLI argument list from the options plus the picked
  // file's --mode, in the same order the CLI package's buildEngineArgs uses:
  // -u, then --mode with -v, then --profile, then --locale.
  const buildArgs = useCallback(
    (mode: string | null): string[] => {
      const args: string[] = [];
      if (showUsage) args.push("-u");
      if (mode !== null) args.push("--mode", mode, "-v", version);
      if (profile !== "DEFAULT") args.push("--profile", profile.toLowerCase());
      if (locale !== DEFAULT_LOCALE) args.push("--locale", locale);
      return args;
    },
    [showUsage, version, profile, locale],
  );

  const run = useCallback(
    async (file: File) => {
      try {
        await validate(
          file,
          buildArgs(modeForFile(file.name)),
          customMessagesArg,
        );
      } catch {
        /* surfaced via `error` */
      }
    },
    [validate, buildArgs, customMessagesArg],
  );

  // Validate the typed http(s) URL as a whole EPUB container (no single-file
  // --mode/-v, so buildArgs(null)). The worker/library performs the download.
  const runUrl = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      await validateUrl(trimmed, buildArgs(null), customMessagesArg);
    } catch {
      /* surfaced via `error` */
    }
  }, [url, validateUrl, buildArgs, customMessagesArg]);

  const runSample = useCallback(
    async (name: string) => {
      const base = import.meta.env.BASE_URL.endsWith("/")
        ? import.meta.env.BASE_URL
        : `${import.meta.env.BASE_URL}/`;
      let blob: Blob;
      try {
        const resp = await fetch(`${base}fixtures/${name}`);
        // Without this check a 404/HTML error page would be blob'd and validated
        // as EPUB bytes, surfacing as a misleading "invalid" verdict. Surface it
        // as a proper load error instead (a network throw lands in the catch).
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        blob = await resp.blob();
      } catch {
        reportError(m.sample_load_failed());
        return;
      }
      await run(new File([blob], name, { type: "application/epub+zip" }));
    },
    [run, reportError],
  );

  // Validate a gathered expanded-EPUB folder. The version select is a
  // single-file-only control, so a directory run passes buildArgs(null) (no
  // --mode/-v); the library validates a directory source in place by default
  // (dirMode 'direct', locations under the folder name).
  // Profile/locale/usage still pass through unchanged.
  const runFolder = useCallback(
    async (gathered: GatheredDirectory) => {
      if (gathered.files.length === 0) return;
      try {
        await validateDirectory(
          gathered.files,
          gathered.paths,
          gathered.folderName,
          buildArgs(null),
          customMessagesArg,
        );
      } catch {
        /* surfaced via `error` */
      }
    },
    [validateDirectory, buildArgs, customMessagesArg],
  );

  // Native drop on the dropzone. A SINGLE dropped directory validates as one
  // expanded EPUB (walked here via webkitGetAsEntry, which works in Chrome,
  // Firefox, and Safari); everything else — single files, multi-item drops —
  // falls through to antd's own file handling (its accept filter ignores the
  // folder entry, so there is no double run). webkitGetAsEntry must be read
  // synchronously while the drop event is live, so it happens before any await.
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (validating) return;
      const items = event.dataTransfer?.items;
      if (!items || items.length !== 1) return;
      const entry = items[0]?.webkitGetAsEntry?.();
      if (!entry || !entry.isDirectory) return;
      event.preventDefault();
      void gatherFromDroppedDirectory(entry as FileSystemDirectoryEntry)
        .then(runFolder)
        .catch((err) => {
          // The gather can reject on permission/transient FS errors; runFolder
          // handles its own failures. Log so this never becomes an unhandled
          // rejection (no UI surface for it by design).
          console.error("Failed to read dropped folder:", err);
        });
    },
    [validating, runFolder],
  );

  // File chosen through the "Select EPUB file" picker (an .epub or a standalone
  // file). Same run() path as a dropped file, so single-file mode detection and
  // the options args are identical.
  const handleFilePicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = input.files ? Array.from(input.files) : [];
      // Reset so choosing the same file again re-fires change.
      input.value = "";
      const file = files[0];
      if (!file) return;
      void run(file);
    },
    [run],
  );

  // Folder chosen through the <input webkitdirectory> picker.
  const handleFolderPicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = input.files ? Array.from(input.files) : [];
      // Reset so choosing the same folder again re-fires change.
      input.value = "";
      if (files.length === 0) return;
      void runFolder(gatherFromWebkitDirectory(files));
    },
    [runFolder],
  );

  const uploadProps: UploadProps = {
    accept: ACCEPT,
    multiple: false,
    showUploadList: false,
    disabled: validating,
    onDrop: handleDrop,
    beforeUpload: (file) => {
      void run(file as unknown as File);
      return Upload.LIST_IGNORE;
    },
  };

  const verdict = result ? VERDICT[result.verdict] : null;
  // Which kind of run produced this result, so the verdict wording tracks it: an
  // expanded-EPUB folder (validated in place) reads off the result flag; otherwise a
  // single-file (--mode) run vs. a whole-container .epub run is read back from
  // the finished result's name (same rule the run used to pick its mode).
  const runKind: RunKind = result
    ? result.isDirectory
      ? "directory"
      : modeForFile(result.name) !== null
        ? "file"
        : "epub"
    : "epub";

  // Completion notification. Fires once per finished result, carrying the SAME
  // outcome word, icon, and state colour the verdict banner uses (Pass/Warn/
  // Fail), so the popup and the banner always read as one state. Keyed on the
  // result identity so it pops exactly once when a run resolves.
  const notifiedResult = useRef<ValidationResult | null>(null);
  useEffect(() => {
    if (!result || notifiedResult.current === result) return;
    notifiedResult.current = result;
    const v = VERDICT[result.verdict];
    const color = tokenColors[v.tokenKey];
    notification.open({
      // Stable key so a new completion REPLACES the previous popup instead of
      // stacking a fresh one on every finished run.
      key: "epubcheck-verdict",
      message: <span style={{ color }}>{v.word}</span>,
      description: verdictDetail(result.verdict, runKind),
      icon: <span style={{ color }}>{v.icon}</span>,
    });
  }, [result, runKind, notification, tokenColors]);

  // Table rows: the finished result's messages once done, otherwise the messages
  // streaming in live during the run. Both are ReportMessage[], so the table
  // fills in AS validation proceeds and stays put when it completes.
  const rows = useMemo<Row[]>(() => {
    const source = result ? result.messages : liveMessages;
    return source.map(toRow);
  }, [result, liveMessages]);

  // The three official epubcheck reports come straight from the engine's own
  // JSON/XML/XMP writers (result.reports), produced during the run, so every
  // download is instant with no extra work on click. The console/CLI report has
  // no engine writer (there is no result.reports.console), so it is rendered on
  // demand here from the run's own { messages, features } ReportData via
  // formatConsoleReport, with the SAME filename the engine validated under (so its
  // per-message location prefixes match the other reports).
  const reports = useMemo<Record<ReportFormat, PreparedReport> | null>(() => {
    if (!result) return null;
    const base = result.name.replace(/\.[^.]+$/, "") || "report";
    const r = result.reports;
    const consoleText = formatConsoleReport(
      { messages: result.messages, features: result.features },
      { filename: result.name },
    );
    return {
      json: { filename: `${base}.json`, mime: "application/json", content: r.json ?? "" },
      xml: { filename: `${base}.xml`, mime: "application/xml", content: r.xml ?? "" },
      xmp: { filename: `${base}.xmp`, mime: "application/rdf+xml", content: r.xmp ?? "" },
      console: {
        filename: `${result.name}.txt`,
        mime: "text/plain",
        content: consoleText,
      },
      // Raw ReportData round-trip source: NOT the engine's formatted JSON report
      // (that is `json` above, from result.reports.json), but the exact
      // { messages, features } object that rehydrates losslessly and feeds any
      // formatter later. Saved under a distinct .report.json name so it is not
      // confused with the formatted <name>.json report.
      raw: {
        filename: `${result.name}.report.json`,
        mime: "application/json",
        content: JSON.stringify(
          { messages: result.messages, features: result.features },
          null,
          2,
        ),
      },
    };
  }, [result]);

  const handleDownload = useCallback(
    (fmt: ReportFormat) => {
      if (!reports) return;
      const r = reports[fmt];
      downloadText(r.filename, r.mime, r.content);
    },
    [reports],
  );

  // Screen-reader announcement of the run lifecycle. A visually-hidden polite
  // live region (not a visual change) that reads out each transition, reusing
  // existing strings (the verdict word + detail for a finished run, the error
  // alert title for a failure) and minimal new ones for the phases. Initializing
  // takes priority: a run started while the engine is still warming queues
  // behind it, so the truthful state stays "initializing" until warm-up resolves.
  const liveMessage = initializing
    ? m.status_initializing()
    : status === "validating"
      ? m.status_validating()
      : status === "done" && verdict
        ? `${verdict.word}. ${verdictDetail(result!.verdict, runKind)}`
        : status === "error"
          ? `${m.alert_error_title()}${error ? `. ${error}` : ""}`
          : status === "cancelled"
            ? m.status_cancelled()
            : "";

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px 48px" }}>
      {/* Visually-hidden live region: announces the run lifecycle to assistive
          tech without altering the visual design. */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          border: 0,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {liveMessage}
      </div>

      <Header />

      <FeatureGrid />

      <InputCard
        tokenColors={tokenColors}
        validating={validating}
        initializing={initializing}
        onCancel={cancel}
        uploadProps={uploadProps}
        runSample={runSample}
        fileInputRef={fileInputRef}
        folderInputRef={folderInputRef}
        handleFilePicked={handleFilePicked}
        handleFolderPicked={handleFolderPicked}
        url={url}
        setUrl={setUrl}
        runUrl={runUrl}
        profile={profile}
        setProfile={setProfile}
        locale={locale}
        setLocale={setLocale}
        version={version}
        setVersion={setVersion}
        showUsage={showUsage}
        setShowUsage={setShowUsage}
        customMessages={customMessages}
        setCustomMessages={setCustomMessages}
      />

      {error && (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          showIcon
          message={m.alert_error_title()}
          description={error}
        />
      )}

      {result && verdict && (
        <ResultsCard
          result={result}
          runKind={runKind}
          tokenColors={tokenColors}
          rows={rows}
          reports={reports}
          handleDownload={handleDownload}
          wrapRawOutput={wrapRawOutput}
          setWrapRawOutput={setWrapRawOutput}
        />
      )}

      <Footer tokenColors={tokenColors} />
    </div>
  );
}
