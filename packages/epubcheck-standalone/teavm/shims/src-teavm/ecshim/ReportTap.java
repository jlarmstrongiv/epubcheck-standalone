package ecshim;

import org.teavm.jso.JSBody;

/**
 * OPTIONAL host tap for the report-event stream: mirrors every level-filtered
 * checker message and every feature/info event out to the JS host WHILE the
 * run is happening, so ONE plain validation run carries everything the
 * host-side report formatters (formatters/index.ts) need to render epubcheck's
 * JSON / XML / XMP reports after the fact -- no per-format re-validation, and
 * the host's onMessage callback fires live during the run.
 *
 * Host contract (installed by the TypeScript driver before main() runs; both
 * must be present for the tap to arm):
 *
 *   globalThis.__ecTapMessage(id, severity, message, suggestion,
 *                             path, line, column, context, consoleText)
 *     -- one call per Report.message() that PASSED the reporting-level filter
 *        (i.e. exactly the calls every epubcheck report writer receives at the
 *        same level), with the RAW formatted text (message.getMessage(args),
 *        no whitespace collapsing -- what the JSON/XML/XMP writers store), the
 *        localized suggestion, the raw EPUBLocation fields, and the exact
 *        console line DefaultReportImpl is about to print (severity-prefixed,
 *        whitespace-collapsed -- what the console parser sees).
 *
 *   globalThis.__ecTapInfo(resource, feature, value)
 *     -- one call per Report.info() event, in emission order; `feature` is the
 *        FeatureEnum constant name (e.g. "DC_TITLE", "CREATION_DATE",
 *        "REFERENCE", "TOOL_DATE"). This is the stream the report writers
 *        aggregate: publication metadata, per-item sizes/checksums/mimetypes,
 *        references, chars counts, fonts, tool info.
 *
 * When the host installs no tap, nothing is emitted and behavior (including
 * all console output) is byte-for-byte unchanged. The interception seam is
 * the shim-jar shadow of com.adobe.epubcheck.util.DefaultReportImpl (upstream
 * source verbatim plus the two tap calls); the earlier engine's
 * ReportTap/ReportTapSubstitutions pair was the model for this class.
 *
 * TeaVM CPS-safety: state is ONE plain static int -- no clinit-created
 * collections anywhere near async-lowered chains (the HostDir landmine, see
 * agent-docs/teavm-fixes.md). The wrapper calls {@link #reset()} at the start
 * of every main(), so the probe re-arms per run even when the driver reuses
 * one engine scope across validations.
 */
public final class ReportTap {

    private ReportTap() {
    }

    /** -1 unknown, 0 disabled, 1 enabled; probed once per run. */
    private static int enabled = -1;

    /** Per-run reset (called by the wrapper at the start of every main()). */
    public static void reset() {
        enabled = -1;
    }

    @JSBody(script = "return typeof globalThis.__ecTapMessage === 'function'"
            + " && typeof globalThis.__ecTapInfo === 'function';")
    private static native boolean hasTap();

    public static boolean enabled() {
        if (enabled == -1) {
            enabled = hasTap() ? 1 : 0;
        }
        return enabled == 1;
    }

    @JSBody(params = { "id", "severity", "message", "suggestion", "path", "line", "column",
            "context", "consoleText" },
            script = "globalThis.__ecTapMessage(id, severity, message, suggestion, path, line,"
                    + " column, context, consoleText);")
    public static native void emitMessage(String id, String severity, String message,
            String suggestion, String path, int line, int column, String context,
            String consoleText);

    @JSBody(params = { "resource", "feature", "value" },
            script = "globalThis.__ecTapInfo(resource, feature, value);")
    public static native void emitInfo(String resource, String feature, String value);
}
