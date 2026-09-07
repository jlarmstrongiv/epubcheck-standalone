# epubcheck-standalone-cli

[![npm version](https://img.shields.io/npm/v/epubcheck-standalone-cli)](https://www.npmjs.com/package/epubcheck-standalone-cli) [![npm downloads](https://img.shields.io/npm/dm/epubcheck-standalone-cli)](https://www.npmjs.com/package/epubcheck-standalone-cli)

The official EPUBCheck command line, with no Java to install. It mirrors EPUBCheck's own CLI: the same flags, console text, JSON, XML, and XMP report files, and exit codes. Under the hood it runs the [epubcheck-standalone](https://github.com/jlarmstrongiv/epubcheck-standalone/blob/main/packages/epubcheck-standalone/README.md) engine, EPUBCheck compiled to plain JavaScript with TeaVM, so output matches the Java tool byte for byte.

- Validate an EPUB from your terminal with one command
- No Java, no install: run it straight from `npx`
- Same flags and same output as the official epubcheck CLI
- Writes the same JSON, XML, and XMP report files
- Your ebook never leaves your machine

## Quickstart

```sh
npx epubcheck-standalone-cli book.epub
```

That prints the same report the official EPUBCheck prints:

```
Validating using EPUB version 3.3 rules.
No errors or warnings detected.
Messages: 0 fatals / 0 errors / 0 warnings / 0 infos

EPUBCheck completed
```

Install it in a project and call it by its bin name `epubcheck-standalone-cli`. It needs Node.js LTS or newer.

Validate a remote book by URL:

```sh
npx epubcheck-standalone-cli https://example.com/book.epub
```

The URL itself is the input, exactly like the official tool given a URL, so message locations reference the URL.

## Flags

Same short and long forms as the official EPUBCheck CLI.

| Flag | What it does |
| --- | --- |
| `-j`, `--json <file>` | Write a JSON report to `<file>`. Use `-` for the console. |
| `-o`, `--out <file>` | Write an XML report to `<file>`. Use `-` for the console. |
| `-x`, `--xmp <file>` | Write an XMP report to `<file>`. Use `-` for the console. |
| `-q`, `--quiet` | Silence normal stdout. Message lines, the summary, and any requested report still print. |
| `-f`, `--fatal` | Show fatal messages only. |
| `-e`, `--error` | Show error and fatal messages. |
| `-w`, `--warn` | Show warning, error, and fatal messages. |
| `-i`, `--info` | Show messages down to info level (the default). |
| `-u`, `--usage` | Show usage-level messages too, the most detailed level. |
| `-m`, `--mode <type>` | Validate a single file of the given type: `xhtml`, `opf`, `svg`, `mo`, `nav`. Pair with `-v` to set the EPUB version. |
| `-p`, `--profile <name>` | Validate against a profile: `default`, `dict`, `edupub`, `idx`, `preview`. |
| `-s`, `--save` | With `--mode exp`, keep the packaged `.epub` the check builds, written next to the input directory. A check that finds errors deletes it again and says so, like the official tool. |
| `--locale <tag>` | Show messages in the given language (see below). |
| `--failonwarnings` | Exit `1` on warnings, not just errors. |
| `-l`, `--listChecks [<file>]` | Write message ids and severities to `<file>` or the console. Does not validate a book. |
| `-c`, `--customMessages <file>` | Override message severities from a tab-separated file, to promote, demote, suppress, or reword messages. Pass `none` to turn overrides off. |
| `--version` | Print the EPUBCheck version, in the `EPUBCheck v<version>` format. |
| `-h`, `-?`, `--help` | Print the help text. |

Only one report format can be requested per run. Asking for two is an error, the same as the official tool.

`-v <2.0|3.0>` is accepted so existing scripts keep working, but it does nothing for an `.epub` file: EPUBCheck reads the version from the book itself and the official tool ignores it too. It is separate from `--version`.

The saved `.epub` from `--save` matches the official tool's structurally: the same files in the same order, the same checksums, sizes, and timestamps, and `mimetype` stored first. The compressed bytes inside differ, because Node.js and Java ship different compressors. A directory whose packaged form passes 4 GB is written as a valid ZIP64 `.epub`, the same archive the official tool produces.

## Languages

`--locale` takes any tag from this list. Untranslated message text falls back to English, exactly as in the official tool.

| Tag | Language |
| --- | --- |
| `da` | Danish |
| `de` | German |
| `en` | English (the default) |
| `es` | Spanish |
| `fr` | French |
| `it` | Italian |
| `ja` | Japanese |
| `ko-KR` | Korean |
| `nl` | Dutch |
| `pt-BR` | Portuguese (Brazil) |
| `zh-TW` | Chinese (Traditional) |

A region added to one of these languages works too and behaves exactly like the official tool: it resolves to the language above by dropping the region. So `en-US` and `en-GB` show English, `fr-FR` shows French, `de-DE` shows German. Case and separator do not matter (`fr_FR`, `FR-fr`, and `fr-FR` are the same tag).

These tags are refused (exit `2`): a bare `ko`, `pt`, or `zh` (those languages ship only with a region), and any language not in the list, such as `pl` or `ru`. The official tool falls back to English for those, but that fallback depends on the host machine's default language, so its result is not guaranteed to be the same on every machine. This tool refuses those tags rather than risk output that differs from the official tool. The `--listChecks` list is the one exception: like the official tool it never refuses a locale there, and an unsupported tag simply falls back to English.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Valid. No errors, no fatals. Also `0` when the only messages are warnings, unless you passed `--failonwarnings`. |
| `1` | Errors or fatals found. Also `1` for a bad argument, a missing file, or a validation failure. |
| `2` | You passed a valid EPUBCheck flag this engine cannot support. The tool stops with a clear message rather than print output that would differ from the official tool. |

Codes `0` and `1` match the official EPUBCheck. Code `2` is specific to this tool, and the only flag that triggers it is a `--locale` tag outside the list above (see Languages). Everything else works: single-file `--mode` checks, expanded directories (`--mode exp`), all profiles, every shipped language, custom message overrides, and URL inputs. Validating a plain `.epub` needs none of these flags.

## Relation to the library

This tool is a thin command-line front end over the [epubcheck-standalone](https://github.com/jlarmstrongiv/epubcheck-standalone/blob/main/packages/epubcheck-standalone/README.md) library. The library is the engine; this package reproduces EPUBCheck's argument handling, console text, and exit codes on top of it. To validate EPUBs from your own code, use the library directly.

## Versioning

The version is the upstream EPUBCheck release baked into the engine, then a build number for this packaging. Same scheme as the library, explained in its [versioning section](https://github.com/jlarmstrongiv/epubcheck-standalone/blob/main/packages/epubcheck-standalone/README.md#versioning).

## License

BSD-3-Clause, the same license as EPUBCheck.
