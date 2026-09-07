import { Select, Space, Typography } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { m } from "../../paraglide/messages.js";
import { getLocale, setLocale, type Locale } from "../../paraglide/runtime.js";
import { PACKAGE_VERSION } from "./constants";
import { UI_LOCALES, localeLabel } from "./locales";

const { Title, Paragraph, Text, Link } = Typography;

// Quiet UI-language switcher: a borderless Select flagged with a globe. It lists
// only the locales that have a message catalog on disk (UI_LOCALES), so today it
// shows just English and grows on its own as catalogs are added. Choosing a
// locale calls Paraglide's setLocale, which persists the choice to localStorage
// and reloads the page (setLocale's documented default for a client-rendered,
// non-URL-routed surface); getLocale() then reflects the stored choice. The
// matching engine language is preselected on that reload (see EpubcheckDemo).
function LocaleSwitcher() {
  return (
    // The globe is a LEADING sibling of the Select, not its suffix slot: antd's
    // suffix does not reserve room for a 20px glyph and collapsed the gap once the
    // icon grew to the marketing size. A flex row with center alignment keeps the
    // globe and the language name vertically centered and reading as one control.
    // The Select's own left padding (~8px) is cancelled with a negative margin
    // below so the visible globe-to-text gap is exactly this one `gap` value.
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
    >
      {/* Standalone globe at the marketing icon size (20px, matching the
          FeatureGrid feature-bullet icons), one step lighter than the adjacent
          value text: the Select value uses antd's default colorText
          rgba(0,0,0,0.88) (the demo only overrides colorTextDescription, which
          does not touch it), so the globe is the same black at 90% of that alpha
          (0.79) — close to the text, just a touch lighter. display:block drops
          the glyph's inline descender so it centers cleanly against the value. */}
      <GlobalOutlined
        style={{ color: "rgba(0, 0, 0, 0.79)", fontSize: 20, display: "block" }}
      />
      <Select<Locale>
        size="small"
        variant="borderless"
        // Cancel the borderless selector's intrinsic ~8px left padding so the
        // only visible gap to the globe is the flex `gap` above.
        style={{ marginLeft: -8 }}
        value={getLocale()}
        onChange={(value) => {
          void setLocale(value);
        }}
        popupMatchSelectWidth={false}
        aria-label={m.label_ui_language()}
        options={UI_LOCALES.map((locale) => ({
          value: locale,
          label: localeLabel(locale),
        }))}
      />
    </span>
  );
}

export function Header() {
  return (
    <Typography>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 4,
        }}
      >
        <Space align="baseline" wrap>
          <Title level={1} style={{ marginBottom: 0 }}>
            epubcheck-standalone
          </Title>
          <Text type="secondary">{PACKAGE_VERSION}</Text>
        </Space>
        <LocaleSwitcher />
      </div>
      <Paragraph type="secondary">
        {m.intro_the()}{" "}
        <Link href="https://www.w3.org/publishing/epubcheck/" target="_blank">
          {m.link_w3c_epubcheck()}
        </Link>{" "}
        {m.intro_after_link()} <Text code>.epub</Text>{" "}
        {m.intro_after_code()}
      </Paragraph>
    </Typography>
  );
}
