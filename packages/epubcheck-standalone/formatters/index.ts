// epubcheck-standalone -- report formatters, byte-identical to epubcheck's own
// file reports.
//
// The native epubcheck CLI can write three report documents, one per run:
//   --json  com.adobe.epubcheck.reporting.CheckingReport  (Jackson)
//   --out   com.adobe.epubcheck.util.XmlReportImpl        (DOM -> Saxon-HE 11.4)
//   --xmp   com.adobe.epubcheck.util.XmpReportImpl        (DOM -> Saxon-HE 11.4)
//
// This module reproduces those three writers in pure, environment-neutral ESM,
// fed by the complete REPORT DATA of one validation run ({ messages, features }:
// every level-filtered checker message plus every feature/info event, in
// emission order). One validation, any/all report files after the fact, no
// re-validation, no flags. `validate()`'s result IS a ReportData (it carries
// `messages` + `features` directly), so a result can be handed straight to a
// formatter; run-core renders the `reports` option through here inline, and a
// caller can equally JSON.stringify `{ messages, features }`, persist it, and
// JSON.parse it back later to re-render any report byte-for-byte.
//
// Recovered from the retired wasm-era implementation (git 25b4b40, root
// formatters.mjs; re-vendored at 4178e25) and ported to first-class TypeScript.
// The logic is unchanged from that proven implementation (449/449 corpus books
// x 3 formats byte-identical to `java -jar epubcheck.jar` at the time).
//
// FIDELITY: every aggregation rule is ported from the epubcheck 5.3.0 sources
// (CheckingReport / CheckerMetadata / PublicationMetadata / ItemMetadata /
// CheckMessage / EPUBLocation / XmlReportAbstract / XmlReportImpl /
// XmpReportImpl), and the two serializers reproduce the exact bytes of the
// native toolchain:
//   - JSON: Jackson 2.x DefaultPrettyPrinter ("key" : value, 2-space object
//     indent, single-line arrays with ", " separators), ESCAPE_NON_ASCII
//     (every char > 0x7F as \uXXXX, uppercase hex).
//   - XML/XMP: Saxon-HE 11.4 XMLEmitter/XMLIndenter (3-space indent, sorted
//     attributes after sorted namespace declarations -- the Xerces
//     NamedNodeMap sorts by node name -- Saxon's exact attribute-wrapping
//     length rule and escape tables, trailing newline).
//
// PATHS: a run that validated a VFS marker path (/jsfile/<filename>, legacy
// /tmp/<filename>) has that marker mapped back to the form native epubcheck
// derives when run as `cd <dir> && epubcheck <filename> --json ...`:
// "./<filename>" (JSON checker.path, epub-level locations) and "<filename>"
// (XML repInfo uri). Tap data already carrying native-form paths (the current
// TeaVM engine does) passes through unchanged.
//
// RUN-VARYING FIELDS (the only fields that can never match across two runs;
// override them to reproduce a specific run byte-for-byte, e.g. in tests):
//   - JSON  checker.checkDate    (validation start time)   -> options.checkDate
//   - JSON  checker.elapsedTime  (validation duration ms)  -> options.elapsedTime
//   - XML   <date>               (report generation time)  -> options.generationDate
//   - XMP   premis:hasEventDateTime (generation time)      -> options.generationDate
//   - the random per-run base URL epubcheck mints to resolve the container's
//     relative URLs: "https://<uuid>.epubcheck.w3c.org/...". It appears in
//     some message texts and location contexts. The formatters faithfully
//     reproduce THIS run's UUID (it comes through the tap); two runs -- even
//     two native runs -- always differ, so comparisons must normalize the
//     UUID on both sides (test/formatters.ts does).
// One more nondeterminism lives in NATIVE epubcheck itself: the field order
// inside JSON locations[].url ({opaque, hierarchical}) flips between JVM runs
// (Jackson introspects galimatias URL's is-getters via getDeclaredMethods,
// whose order is unspecified). This formatter always emits
// {"opaque", "hierarchical"}; compare that object order-insensitively.

import { EPUBCHECK_VERSION } from '../version.js';

const MAX_LOCATIONS = 25; // CheckMessage.MAX_LOCATIONS

// ---------------------------------------------------------------------------
// public report-data types (the formatter input contract; also the shape
// validate()'s result exposes -- an EpubCheckResult IS a ReportData, so it can
// be handed straight to a formatter, and { messages, features } can be
// JSON-serialized and rehydrated to re-render any report losslessly later)
// ---------------------------------------------------------------------------

/** Severity of a report message (Severity.toInt order). */
export type ReportSeverity = 'SUPPRESSED' | 'USAGE' | 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

/** One level-filtered checker message, as epubcheck's report writers see it. */
export interface ReportMessage {
  /** Message id, e.g. "RSC-005". */
  id: string;
  severity: ReportSeverity;
  /** RAW message text (no whitespace collapsing, unlike the console stream). */
  message: string;
  /** Localized suggestion text ("" when none). */
  suggestion: string;
  /** Location path (container-relative, or the path of the EPUB itself). */
  path: string;
  /** 1-based line, or -1 when not tied to a position. */
  line: number;
  /** 1-based column, or -1 when not tied to a position. */
  column: number;
  /** Location context snippet, or null. */
  context: string | null;
  /**
   * Global emission index of this event, 0-based, monotonically increasing and
   * shared across BOTH `messages` and `features`: the value counts up by one
   * for every message AND every feature the engine emits, in the true program
   * order epubcheck produced them (a single-threaded, synchronous stream). It
   * lets a consumer interleave the two lists back into one emission-ordered
   * stream -- notably so the console renderer can place the "Validating using
   * EPUB version X rules." line (derived from a FORMAT_VERSION feature) in its
   * real position relative to the messages, including container/OCF-level
   * messages emitted BEFORE the version is determined. The json/xml/xmp
   * formatters ignore it.
   */
  sequence: number;
}

/** One feature/info event (Report.info), in emission order. */
export interface ReportFeature {
  /** Resource path inside the container, or null for publication-level info. */
  resource: string | null;
  /** FeatureEnum constant name, e.g. "DC_TITLE", "SIZE", "SHA_256". */
  feature: string;
  value: string | null;
  /**
   * Global emission index of this event, 0-based, monotonically increasing and
   * shared across BOTH `messages` and `features` (see `ReportMessage.sequence`
   * for the full contract): the same counter stamps every message and every
   * feature in true program order, so the two lists can be merged back into one
   * emission-ordered stream.
   */
  sequence: number;
}

/**
 * The complete report data of one validation run: every level-filtered checker
 * message plus every feature/info event, in emission order. This is both the
 * formatters' input and the structural core of `validate()`'s result (which
 * adds `valid`/`exitCode`/`summary`/`stdout`/`stderr`/`reports` on top), so a
 * result can be passed straight to a formatter and `{ messages, features }` can
 * be saved as JSON and rehydrated to re-render any report losslessly later.
 */
export interface ReportData {
  messages: ReportMessage[];
  features: ReportFeature[];
}

export interface FormatterOptions {
  /**
   * The EPUB file name (e.g. "book.epub") -- the formatters derive every path
   * field from it exactly as native epubcheck does when run as
   * `cd <dir> && epubcheck <filename> --json <out>`: JSON checker.path
   * becomes "./<filename>" and XML repInfo uri "<filename>".
   */
  filename: string;
  /**
   * JSON only -- checker.checkDate, the validation start time. RUN-VARYING:
   * defaults to now, formatted like native ("MM-dd-yyyy HH:mm:ss", local
   * time). Pass a string to reproduce a specific run byte-for-byte.
   */
  checkDate?: string | Date;
  /**
   * JSON only -- checker.elapsedTime, the validation duration in
   * milliseconds. RUN-VARYING: defaults to 0.
   */
  elapsedTime?: number;
  /**
   * XML/XMP only -- the report generation timestamp (XML `<date>`,
   * XMP premis:hasEventDateTime). RUN-VARYING: defaults to now, formatted
   * like native ("yyyy-MM-ddTHH:mm:ss+hh:mm", local time).
   */
  generationDate?: string | Date;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Java String.compareTo sign (UTF-16 code-unit order). */
const scmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** CheckMessage.safeCompare / EPUBLocation.safeCompare (null-tolerant). */
function safeCompare(a: string | null, b: string | null): number {
  if (a === null && b !== null) return -1;
  if (a !== null && b === null) return 1;
  if (a === null || b === null) return 0;
  return scmp(a, b);
}

/** Severity.toInt() */
const SEVERITY_INT: Record<ReportSeverity, number> = {
  SUPPRESSED: 0, USAGE: 1, INFO: 2, WARNING: 3, ERROR: 4, FATAL: 5,
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** CheckerMetadata's SimpleDateFormat("MM-dd-yyyy HH:mm:ss") (local time). */
function formatCheckDate(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${d.getFullYear()} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** XmlReportAbstract.fromTime: ISO 8601 with a colon in the zone offset. */
function formatGenerationDate(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

interface ResolvedOptions {
  filename: string;
  checkDate: string | Date;
  elapsedTime: number;
  generationDate: string | Date;
}

function resolveOptions(options: FormatterOptions): ResolvedOptions {
  const filename = options && options.filename;
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('formatters: options.filename (string) is required -- the EPUB file name');
  }
  return {
    filename,
    checkDate: options.checkDate !== undefined
      ? options.checkDate
      : formatCheckDate(new Date()),
    elapsedTime: options.elapsedTime !== undefined ? options.elapsedTime : 0,
    generationDate: options.generationDate !== undefined
      ? options.generationDate
      : formatGenerationDate(new Date()),
  };
}

interface PathMapper {
  mapPath: (p: string) => string;
  mapText: (t: string) => string;
}

/**
 * Map a VFS marker path (/jsfile/<filename>, legacy /tmp/<filename>) to the
 * path native epubcheck derives for the EPUB itself ("./<filename>"). Paths
 * already in native form pass through unchanged.
 */
function makePathMapper(filename: string): PathMapper {
  const markers = [`/jsfile/${filename}`, `/tmp/${filename}`];
  const mapPath = (p: string): string => {
    if (p === null || p === undefined) return p;
    for (const m of markers) {
      if (p === m) return `./${filename}`;
      if (p.startsWith(m + '/')) return `./${filename}` + p.slice(m.length);
    }
    return p;
  };
  const mapText = (t: string): string => {
    if (t === null || t === undefined) return t;
    let out = t;
    for (const m of markers) out = out.split(m).join(`./${filename}`);
    return out;
  };
  return { mapPath, mapText };
}

interface CheckLocation {
  path: string;
  line: number;
  column: number;
  context: string | null;
}

interface CheckMessageGroup {
  ID: string;
  severity: ReportSeverity;
  message: string;
  additionalLocations: number;
  locations: CheckLocation[];
  suggestion: string | null;
}

/** EPUBLocation.equals (Optional<String> context: both-absent counts equal). */
function locationEquals(a: CheckLocation, b: CheckLocation): boolean {
  return a.path === b.path && a.line === b.line && a.column === b.column &&
    (a.context ?? null) === (b.context ?? null);
}

/** EPUBLocation.compareTo */
function locationCompare(a: CheckLocation, b: CheckLocation): number {
  let c = safeCompare(a.path, b.path);
  if (c !== 0) return c;
  c = a.line - b.line;
  if (c !== 0) return c < 0 ? -1 : 1;
  c = a.column - b.column;
  if (c !== 0) return c < 0 ? -1 : 1;
  return safeCompare(a.context ?? null, b.context ?? null);
}

/**
 * CheckMessage.addCheckMessage: group tap messages by (ID, text), dedupe
 * locations, cap at MAX_LOCATIONS with the additionalLocations counter.
 */
function addCheckMessage(
  list: CheckMessageGroup[],
  tap: ReportMessage,
  mapPath: PathMapper['mapPath'],
  mapText: PathMapper['mapText'],
): CheckMessageGroup {
  const text = mapText(tap.message);
  const location: CheckLocation = {
    path: mapPath(tap.path),
    line: tap.line,
    column: tap.column,
    context: tap.context,
  };
  let cm = list.find((m) => m.ID === tap.id && m.message === text);
  if (!cm) {
    cm = {
      ID: tap.id,
      severity: tap.severity,
      message: text,
      additionalLocations: 0,
      locations: [location],
      // CheckMessage: "".equals(suggestion) ? null : suggestion
      suggestion: tap.suggestion === '' ? null : tap.suggestion,
    };
    list.push(cm);
  } else if (!cm.locations.some((l) => locationEquals(l, location))) {
    if (cm.locations.length === MAX_LOCATIONS) {
      cm.additionalLocations++;
    } else if (cm.locations.length < MAX_LOCATIONS) {
      cm.locations.push(location);
    } else {
      cm.additionalLocations++;
      cm.locations.pop();
    }
  }
  return cm;
}

/** CheckMessage.compareTo */
function checkMessageCompare(a: CheckMessageGroup, b: CheckMessageGroup): number {
  let c = safeCompare(a.ID, b.ID);
  if (c !== 0) return c;
  c = SEVERITY_INT[a.severity] - SEVERITY_INT[b.severity];
  if (c !== 0) return c < 0 ? -1 : 1;
  c = safeCompare(a.message, b.message);
  if (c !== 0) return c;
  c = safeCompare(a.suggestion, b.suggestion);
  if (c !== 0) return c;
  c = a.additionalLocations - b.additionalLocations;
  if (c !== 0) return c < 0 ? -1 : 1;
  c = a.locations.length - b.locations.length;
  if (c !== 0) return c < 0 ? -1 : 1;
  return 0;
}

const parseLong = (s: string | null): number => parseInt(String(s).trim(), 10);
/** Boolean.parseBoolean: case-insensitive "true". */
const parseBool = (s: string | null): boolean => /^true$/i.test(String(s).trim());

// --- java.util.HashMap iteration-order emulation ----------------------------
// CheckingReport keys its item index by file name in a plain HashMap and
// builds the items list from HashMap.values() BEFORE the stable sort by id --
// so when two items share an id (multiple renditions), their relative order
// is the HashMap's hash-bucket order, which we reproduce exactly: bucket =
// spread(String.hashCode) & (capacity-1) with capacity doubling from 16 at
// load factor 0.75; entries within a bucket keep insertion order (as do
// JDK 8+ resize splits).

function javaStringHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function hashMapOrderKeys(keys: string[]): string[] {
  let cap = 16;
  let threshold = 12;
  for (let size = 1; size <= keys.length; size++) {
    if (size > threshold) {
      cap <<= 1;
      threshold = Math.floor(cap * 0.75);
    }
  }
  return keys
    .map((key, i) => {
      const h = javaStringHashCode(key);
      return { key, i, bucket: (h ^ (h >>> 16)) & (cap - 1) };
    })
    .sort((a, b) => a.bucket - b.bucket || a.i - b.i)
    .map((e) => e.key);
}

// ---------------------------------------------------------------------------
// JSON report (CheckingReport, --json)
// ---------------------------------------------------------------------------

interface ItemMetadata {
  id: string;
  fileName: string;
  media_type: string | null;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: string | null;
  checkSum: string | null;
  isSpineItem: boolean;
  spineIndex: number | null;
  isLinear: boolean;
  isFixedFormat: boolean | null;
  isScripted: boolean;
  renditionLayout: string | null;
  renditionOrientation: string | null;
  renditionSpread: string | null;
  referencedItems: Set<string>;
}

function newItem(fileName: string): ItemMetadata {
  return {
    id: '',
    fileName,
    media_type: null,
    compressedSize: 0,
    uncompressedSize: 0,
    compressionMethod: null,
    checkSum: null,
    isSpineItem: false,
    spineIndex: null,
    isLinear: false,
    isFixedFormat: null,
    isScripted: false,
    renditionLayout: null,
    renditionOrientation: null,
    renditionSpread: null,
    referencedItems: new Set(),
  };
}

/** ItemMetadata.handleInfo */
function itemHandleInfo(item: ItemMetadata, feature: string, value: string | null): void {
  switch (feature) {
    case 'DECLARED_MIMETYPE': item.media_type = value; break;
    case 'HAS_SCRIPTS': item.isScripted = true; break;
    case 'HAS_FIXED_LAYOUT': item.isFixedFormat = true; break;
    case 'IS_SPINEITEM': item.isSpineItem = true; break;
    case 'UNIQUE_IDENT': item.id = value !== null ? value : ''; break;
    case 'IS_LINEAR': item.isLinear = parseBool(value); break;
    case 'RESOURCE':
      if (value !== null && value !== item.fileName) item.referencedItems.add(value);
      break;
    case 'SIZE': item.uncompressedSize = parseLong(value); break;
    case 'COMPRESSED_SIZE': item.compressedSize = parseLong(value); break;
    case 'COMPRESSION_METHOD': item.compressionMethod = value; break;
    case 'SHA_256': item.checkSum = value; break;
    case 'SPINE_INDEX': item.spineIndex = parseLong(value); break;
    case 'RENDITION_LAYOUT': item.renditionLayout = value; break;
    case 'RENDITION_ORIENTATION': item.renditionOrientation = value; break;
    case 'RENDITION_SPREAD': item.renditionSpread = value; break;
    default: break;
  }
}

interface PublicationMetadata {
  publisher: string | null;
  title: string | null;
  creator: (string | null)[];
  date: string | null;
  subject: (string | null)[];
  description: string | null;
  rights: string | null;
  identifier: string | null;
  language: string | null;
  nSpines: number;
  checkSum: number;
  renditionLayout: string | null;
  renditionOrientation: string | null;
  renditionSpread: string | null;
  ePubVersion: string | null;
  isScripted: boolean;
  hasFixedFormat: boolean;
  isBackwardCompatible: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  charsCount: number;
  embeddedFonts: Set<string | null>;
  refFonts: Set<string | null>;
  hasEncryption: boolean;
  hasSignatures: boolean;
  contributors: Set<string | null>;
}

/** PublicationMetadata.handleInfo */
function publicationHandleInfo(
  pub: PublicationMetadata,
  resource: string | null,
  feature: string,
  value: string | null,
): void {
  switch (feature) {
    case 'DC_TITLE': pub.title = value; break;
    case 'DC_LANGUAGE': pub.language = value; break;
    case 'DC_PUBLISHER': pub.publisher = value; break;
    case 'DC_CREATOR': pub.creator.push(value); break;
    case 'DC_RIGHTS': pub.rights = value; break;
    case 'DC_SUBJECT': pub.subject.push(value); break;
    case 'DC_DESCRIPTION': pub.description = value; break;
    case 'MODIFIED_DATE': pub.date = value; break;
    case 'UNIQUE_IDENT': if (resource === null) pub.identifier = value; break;
    case 'FORMAT_VERSION': pub.ePubVersion = value; break;
    case 'HAS_SCRIPTS': pub.isScripted = true; pub.isBackwardCompatible = false; break;
    case 'HAS_FIXED_LAYOUT': pub.hasFixedFormat = true; pub.isBackwardCompatible = false; break;
    case 'IS_SPINEITEM': pub.nSpines++; break;
    case 'HAS_NCX': if (!parseBool(value)) pub.isBackwardCompatible = false; break;
    case 'RENDITION_LAYOUT': if (resource === null) pub.renditionLayout = value; break;
    case 'RENDITION_ORIENTATION': if (resource === null) pub.renditionOrientation = value; break;
    case 'RENDITION_SPREAD': if (resource === null) pub.renditionSpread = value; break;
    case 'CHARS_COUNT': pub.charsCount += parseLong(value); break;
    case 'DECLARED_MIMETYPE':
      if (value !== null && value.startsWith('audio/')) pub.hasAudio = true;
      else if (value !== null && value.startsWith('video/')) pub.hasVideo = true;
      break;
    case 'FONT_EMBEDDED': pub.embeddedFonts.add(value); break;
    case 'FONT_REFERENCE': pub.refFonts.add(value); break;
    case 'HAS_SIGNATURES': pub.hasSignatures = true; break;
    case 'HAS_ENCRYPTION': pub.hasEncryption = true; break;
    case 'DC_CONTRIBUTOR': pub.contributors.add(value); break;
    default: break;
  }
}

// --- Jackson DefaultPrettyPrinter + ESCAPE_NON_ASCII emulation --------------

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function jacksonEscape(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20 || c > 0x7f) {
      out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    } else out += s.charAt(i);
  }
  return out + '"';
}

/**
 * Jackson pretty printing: objects indent 2 spaces per OBJECT depth with
 * `"key" : value`; arrays stay on one line (", " separators, "[ ... ]").
 */
function jacksonSerialize(value: JsonValue, depth: number): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return jacksonEscape(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[ ]';
    return '[ ' + value.map((v) => jacksonSerialize(v, depth)).join(', ') + ' ]';
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{ }';
  const ind = '  '.repeat(depth + 1);
  const body = keys
    .map((k) => `${ind}${jacksonEscape(k)} : ${jacksonSerialize(value[k] as JsonValue, depth + 1)}`)
    .join(',\n');
  return '{\n' + body + '\n' + '  '.repeat(depth) + '}';
}

/**
 * Format the JSON report -- byte-identical to `epubcheck --json`
 * (com.adobe.epubcheck.reporting.CheckingReport rendered by Jackson).
 *
 * The single caveat: native epubcheck itself flips the field order inside
 * locations[].url ({opaque, hierarchical}) between JVM runs; this formatter
 * always emits {"opaque", "hierarchical"}.
 */
export function formatJsonReport(reportData: ReportData, options: FormatterOptions): string {
  const opts = resolveOptions(options);
  const { mapPath, mapText } = makePathMapper(opts.filename);

  // --- collect messages (CheckingReport.message) ---
  const messages: CheckMessageGroup[] = [];
  for (const tap of reportData.messages) addCheckMessage(messages, tap, mapPath, mapText);

  // --- collect publication + items (CheckingReport.info) ---
  const pub: PublicationMetadata = {
    publisher: null, title: null, creator: [], date: null, subject: [],
    description: null, rights: null, identifier: null, language: null,
    nSpines: 0, checkSum: 0, renditionLayout: 'reflowable',
    renditionOrientation: 'auto', renditionSpread: 'auto', ePubVersion: null,
    isScripted: false, hasFixedFormat: false, isBackwardCompatible: true,
    hasAudio: false, hasVideo: false, charsCount: 0,
    embeddedFonts: new Set(), refFonts: new Set(),
    hasEncryption: false, hasSignatures: false, contributors: new Set(),
  };
  const itemIndex = new Map<string, ItemMetadata>();
  for (const { resource, feature, value } of reportData.features) {
    publicationHandleInfo(pub, resource, feature, value);
    if (resource !== null && resource !== '') {
      let item = itemIndex.get(resource);
      if (!item) {
        item = newItem(resource);
        itemIndex.set(resource, item);
      }
      itemHandleInfo(item, feature, value);
    }
  }
  // HashMap.values() order (see hashMapOrderKeys), then the stable sort below.
  const items = hashMapOrderKeys([...itemIndex.keys()]).map((k) => itemIndex.get(k)!);

  // --- CheckingReport.setParameters ---
  const defaultFixedFormat = pub.renditionLayout === 'pre-paginated';
  for (const item of items) {
    if (item.id === null || item.id === '') {
      item.id = 'ePubCheck.NoManifestRef:' + item.fileName;
    }
    if (item.isSpineItem) {
      if (item.renditionLayout === null || item.renditionLayout === '') {
        item.renditionLayout = pub.renditionLayout;
      }
      if (item.renditionOrientation === null || item.renditionOrientation === '') {
        item.renditionOrientation = pub.renditionOrientation;
      }
      if (item.renditionSpread === null || item.renditionSpread === '') {
        item.renditionSpread = pub.renditionSpread;
      }
      if (item.isFixedFormat === null) {
        item.isFixedFormat = defaultFixedFormat;
      }
    }
  }

  // --- CheckerMetadata.setMessageTypes (counts per message GROUP) ---
  let nFatal = 0, nError = 0, nWarning = 0, nUsage = 0;
  for (const m of messages) {
    if (m.severity === 'FATAL') nFatal++;
    else if (m.severity === 'ERROR') nError++;
    else if (m.severity === 'WARNING') nWarning++;
    else if (m.severity === 'USAGE') nUsage++;
  }

  // --- sortCollections ---
  items.sort((a, b) => scmp(a.id, b.id));
  messages.sort(checkMessageCompare);
  for (const m of messages) m.locations.sort(locationCompare);

  const checkDate = opts.checkDate instanceof Date
    ? formatCheckDate(opts.checkDate) : opts.checkDate;

  // --- assemble in Jackson's (observed, stable) property order ---
  const doc: JsonValue = {
    messages: messages.map((m): JsonValue => ({
      ID: m.ID,
      severity: m.severity,
      message: m.message,
      additionalLocations: m.additionalLocations,
      locations: m.locations.map((l): JsonValue => ({
        url: { opaque: false, hierarchical: true },
        path: l.path,
        line: l.line,
        column: l.column,
        context: l.context ?? null,
      })),
      suggestion: m.suggestion,
    })),
    customMessageFileName: null,
    checker: {
      path: `./${opts.filename}`,
      filename: opts.filename,
      checkerVersion: EPUBCHECK_VERSION,
      checkDate,
      elapsedTime: opts.elapsedTime,
      nFatal, nError, nWarning, nUsage,
    },
    publication: {
      publisher: pub.publisher,
      title: pub.title,
      creator: pub.creator,
      date: pub.date,
      subject: pub.subject,
      description: pub.description,
      rights: pub.rights,
      identifier: pub.identifier,
      language: pub.language,
      nSpines: pub.nSpines,
      checkSum: pub.checkSum,
      renditionLayout: pub.renditionLayout,
      renditionOrientation: pub.renditionOrientation,
      renditionSpread: pub.renditionSpread,
      ePubVersion: pub.ePubVersion,
      isScripted: pub.isScripted,
      hasFixedFormat: pub.hasFixedFormat,
      isBackwardCompatible: pub.isBackwardCompatible,
      hasAudio: pub.hasAudio,
      hasVideo: pub.hasVideo,
      charsCount: pub.charsCount,
      embeddedFonts: [...pub.embeddedFonts],
      refFonts: [...pub.refFonts],
      hasEncryption: pub.hasEncryption,
      hasSignatures: pub.hasSignatures,
      contributors: [...pub.contributors],
    },
    items: items.map((i): JsonValue => ({
      id: i.id,
      fileName: i.fileName,
      media_type: i.media_type,
      compressedSize: i.compressedSize,
      uncompressedSize: i.uncompressedSize,
      compressionMethod: i.compressionMethod,
      checkSum: i.checkSum,
      isSpineItem: i.isSpineItem,
      spineIndex: i.spineIndex,
      isLinear: i.isLinear,
      isFixedFormat: i.isFixedFormat,
      isScripted: i.isScripted,
      renditionLayout: i.renditionLayout,
      renditionOrientation: i.renditionOrientation,
      renditionSpread: i.renditionSpread,
      referencedItems: [...i.referencedItems].sort(scmp),
    })),
  };

  return jacksonSerialize(doc, 0);
}

// ---------------------------------------------------------------------------
// XML/XMP shared aggregation (XmlReportAbstract) and Saxon serialization
// ---------------------------------------------------------------------------

interface XmlAbstractState {
  epubCheckName: string;
  epubCheckVersion: string;
  epubCheckDate: string;
  creationDate: string | null;
  lastModifiedDate: string | null;
  identifier: string | null;
  titles: Set<string>;
  creators: Set<string>;
  contributors: Set<string>;
  subjects: Set<string>;
  publisher: string | null;
  rights: Set<string>;
  date: string | null;
  mediaTypes: Set<string>;
  formatName: string | null;
  formatVersion: string | null;
  pagesCount: number;
  charsCount: number;
  language: string | null;
  embeddedFonts: Set<string>;
  refFonts: Set<string>;
  references: Set<string>;
  hasEncryption: boolean;
  hasSignatures: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  hasFixedLayout: boolean;
  hasScripts: boolean;
  fatalErrors: CheckMessageGroup[];
  errors: CheckMessageGroup[];
  warns: CheckMessageGroup[];
  hints: CheckMessageGroup[];
}

/** XmlReportAbstract state + info() aggregation. */
function xmlAbstractAggregate(
  reportData: ReportData,
  mapPath: PathMapper['mapPath'],
  mapText: PathMapper['mapText'],
): XmlAbstractState {
  const st: XmlAbstractState = {
    epubCheckName: 'epubcheck',
    epubCheckVersion: EPUBCHECK_VERSION,
    epubCheckDate: '2012-10-31',
    creationDate: null, lastModifiedDate: null, identifier: null,
    titles: new Set(), creators: new Set(), contributors: new Set(),
    subjects: new Set(), publisher: null, rights: new Set(), date: null,
    mediaTypes: new Set(), formatName: null, formatVersion: null,
    pagesCount: 0, charsCount: 0, language: null,
    embeddedFonts: new Set(), refFonts: new Set(), references: new Set(),
    hasEncryption: false, hasSignatures: false, hasAudio: false,
    hasVideo: false, hasFixedLayout: false, hasScripts: false,
    fatalErrors: [], errors: [], warns: [], hints: [],
  };
  for (const tap of reportData.messages) {
    switch (tap.severity) {
      case 'FATAL': addCheckMessage(st.fatalErrors, tap, mapPath, mapText); break;
      case 'ERROR': addCheckMessage(st.errors, tap, mapPath, mapText); break;
      case 'WARNING': addCheckMessage(st.warns, tap, mapPath, mapText); break;
      case 'USAGE': addCheckMessage(st.hints, tap, mapPath, mapText); break;
      default: break; // INFO / SUPPRESSED dropped
    }
  }
  for (const { resource, feature, value } of reportData.features) {
    if (value === null) continue; // "Dont store 'null' values"
    switch (feature) {
      case 'TOOL_DATE': if (!value.startsWith('$')) st.epubCheckDate = value; break;
      case 'TOOL_NAME': st.epubCheckName = value; break;
      case 'TOOL_VERSION': st.epubCheckVersion = value; break;
      case 'FORMAT_NAME': st.formatName = value; break;
      case 'FORMAT_VERSION': st.formatVersion = value; break;
      case 'CREATION_DATE': st.creationDate = value; break;
      case 'MODIFIED_DATE': st.lastModifiedDate = value; break;
      case 'PAGES_COUNT': st.pagesCount = parseLong(value); break;
      case 'CHARS_COUNT': st.charsCount += parseLong(value); break;
      case 'DECLARED_MIMETYPE':
        st.mediaTypes.add(value);
        if (value.startsWith('audio/')) st.hasAudio = true;
        else if (value.startsWith('video/')) st.hasVideo = true;
        break;
      case 'FONT_EMBEDDED': st.embeddedFonts.add(value); break;
      case 'FONT_REFERENCE': st.refFonts.add(value); break;
      case 'REFERENCE': st.references.add(value); break;
      case 'DC_LANGUAGE': st.language = value; break;
      case 'DC_TITLE': st.titles.add(value); break;
      case 'DC_CREATOR': st.creators.add(value); break;
      case 'DC_CONTRIBUTOR': st.contributors.add(value); break;
      case 'DC_PUBLISHER': st.publisher = value; break;
      case 'DC_SUBJECT': st.subjects.add(value); break;
      case 'DC_RIGHTS': st.rights.add(value); break;
      case 'DC_DATE': st.date = value; break;
      case 'UNIQUE_IDENT': if (resource === null) st.identifier = value; break;
      case 'HAS_SIGNATURES': st.hasSignatures = true; break;
      case 'HAS_ENCRYPTION': st.hasEncryption = true; break;
      case 'HAS_FIXED_LAYOUT': st.hasFixedLayout = true; break;
      case 'HAS_SCRIPTS': st.hasScripts = true; break;
      default: break;
    }
  }
  return st;
}

/** XmlReportAbstract.getNameFromPath */
function getNameFromPath(path: string | null): string | null {
  if (path === null || path === undefined || path.length === 0) return null;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

/** XmlReportAbstract.capitalize */
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * XmlReportAbstract.correctToUtf8: ISO control chars (0x00-0x1F, 0x7F-0x9F)
 * except \r \n are replaced with "0x%x" (lowercase hex).
 */
function correctToUtf8(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const iso = c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    if (iso && ch !== '\r' && ch !== '\n') out += '0x' + c.toString(16);
    else out += ch;
  }
  return out;
}

/** Java String.trim (strips chars <= 0x20 from both ends). */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

// --- minimal DOM builder mirroring XmlReportAbstract's helpers --------------

type XmlAttr = [name: string, value: string];

interface XmlEl {
  name: string;
  attrs: XmlAttr[];
  children: XmlEl[];
  text: string | null;
}

class XmlBuilder {
  root: XmlEl | null = null;
  private stack: XmlEl[] = [];

  get current(): XmlEl {
    return this.stack[this.stack.length - 1]!;
  }

  startElement(name: string, ...attrs: XmlAttr[]): void {
    const el: XmlEl = { name, attrs: attrs.map(([k, v]) => [k, v]), children: [], text: null };
    if (this.stack.length === 0) this.root = el;
    else this.current.children.push(el);
    this.stack.push(el);
  }

  endElement(): void {
    this.stack.pop();
  }

  /** generateElement: skip when value null/blank; text is trim+correctToUtf8. */
  generateElement(name: string, value: string | null, ...attrs: XmlAttr[]): void {
    if (attrs.length === 0) {
      if (value === null || value === undefined || javaTrim(String(value)).length === 0) return;
      this.current.children.push({
        name, attrs: [], children: [], text: correctToUtf8(javaTrim(String(value))),
      });
      return;
    }
    // Attributed variant: element always emitted; text only when non-blank.
    const el: XmlEl = { name, attrs: attrs.map(([k, v]) => [k, v]), children: [], text: null };
    if (value !== null && value !== undefined && javaTrim(String(value)).length !== 0) {
      el.text = correctToUtf8(javaTrim(String(value)));
    }
    this.current.children.push(el);
  }
}

// --- Saxon-HE 11.4 XMLEmitter/XMLIndenter emulation -------------------------

function saxonEscapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x26) out += '&amp;';
    else if (c === 0x3c) out += '&lt;';
    else if (c === 0x3e) out += '&gt;';
    else if (c === 0x0d) out += '&#xD;';
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a) out += '&#x' + c.toString(16) + ';';
    else if ((c >= 0x7f && c < 0xa0) || c === 0x2028) out += '&#x' + c.toString(16) + ';';
    else out += s.charAt(i);
  }
  return out;
}

function saxonEscapeAttr(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x26) out += '&amp;';
    else if (c === 0x3c) out += '&lt;';
    else if (c === 0x3e) out += '&gt;';
    else if (c === 0x22) out += '&#34;';
    else if (c === 0x0a) out += '&#xA;';
    else if (c === 0x0d) out += '&#xD;';
    else if (c === 0x09) out += '&#x9;';
    else if (c < 0x20) out += '&#x' + c.toString(16) + ';';
    else if ((c >= 0x7f && c < 0xa0) || c === 0x2028) out += '&#x' + c.toString(16) + ';';
    else out += s.charAt(i);
  }
  return out;
}

/**
 * Serialize one element tree exactly as Saxon-HE 11.4 does for
 * transformer.setOutputProperty(INDENT, "yes") over a Xerces DOM:
 * - 3-space indentation; elements with a text child stay on one line;
 * - namespace declarations (from xmlns:* attrs) before attributes, sorted by
 *   prefix; attributes sorted by qualified name (Xerces NamedNodeMap order);
 * - Saxon's attribute-wrapping rule: when the summed length estimate exceeds
 *   80, every ns/attr after the first goes on its own line indented to
 *   depth*3 + 3 + name.length (XMLIndenter.startElement + XMLEmitter);
 * - trailing newline after the root end tag.
 */
function saxonSerialize(rootEl: XmlEl): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const write = (el: XmlEl, depth: number, inheritedNs: Map<string, string>): void => {
    const indent = '   '.repeat(depth);
    // Split ns declarations from ordinary attributes.
    const nsDecls: XmlAttr[] = [];
    const attrs: XmlAttr[] = [];
    for (const [k, v] of el.attrs) {
      if (k === 'xmlns') nsDecls.push(['', v]);
      else if (k.startsWith('xmlns:')) nsDecls.push([k.slice(6), v]);
      else attrs.push([k, v]);
    }
    // NamespaceReducer: drop re-declarations already in scope.
    const effectiveNs = nsDecls.filter(([p, u]) => inheritedNs.get(p) !== u);
    const scope = new Map(inheritedNs);
    for (const [p, u] of effectiveNs) scope.set(p, u);
    effectiveNs.sort((a, b) => scmp(a[0], b[0]));
    attrs.sort((a, b) => scmp(a[0], b[0]));

    // XMLIndenter's length estimate (namespaces + attributes).
    let len = 0;
    for (const [p, u] of effectiveNs) {
      len += p === '' ? 9 + u.length : p.length + 10 + u.length;
    }
    for (const [k, v] of attrs) {
      const colon = k.indexOf(':');
      const prefix = colon === -1 ? '' : k.slice(0, colon);
      const localPart = colon === -1 ? k : k.slice(colon + 1);
      len += localPart.length + String(v).length + 4 +
        (prefix === '' ? 4 : prefix.length + 5);
    }
    const wrap = len > 80;
    const attrIndent = ' '.repeat(depth * 3 + 3 + el.name.length);

    let line = indent + '<' + el.name;
    let first = true;
    const emitKv = (k: string, v: string): void => {
      const kv = `${k}="${saxonEscapeAttr(String(v))}"`;
      if (first) {
        line += ' ' + kv;
        first = false;
      } else if (wrap) {
        lines.push(line);
        line = attrIndent + kv;
      } else {
        line += ' ' + kv;
      }
    };
    for (const [p, u] of effectiveNs) emitKv(p === '' ? 'xmlns' : 'xmlns:' + p, u);
    for (const [k, v] of attrs) emitKv(k, v);

    if (el.children.length === 0 && el.text === null) {
      lines.push(line + '/>');
    } else if (el.children.length === 0) {
      lines.push(line + '>' + saxonEscapeText(el.text!) + '</' + el.name + '>');
    } else {
      lines.push(line + '>');
      for (const child of el.children) write(child, depth + 1, scope);
      lines.push(indent + '</' + el.name + '>');
    }
  };
  write(rootEl, 0, new Map());
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// XML report (XmlReportImpl, --out)
// ---------------------------------------------------------------------------

/** XmlReportImpl.generateProperty(String name, String[]|String|long|boolean) */
function generateProperty(
  x: XmlBuilder,
  name: string,
  value: string[] | string | null,
  type: string,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    x.startElement('property');
    x.generateElement('name', name);
    x.startElement('values',
      ['arity', value.length === 1 ? 'Scalar' : 'Array'], ['type', type]);
    for (const v of value) x.generateElement('value', v);
    x.endElement();
    x.endElement();
    return;
  }
  if (value === null || value === undefined || javaTrim(String(value)).length === 0) return;
  x.startElement('property');
  x.generateElement('name', name);
  x.startElement('values', ['arity', 'Scalar'], ['type', type]);
  x.generateElement('value', String(value));
  x.endElement();
  x.endElement();
}

const generateLongProperty = (x: XmlBuilder, name: string, value: number): void => {
  if (value !== 0) generateProperty(x, name, String(value), 'Long');
};
const generateBooleanProperty = (x: XmlBuilder, name: string, value: boolean): void => {
  generateProperty(x, name, value ? 'true' : 'false', 'Boolean');
};

function xmlMessages(
  x: XmlBuilder,
  list: CheckMessageGroup[],
  sevLabel: string,
  sevAttr: string,
): void {
  for (const c of list) {
    const m = `${c.ID}, ${sevLabel}, [${c.message}], `;
    for (const ml of c.locations) {
      let loc = '';
      if (ml.line > 0 || ml.column > 0) loc = ` (${ml.line}-${ml.column})`;
      x.generateElement('message', m + ml.path + loc,
        ['id', c.ID], ['severity', sevAttr]);
    }
  }
}

/**
 * Format the XML report -- byte-identical to `epubcheck --out`
 * (com.adobe.epubcheck.util.XmlReportImpl rendered by Saxon-HE 11.4).
 */
export function formatXmlReport(reportData: ReportData, options: FormatterOptions): string {
  const opts = resolveOptions(options);
  const { mapPath, mapText } = makePathMapper(opts.filename);
  const st = xmlAbstractAggregate(reportData, mapPath, mapText);
  const generationDate = opts.generationDate instanceof Date
    ? formatGenerationDate(opts.generationDate) : opts.generationDate;

  const x = new XmlBuilder();
  x.startElement('jhove',
    ['xmlns', 'http://schema.openpreservation.org/ois/xml/ns/jhove'],
    ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
    ['name', st.epubCheckName],
    ['release', st.epubCheckVersion],
    ['date', st.epubCheckDate],
    ['xsi:schemaLocation', 'http://schema.openpreservation.org/ois/xml/ns/jhove https://schema.openpreservation.org/ois/xml/xsd/jhove/jhove.xsd']);
  x.generateElement('date', generationDate);
  x.startElement('repInfo', ['uri', opts.filename]);
  x.generateElement('created', st.creationDate);
  x.generateElement('lastModified', st.lastModifiedDate);
  x.generateElement('format', st.formatName === null ? 'application/octet-stream' : st.formatName);
  x.generateElement('version', st.formatVersion);
  x.generateElement('status',
    st.fatalErrors.length === 0 && st.errors.length === 0 ? 'Well-formed' : 'Not well-formed');
  if (st.warns.length || st.fatalErrors.length || st.errors.length || st.hints.length) {
    x.startElement('messages');
    xmlMessages(x, st.fatalErrors, 'FATAL', 'error');
    xmlMessages(x, st.errors, 'ERROR', 'error');
    xmlMessages(x, st.warns, 'WARN', 'warning');
    xmlMessages(x, st.hints, 'HINT', 'info');
    x.endElement();
  }
  x.generateElement('mimeType', st.formatName);
  x.startElement('properties');
  generateProperty(x, 'FileName', getNameFromPath(opts.filename), 'String');
  generateLongProperty(x, 'PageCount', st.pagesCount);
  generateLongProperty(x, 'CharacterCount', st.charsCount);
  generateProperty(x, 'Language', st.language, 'String');

  x.startElement('property');
  x.generateElement('name', 'Info');
  x.startElement('values', ['arity', 'List'], ['type', 'Property']);
  generateProperty(x, 'Identifier', st.identifier, 'String');
  generateProperty(x, 'CreationDate', st.creationDate, 'Date');
  generateProperty(x, 'ModDate', st.lastModifiedDate, 'Date');
  if (st.titles.size) generateProperty(x, 'Title', [...st.titles], 'String');
  if (st.creators.size) generateProperty(x, 'Creator', [...st.creators], 'String');
  if (st.contributors.size) generateProperty(x, 'Contributor', [...st.contributors], 'String');
  generateProperty(x, 'Date', st.date, 'String');
  generateProperty(x, 'Publisher', st.publisher, 'String');
  if (st.subjects.size) generateProperty(x, 'Subject', [...st.subjects], 'String');
  if (st.rights.size) generateProperty(x, 'Rights', [...st.rights], 'String');
  x.endElement();
  x.endElement();

  if (st.embeddedFonts.size || st.refFonts.size) {
    x.startElement('property');
    x.generateElement('name', 'Fonts');
    x.startElement('values', ['arity', 'List'], ['type', 'Property']);
    for (const f of st.embeddedFonts) {
      x.startElement('property');
      x.generateElement('name', 'Font');
      x.startElement('values', ['arity', 'List'], ['type', 'Property']);
      generateProperty(x, 'FontName', getNameFromPath(f), 'String');
      generateBooleanProperty(x, 'FontFile', true);
      x.endElement();
      x.endElement();
    }
    for (const f of st.refFonts) {
      x.startElement('property');
      x.generateElement('name', 'Font');
      x.startElement('values', ['arity', 'List'], ['type', 'Property']);
      generateProperty(x, 'FontName', getNameFromPath(f), 'String');
      generateBooleanProperty(x, 'FontFile', false);
      x.endElement();
      x.endElement();
    }
    x.endElement();
    x.endElement();
  }

  if (st.references.size) {
    x.startElement('property');
    x.generateElement('name', 'References');
    x.startElement('values', ['arity', 'List'], ['type', 'Property']);
    for (const r of st.references) generateProperty(x, 'Reference', r, 'String');
    x.endElement();
    x.endElement();
  }
  if (st.mediaTypes.size) generateProperty(x, 'MediaTypes', [...st.mediaTypes], 'String');

  if (st.hasEncryption) generateBooleanProperty(x, 'hasEncryption', true);
  if (st.hasSignatures) generateBooleanProperty(x, 'hasSignatures', true);
  if (st.hasAudio) generateBooleanProperty(x, 'hasAudio', true);
  if (st.hasVideo) generateBooleanProperty(x, 'hasVideo', true);
  if (st.hasFixedLayout) generateBooleanProperty(x, 'hasFixedLayout', true);
  if (st.hasScripts) generateBooleanProperty(x, 'hasScripts', true);

  x.endElement(); // properties
  x.endElement(); // repInfo
  x.endElement(); // jhove

  return saxonSerialize(x.root!);
}

// ---------------------------------------------------------------------------
// XMP report (XmpReportImpl, --xmp)
// ---------------------------------------------------------------------------

/** XmpReportImpl.generateFont */
function xmpFont(x: XmlBuilder, font: string): void {
  const elFont = String(font).split(',');
  const attrs: XmlAttr[] = [['stFnt:fontFamily', capitalize(elFont[0]!)]];
  let fontFace = '';
  for (let i = 1; i < elFont.length; i++) fontFace += capitalize(elFont[i]!) + ' ';
  fontFace = javaTrim(fontFace);
  attrs.push(['stFnt:fontFace', fontFace.length === 0 ? 'Regular' : fontFace]);
  x.generateElement('rdf:li', null, ...attrs);
}

function xmpEventOutcome(x: XmlBuilder, list: CheckMessageGroup[], sev: string): void {
  for (const c of list) {
    x.startElement('rdf:li', ['rdf:parseType', 'Resource']);
    x.generateElement('premis:hasEventOutcome', `${c.ID}, ${sev}, ${c.message}`);
    if (c.locations.length !== 0) {
      x.startElement('premis:hasEventOutcomeDetail');
      x.startElement('rdf:Seq');
      let previousValue = '';
      for (const ml of c.locations) {
        let value = ml.path;
        if (ml.line > 0 || ml.column > 0) value += ` (${ml.line}-${ml.column})`;
        if (previousValue !== value) {
          x.generateElement('rdf:li', null, ['premis:hasEventOutcomeDetailNote', value]);
          previousValue = value;
        }
      }
      x.endElement();
      x.endElement();
    }
    x.endElement();
  }
}

/**
 * Format the XMP report -- byte-identical to `epubcheck --xmp`
 * (com.adobe.epubcheck.util.XmpReportImpl rendered by Saxon-HE 11.4).
 */
export function formatXmpReport(reportData: ReportData, options: FormatterOptions): string {
  const opts = resolveOptions(options);
  const { mapPath, mapText } = makePathMapper(opts.filename);
  const st = xmlAbstractAggregate(reportData, mapPath, mapText);
  const generationDate = opts.generationDate instanceof Date
    ? formatGenerationDate(opts.generationDate) : opts.generationDate;

  const x = new XmlBuilder();
  x.startElement('x:xmpmeta',
    ['xmlns:x', 'adobe:ns:meta/'],
    ['x:xmptk', 'Adobe XMP Core 5.1.0-jc003']);
  x.startElement('rdf:RDF', ['xmlns:rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#']);
  const attrs: XmlAttr[] = [
    ['rdf:about', ''],
    ['xmlns:dc', 'http://purl.org/dc/elements/1.1/'],
    ['xmlns:xmp', 'http://ns.adobe.com/xap/1.0/'],
    ['xmlns:xmpTPg', 'http://ns.adobe.com/xap/1.0/t/pg/'],
    ['xmlns:stFnt', 'http://ns.adobe.com/xap/1.0/sType/Font#'],
    ['xmlns:extended-properties',
      'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties/'],
    ['xmlns:premis', 'http://www.loc.gov/premis/rdf/v1#'],
  ];
  if (st.formatName === null) {
    attrs.push(['dc:format', 'application/octet-stream']);
  } else if (st.formatVersion === null) {
    attrs.push(['dc:format', st.formatName]);
  } else {
    attrs.push(['dc:format', `${st.formatName};version=${st.formatVersion}`]);
  }
  if (st.creationDate !== null) attrs.push(['xmp:CreateDate', st.creationDate]);
  if (st.charsCount !== 0) attrs.push(['extended-properties:Characters', String(st.charsCount)]);
  if (st.pagesCount !== 0) attrs.push(['xmpTPg:NPages', String(st.pagesCount)]);
  if (st.publisher !== null) attrs.push(['dc:publisher', st.publisher]);
  attrs.push(['dc:identifier', st.identifier === null ? '' : st.identifier]);
  if (st.language !== null) attrs.push(['dc:language', st.language]);
  x.startElement('rdf:Description', ...attrs);

  if (st.creators.size) {
    x.startElement('dc:creator');
    x.startElement('rdf:Seq');
    for (const creator of st.creators) x.generateElement('rdf:li', creator);
    x.endElement();
    x.endElement();
  }
  if (st.titles.size) {
    x.startElement('dc:title');
    x.startElement('rdf:Alt');
    let firstTitle = true;
    for (const title of st.titles) {
      if (firstTitle) {
        x.generateElement('rdf:li', javaTrim(title), ['xml:lang', 'x-default']);
        firstTitle = false;
      } else {
        x.generateElement('rdf:li', title);
      }
    }
    x.endElement();
    x.endElement();
  }
  if (st.subjects.size) {
    x.startElement('dc:subject');
    x.startElement('rdf:Bag');
    for (const subject of st.subjects) x.generateElement('rdf:li', subject);
    x.endElement();
    x.endElement();
  }

  if (st.embeddedFonts.size || st.refFonts.size) {
    x.startElement('xmpTPg:Fonts');
    x.startElement('rdf:Bag');
    for (const font of st.embeddedFonts) xmpFont(x, font);
    for (const font of st.refFonts) xmpFont(x, font);
    x.endElement();
    x.endElement();
  }

  x.startElement('premis:hasEvent', ['rdf:parseType', 'Resource']);
  x.generateElement('premis:hasEventDateTime', String(generationDate),
    ['rdf:datatype', 'http://www.w3.org/2001/XMLSchema#dateTime']);
  x.generateElement('premis:hasEventType', null,
    ['rdf:resource', 'http://id.loc.gov/vocabulary/preservation/eventType/val']);
  x.generateElement('premis:hasEventDetail',
    st.fatalErrors.length === 0 && st.errors.length === 0 ? 'Well-formed' : 'Not well-formed');
  if (st.fatalErrors.length + st.errors.length + st.warns.length + st.hints.length !== 0) {
    x.startElement('premis:hasEventOutcomeInformation');
    x.startElement('rdf:Seq');
    xmpEventOutcome(x, st.fatalErrors, 'FATAL');
    xmpEventOutcome(x, st.errors, 'ERROR');
    xmpEventOutcome(x, st.warns, 'WARN');
    xmpEventOutcome(x, st.hints, 'HINT');
    x.endElement();
    x.endElement();
  }
  x.startElement('premis:hasEventRelatedAgent', ['rdf:parseType', 'Resource']);
  x.generateElement('premis:hasAgentType', null,
    ['rdf:resource', 'http://id.loc.gov/vocabulary/preservation/agentType/sof']);
  x.generateElement('premis:hasAgentName',
    st.epubCheckVersion === null ? st.epubCheckName : `${st.epubCheckName} ${st.epubCheckVersion}`);
  x.endElement();
  x.endElement(); // premis:hasEvent

  x.startElement('premis:hasSignificantProperties');
  x.startElement('rdf:Bag');
  const sig = (property: string, value: string): void => x.generateElement('rdf:li', null,
    ['premis:hasSignificantPropertiesType', property],
    ['premis:hasSignificantPropertiesValue', value]);
  sig('renditionLayout', st.hasFixedLayout ? 'fixed-layout' : 'reflowable');
  sig('isScripted', String(st.hasScripts));
  sig('hasEncryption', String(st.hasEncryption));
  sig('hasAudio', String(st.hasAudio));
  sig('hasVideo', String(st.hasVideo));
  sig('hasSignatures', String(st.hasSignatures));
  sig('hasAllFontsEmbedded', String(st.refFonts.size === 0));
  let nRefs = 0;
  for (const ref of st.references) {
    nRefs++;
    if (nRefs > 50) {
      sig('reference', `${st.references.size - 50} more references`);
      break;
    }
    sig('reference', ref);
  }
  x.endElement();
  x.endElement(); // premis:hasSignificantProperties

  x.endElement(); // rdf:Description
  x.endElement(); // rdf:RDF
  x.endElement(); // x:xmpmeta

  return saxonSerialize(x.root!);
}

// ---------------------------------------------------------------------------
// Console report (DefaultReportImpl + EpubChecker, the human-readable output)
// ---------------------------------------------------------------------------
// The console renderer lives in a sibling module so this file stays focused on
// the three document writers; it is re-exported here so all formatters share
// one import site (`epubcheck-standalone/formatters`). It imports the report
// types from this module (type-only, so there is no runtime import cycle).
export {
  ReportingLevel,
  severityReportingLevel,
  fixConsoleMessage,
  renderConsoleMessageLine,
  countConsoleSeverities,
  displayedConsoleCounts,
  renderValidatingLine,
  renderConsoleSummaryLine,
  formatTemplate,
  formatConsoleReport,
  DEFAULT_CONSOLE_LABELS,
} from './console.js';
export type { ConsoleCounts, ConsoleLabels, ConsoleFormatterOptions } from './console.js';

import { formatConsoleReport } from './console.js';

export default { formatJsonReport, formatXmlReport, formatXmpReport, formatConsoleReport };
