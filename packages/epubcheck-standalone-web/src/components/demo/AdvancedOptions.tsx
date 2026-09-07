import {
  Button,
  Collapse,
  Input,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { useRef } from "react";
import type { ChangeEvent } from "react";
import { m } from "../../paraglide/messages.js";
import {
  EXAMPLE_CUSTOM_MESSAGES,
  LOCALES,
  PROFILES,
  VERSIONS,
} from "./constants";
// The complete --listChecks message dictionary (every check at its default
// severity), copied verbatim from the CLI package's generated data.
import { LIST_CHECKS_TSV } from "./list-checks-data";

const { Text } = Typography;

interface AdvancedOptionsProps {
  profile: string;
  setProfile: (value: string) => void;
  locale: string;
  setLocale: (value: string) => void;
  version: string;
  setVersion: (value: string) => void;
  showUsage: boolean;
  setShowUsage: (value: boolean) => void;
  customMessages: string;
  setCustomMessages: (value: string) => void;
  validating: boolean;
}

export function AdvancedOptions({
  profile,
  setProfile,
  locale,
  setLocale,
  version,
  setVersion,
  showUsage,
  setShowUsage,
  customMessages,
  setCustomMessages,
  validating,
}: AdvancedOptionsProps) {
  // Hidden file input the "Select file" button drives (same plain-input +
  // button pattern InputCard uses for the EPUB pickers, no Upload component and
  // no filename display). Picking a file autofills the textarea with its text
  // content, which the user can then edit freely.
  const customMessagesInputRef = useRef<HTMLInputElement>(null);
  const handleCustomMessagesPicked = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Reset so picking the same file again re-fires change.
    input.value = "";
    if (file) setCustomMessages(await file.text());
  };
  return (
    /* Advanced options — every knob lives here, closed by default, ghost
        styling to stay quiet. Selections build the epubcheck `args` list;
        leaving every control at its default produces an empty args array,
        identical to the plain run. */
    <Collapse
      ghost
      style={{ marginTop: 8 }}
      // Collapsed, the only bottom spacing is the card body's 8px set
      // above, which stays subtle. Expanded, the panel's content box adds
      // its own 20px (via the specificity-matched global rule in
      // index.astro, since the antd content box is client-rendered) on top
      // of the card body's 8px, so the open panel gets a roomier 28px
      // below its last control.
      className="advanced-options-collapse"
      items={[
        {
          key: "advanced",
          label: m.advanced_options(),
          children: (
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
              <div>
                <Text strong style={{ display: "block", marginBottom: 8 }}>
                  {m.label_profile()}
                </Text>
                <Radio.Group
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  disabled={validating}
                  style={{ width: "100%" }}
                >
                  <Space direction="vertical" style={{ width: "100%" }}>
                    {PROFILES.map((p) => (
                      <Radio key={p.value} value={p.value}>
                        <Text style={{ fontWeight: 600 }}>{p.title}</Text>
                        <Text type="secondary" style={{ marginLeft: 8 }}>
                          {p.description}
                        </Text>
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </div>

              <div>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <Text strong>{m.label_language()}</Text>
                  <Select
                    style={{ width: 220 }}
                    value={locale}
                    onChange={setLocale}
                    options={LOCALES}
                    disabled={validating}
                  />
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    marginBottom: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <Text strong>{m.label_epub_version()}</Text>
                  <Select
                    style={{ width: 100 }}
                    value={version}
                    onChange={setVersion}
                    options={VERSIONS.map((v) => ({
                      value: v,
                      label: v,
                    }))}
                    disabled={validating}
                  />
                </div>
                <Text type="secondary">{m.help_epub_version()}</Text>
              </div>

              <div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <Text style={{ fontWeight: 600 }}>{m.label_show_usage()}</Text>
                  <Switch
                    size="small"
                    checked={showUsage}
                    onChange={setShowUsage}
                    disabled={validating}
                  />
                </div>
                <Text type="secondary">{m.help_show_usage()}</Text>
              </div>

              <div>
                {/* Title + the two loaders share one line, same row structure
                    the Language / EPUB version options use (label and controls
                    on the same line, wrapping on narrow widths). */}
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    marginBottom: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <Text strong>{m.label_custom_messages()}</Text>
                  <Button
                    disabled={validating}
                    onClick={() => customMessagesInputRef.current?.click()}
                  >
                    {m.button_select_custom_messages()}
                  </Button>
                  <Button
                    disabled={validating}
                    onClick={() => setCustomMessages(EXAMPLE_CUSTOM_MESSAGES)}
                  >
                    {m.button_load_minimal_example()}
                  </Button>
                  <Button
                    disabled={validating}
                    onClick={() => setCustomMessages(LIST_CHECKS_TSV)}
                  >
                    {m.button_load_full_example()}
                  </Button>
                </div>
                <Text type="secondary">{m.help_custom_messages()}</Text>
                {/* Full-width auto-growing textarea holding the override TSV.
                    Its text is what the run passes as customMessages; empty =
                    nothing passed. allowClear gives the antd-standard clear. */}
                <Input.TextArea
                  value={customMessages}
                  onChange={(e) => setCustomMessages(e.target.value)}
                  placeholder={m.custom_messages_placeholder()}
                  autoSize
                  allowClear
                  disabled={validating}
                  style={{ marginTop: 8, fontFamily: "monospace" }}
                />
                <input
                  ref={customMessagesInputRef}
                  type="file"
                  accept=".txt,.tsv,text/plain,text/tab-separated-values"
                  hidden
                  onChange={handleCustomMessagesPicked}
                />
              </div>
            </Space>
          ),
        },
      ]}
    />
  );
}
