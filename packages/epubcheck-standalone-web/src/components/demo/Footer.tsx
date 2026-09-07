import { Space, Typography } from "antd";
import { GithubOutlined } from "@ant-design/icons";
import { m } from "../../paraglide/messages.js";
import { ENGINE_VERSION, GITHUB_URL, NPM_URL, NpmIcon } from "./constants";

const { Paragraph, Text, Link } = Typography;

export function Footer({
  tokenColors,
}: {
  tokenColors: Record<string, string>;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        marginTop: 24,
      }}
    >
      <Paragraph type="secondary" style={{ margin: 0 }}>
        {m.footer_intro()} <Text code>epubcheck-standalone</Text>{" "}
        {m.footer_library_line({ version: ENGINE_VERSION })}
      </Paragraph>
      {/* npm + GitHub links, rendered in secondary dark grey (not black).
          Both glyphs inherit the grey — the npm SVG fills currentColor. */}
      <Space
        size="middle"
        style={{
          flexShrink: 0,
          fontSize: 20,
          color: tokenColors.colorTextSecondary,
        }}
      >
        <Link
          href={GITHUB_URL}
          target="_blank"
          aria-label={m.aria_github()}
          style={{ color: "inherit", display: "inline-flex", fontSize: 20 }}
        >
          <GithubOutlined />
        </Link>
        <Link
          href={NPM_URL}
          target="_blank"
          aria-label={m.aria_npm()}
          style={{ color: "inherit", display: "inline-flex" }}
        >
          <NpmIcon />
        </Link>
      </Space>
    </div>
  );
}
