import type { ReactNode } from "react";
import {
  ApiOutlined,
  CodeSandboxOutlined,
  DatabaseOutlined,
  DiffOutlined,
  FileTextOutlined,
  LaptopOutlined,
  LockOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
// The package version powers the header tag; read it at build time so the demo
// tracks whatever epubcheck-standalone build is wired into the workspace.
import epubcheckPkg from "epubcheck-standalone/package.json";
// Paraglide JS messages: the page's user-facing UI copy, externalized into the
// English source catalog at messages/en.json and compiled to src/paraglide.
// English is the only locale and the baseLocale today, so every m.* call
// resolves to the English string (see astro.config.ts for the compiler wiring).
import { m } from "../../paraglide/messages.js";
import type { Severity, Verdict } from "../../worker/types";

export const PACKAGE_VERSION = `v${epubcheckPkg.version}`;
// The engine version is the package version's prefix before "-build".
export const ENGINE_VERSION = epubcheckPkg.version.split("-build")[0];

export const NPM_URL = "https://www.npmjs.com/package/epubcheck-standalone";
export const GITHUB_URL = "https://github.com/jlarmstrongiv/epubcheck-standalone";

// A small inline npm wordmark (antd has no npm icon). Sized to 1em so it lines
// up with the adjacent GithubOutlined glyph. Path is the standard npm mark.
export function NpmIcon() {
  return (
    <span
      role="img"
      aria-label="npm"
      style={{ display: "inline-flex", fontSize: 20, lineHeight: 1 }}
    >
      <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
        <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
      </svg>
    </span>
  );
}

// Marketing bullets — all nine points, each a single line, ordered strongest
// first (substance up top; housekeeping — up-to-date, license — last). Six use
// the user's final verbatim copy; three (parity, privacy, and the engine bullet)
// are condensed to the same terse one-line style. The engine bullet's
// `m.feature_graalvm()` text is owner-approved copy ("JavaScript compiled by
// TeaVM"); the message key keeps its historical name because renaming it churns
// every locale file for zero user-visible gain.
// Each bullet keeps an icon; the license bullet uses a paper/document icon.
export const FEATURES: { icon: ReactNode; text: string }[] = [
  { icon: <ThunderboltOutlined />, text: m.feature_web() },
  { icon: <DatabaseOutlined />, text: m.feature_large_files() },
  { icon: <DiffOutlined />, text: m.feature_identical_output() },
  { icon: <LockOutlined />, text: m.feature_privacy() },
  { icon: <LaptopOutlined />, text: m.feature_node_browser() },
  { icon: <ApiOutlined />, text: m.feature_web_worker() },
  { icon: <CodeSandboxOutlined />, text: m.feature_graalvm() },
  { icon: <SyncOutlined />, text: m.feature_up_to_date() },
  { icon: <FileTextOutlined />, text: m.feature_license() },
];

// Each severity gets a distinct antd preset colour. USAGE (the -u level, below
// INFO) takes purple: clearly separate from the four existing hues (magenta
// FATAL, red ERROR, orange WARNING, blue INFO) and reads as advisory, not alarm.
export const SEVERITY_COLOR: Record<Severity, string> = {
  FATAL: "magenta",
  ERROR: "red",
  WARNING: "orange",
  INFO: "blue",
  USAGE: "purple",
};

// Options-row config. Selected values build the epubcheck CLI `args` list the
// worker passes to validate(); leaving every control at its default yields an
// EMPTY args array, i.e. exactly today's plain container validation.

// Validation profiles epubcheck ships, mirrored from the CLI package's
// KNOWN_PROFILES. "DEFAULT" adds no argument (the engine's own default); the
// others pass `--profile <lowercased>` exactly like the stock CLI. Each row
// carries a plain-language title and one-line description for the radio group.
export const PROFILES: { value: string; title: string; description: string }[] =
  [
    {
      value: "DEFAULT",
      title: m.profile_default_title(),
      description: m.profile_default_desc(),
    },
    {
      value: "EDUPUB",
      title: m.profile_edupub_title(),
      description: m.profile_edupub_desc(),
    },
    {
      value: "DICT",
      title: m.profile_dict_title(),
      description: m.profile_dict_desc(),
    },
    {
      value: "IDX",
      title: m.profile_idx_title(),
      description: m.profile_idx_desc(),
    },
    {
      value: "PREVIEW",
      title: m.profile_preview_title(),
      description: m.profile_preview_desc(),
    },
  ];

// The locales the engine ships (it is plain JavaScript from TeaVM, not a wasm
// image), with human-readable language names.
// English is the default and adds no `--locale` argument (the engine's own
// default), so the default options stay an empty args array.
//
// IMPORTANT: these `value`s are the ENGINE's message-locale tags passed to
// epubcheck via `--locale`; they are NOT the page's UI locale set. They keep the
// jar's exact tags, including Korean as `ko-KR`. The page's UI copy is localized
// separately through Paraglide (messages/<locale>.json), where Korean is the
// normalized `ko`. When a `ko` UI locale exists, mapping it to this select's
// engine `ko-KR` is future work; only the `label`s below are UI copy and are
// localized, while the `value`s stay fixed to the engine's tags.
export const DEFAULT_LOCALE = "en";
export const LOCALES: { value: string; label: string }[] = [
  { value: "en", label: m.lang_en() },
  { value: "da", label: m.lang_da() },
  { value: "de", label: m.lang_de() },
  { value: "es", label: m.lang_es() },
  { value: "fr", label: m.lang_fr() },
  { value: "it", label: m.lang_it() },
  { value: "ja", label: m.lang_ja() },
  { value: "ko-KR", label: m.lang_ko() },
  { value: "nl", label: m.lang_nl() },
  { value: "pt-BR", label: m.lang_pt_br() },
  { value: "zh-TW", label: m.lang_zh_tw() },
];

// EPUB versions offered for single-file checks. The known-good invocation shape
// is `--mode <type> -v <version>`; default 3.0.
export const VERSIONS = ["3.0", "2.0"] as const;
export const DEFAULT_VERSION = "3.0";

// Extensions the dropzone/picker accepts, and the epubcheck `--mode` each
// standalone file maps to. `.epub` maps to null: no --mode, the default whole-
// container validation. Every other accepted file materializes that one file
// and checks it in the matching mode with the chosen -v version.
export const ACCEPT = ".epub,.xhtml,.html,.svg,.opf,.smil";
export function modeForFile(name: string): string | null {
  const ext = /\.[^.]+$/.exec(name.toLowerCase())?.[0];
  switch (ext) {
    case ".xhtml":
    case ".html":
      return "xhtml";
    case ".svg":
      return "svg";
    case ".opf":
      return "opf";
    case ".smil":
      return "mo";
    default:
      return null; // .epub (and anything unrecognized) -> container validation
  }
}

// A short, ready-to-run EPUBCheck override file for the "Load example" button.
// Every line is verified against the demo's own sample books and shows one of
// the three main override uses:
//   - promote:  ACC-004 ships SUPPRESSED; WARNING reveals the empty-anchor
//     accessibility check (fires on content with a link that has no text).
//   - suppress: PKG-010 is the WARNING the "Warning sample" emits; SUPPRESSED
//     makes that book pass cleanly.
//   - reword:   RSC-007 is an ERROR the "Failing sample" emits; the custom text
//     keeps the error but substitutes the resource path via %1$s.
// Tab-separated (ID, Severity, optional Message, optional Suggestion), the exact
// shape epubcheck's -c/--customMessages expects.
export const EXAMPLE_CUSTOM_MESSAGES = [
  "ACC-004\tWARNING",
  "PKG-010\tSUPPRESSED",
  "RSC-007\tERROR\tCustom check: %1$s could not be found.",
  "",
].join("\n");

// The three sample buttons. Labels carry no filenames; each maps to a verdict
// state so the button can wear the SAME icon and state colour the banner and
// notification use for that outcome, foreshadowing the verdict it produces. The
// fixture file names are unchanged.
export const SAMPLES: { file: string; label: string; verdict: Verdict }[] = [
  { file: "test.epub", label: m.sample_passing(), verdict: "valid" },
  { file: "test_warn.epub", label: m.sample_warning(), verdict: "warnings" },
  { file: "test_bad.epub", label: m.sample_failing(), verdict: "invalid" },
];
