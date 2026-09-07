import type { ReactNode } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import { m } from "../../paraglide/messages.js";
import type { Verdict } from "../../worker/types";

// Three-state verdict: green/success (passed), yellow/warning (valid but has
// warnings), red/error (failed). The text + icon render in the EXACT same colour
// the results table's severity tags use for their text. antd preset-colour tags
// derive that text colour from the `<family>7` theme token (see antd's
// genPresetColor: textColor = token[`${colorKey}7`]) — the WARNING tag is
// orange-7. We mirror that mechanism verbatim, reading the same live token per
// state (green-7 / orange-7 / red-7) so the warnings verdict is tonally
// identical to the WARNING tag and green/red are the same treatment in-hue.
export const VERDICT: Record<
  Verdict,
  {
    type: "success" | "warning" | "error";
    /** Canonical run-outcome word shown in the banner and notification. */
    word: string;
    /** antd theme-token key for the tag text colour of this state's hue. */
    tokenKey: "green7" | "orange7" | "red7";
    icon: ReactNode;
  }
> = {
  valid: {
    type: "success",
    word: m.verdict_pass(),
    tokenKey: "green7",
    icon: <CheckCircleFilled />,
  },
  warnings: {
    type: "warning",
    word: m.verdict_warn(),
    tokenKey: "orange7", // identical to the WARNING severity tag
    icon: <ExclamationCircleFilled />,
  },
  invalid: {
    type: "error",
    word: m.verdict_fail(),
    tokenKey: "red7",
    icon: <CloseCircleFilled />,
  },
};

// Supporting sentence under the outcome word, present tense. The noun tracks the
// run: "expanded EPUB" for a folder run, "file" for a single-file
// (--mode) run, and "EPUB" for a whole-container check, so it reads sensibly for
// every kind of run. The banner and the completion notification share this text.
export type RunKind = "epub" | "file" | "directory";
export function verdictDetail(verdict: Verdict, kind: RunKind): string {
  const noun =
    kind === "directory"
      ? m.verdict_noun_directory()
      : kind === "file"
        ? m.verdict_noun_file()
        : m.verdict_noun_epub();
  switch (verdict) {
    case "valid":
      return m.verdict_detail_valid({ noun });
    case "warnings":
      return m.verdict_detail_warnings({ noun });
    case "invalid":
      return m.verdict_detail_invalid({ noun });
  }
}
