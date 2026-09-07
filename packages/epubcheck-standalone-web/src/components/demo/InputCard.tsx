import {
  Button,
  Card,
  Col,
  Input,
  Row,
  Space,
  theme,
  Typography,
  Upload,
} from "antd";
import type { UploadProps } from "antd";
import {
  FileTextOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  LoadingOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { ChangeEvent, RefObject } from "react";
import { m } from "../../paraglide/messages.js";
import { ACCEPT, SAMPLES } from "./constants";
import { VERDICT } from "./verdict";
import { AdvancedOptions } from "./AdvancedOptions";

const { Text } = Typography;

interface InputCardProps {
  tokenColors: Record<string, string>;
  validating: boolean;
  /** Engine pre-warm in flight (page load / post-crash re-warm). */
  initializing: boolean;
  /** Cancel the in-flight run. Shown only while validating. */
  onCancel: () => void;
  uploadProps: UploadProps;
  runSample: (name: string) => void;
  fileInputRef: RefObject<HTMLInputElement>;
  folderInputRef: RefObject<HTMLInputElement>;
  handleFilePicked: (event: ChangeEvent<HTMLInputElement>) => void;
  handleFolderPicked: (event: ChangeEvent<HTMLInputElement>) => void;
  url: string;
  setUrl: (value: string) => void;
  runUrl: () => void;
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
}

export function InputCard({
  tokenColors,
  validating,
  initializing,
  onCancel,
  uploadProps,
  runSample,
  fileInputRef,
  folderInputRef,
  handleFilePicked,
  handleFolderPicked,
  url,
  setUrl,
  runUrl,
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
}: InputCardProps) {
  // Live theme token, so the status slot's spacing rides the SAME antd values
  // the surrounding drop-area lines use (no magic numbers): antd styles
  // p.ant-upload-text with `margin: 0 0 marginXXS` and p.ant-upload-hint with
  // no margin, so consecutive text lines sit marginXXS apart. Giving the status
  // slot the same marginXXS bottom margin makes the status→text gap identical
  // to the text→hint gap. colorPrimary is the exact token antd paints
  // .ant-upload-drag-icon with, so the status text/link and the icon share one
  // blue that can never drift.
  const { token } = theme.useToken();
  return (
    <Card style={{ marginBottom: 16 }} styles={{ body: { paddingBottom: 8 } }}>
      {/* Samples row — above the dropzone, full width, no side label. The
          button labels carry the meaning; three equal columns on wide
          screens, stacked full-width buttons on narrow ones. */}
      <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
        {SAMPLES.map((s) => {
          const v = VERDICT[s.verdict];
          return (
            <Col key={s.file} xs={24} sm={8}>
              <Button
                block
                icon={
                  <span style={{ color: tokenColors[v.tokenKey] }}>
                    {v.icon}
                  </span>
                }
                onClick={() => runSample(s.file)}
                disabled={validating}
              >
                {s.label}
              </Button>
            </Col>
          );
        })}
      </Row>

      <Upload.Dragger {...uploadProps} style={{ padding: "16px 0" }}>
        {/* The drop-area content is one flex column with a SINGLE uniform gap
            (token.margin) and every child's own margin zeroed, so the four rows
            — icon, status, dropzone text, hint — are evenly spaced by
            construction. This deliberately replaces antd's per-element margins:
            antd only sets a bottom margin on the icon/text lines and leaves the
            hint <p> at the browser's default 1em (14px) top margin, so relying
            on those margins (and their collapsing) produced uneven gaps
            (status→text 4px vs text→hint 14px). One flex gap with zeroed child
            margins is deterministic and cannot drift. Wrapping the children
            keeps them inside .ant-upload-drag-container, so a click anywhere
            still bubbles to the Dragger and opens the picker. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            rowGap: token.margin,
          }}
        >
          {/* The drop-zone icon swaps in place (same 1em footprint) to a
              spinner while a run is validating OR the engine is still
              initializing, so the drop area reads as busy without reflowing. */}
          <p className="ant-upload-drag-icon" style={{ margin: 0 }}>
            {validating || initializing ? (
              <LoadingOutlined />
            ) : (
              <UploadOutlined />
            )}
          </p>
          {/* Persistent status slot — ALWAYS rendered here inside the drop area,
              directly below the icon. It cycles through three states in place:
              "Loading…" while the engine is warming up (page-load pre-warm /
              post-crash re-warm), the Cancel control while a run is in flight,
              and "Ready" otherwise (idle after init, or once a run is done /
              errored / cancelled). Initializing takes priority over a queued
              run, matching the truthful "still warming up" state.

              Every state renders as one line of the same height, so the
              Loading↔Cancel↔Ready swap causes zero reflow; the Cancel link
              button is stripped of its control height/padding so it collapses
              to the same line box as the plain-text states rather than growing
              the slot. The status text and the Cancel link are painted with the
              exact same primary-blue token antd gives .ant-upload-drag-icon
              (token.colorPrimary), so text/link and icon share one blue that
              can never drift. Cancel stops event propagation so its click only
              cancels the run and never bubbles up to open the Dragger's file
              picker; the "Loading…"/"Ready" text is deliberately left to
              bubble, so tapping it opens the picker like the rest of the drop
              area. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              lineHeight: token.lineHeight,
            }}
          >
            {initializing ? (
              <Text style={{ color: token.colorPrimary }}>
                {m.status_loading()}
              </Text>
            ) : validating ? (
              <Button
                type="link"
                style={{
                  color: token.colorPrimary,
                  height: "auto",
                  padding: 0,
                  border: 0,
                  fontSize: "inherit",
                  lineHeight: "inherit",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
              >
                {m.button_cancel()}
              </Button>
            ) : (
              <Text style={{ color: token.colorPrimary }}>
                {m.status_ready()}
              </Text>
            )}
          </div>
          {/* Mirror the radio-option styling: a semibold primary line with a
              light grey regular line below it, both at the shared body size
              (override antd's larger .ant-upload-text default). */}
          <p
            className="ant-upload-text"
            style={{ margin: 0, fontSize: 14, fontWeight: 600 }}
          >
            {m.dropzone_text()}
          </p>
          <p className="ant-upload-hint" style={{ margin: 0, fontSize: 14 }}>
            {m.dropzone_hint()}
          </p>
        </div>
      </Upload.Dragger>

      {/* Picker buttons — full width, no side label, two equal columns that
          stack full-width on narrow screens. The file button opens the same
          accept list as the dropzone (so standalone files still work); the
          folder button drives the webkitdirectory picker. */}
      <Row gutter={[8, 8]} style={{ marginTop: 16 }}>
        <Col xs={24} sm={12}>
          <Button
            block
            icon={<FileTextOutlined />}
            disabled={validating}
            onClick={() => fileInputRef.current?.click()}
          >
            {m.button_select_file()}
          </Button>
        </Col>
        <Col xs={24} sm={12}>
          <Button
            block
            icon={<FolderOpenOutlined />}
            disabled={validating}
            onClick={() => folderInputRef.current?.click()}
          >
            {m.button_select_folder()}
          </Button>
        </Col>
      </Row>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={handleFilePicked}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        hidden
        onChange={handleFolderPicked}
      />

      {/* URL row — validate an EPUB hosted elsewhere by its http(s) link. Sits
          quietly below the local pickers: a full-width address field joined to
          a Validate button, with a one-line CORS caveat beneath. Enter in the
          field submits, same as clicking the button. */}
      <div style={{ marginTop: 16 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPressEnter={runUrl}
            placeholder={m.url_placeholder()}
            disabled={validating}
            allowClear
            inputMode="url"
          />
          <Button
            icon={<LinkOutlined />}
            onClick={runUrl}
            disabled={validating || url.trim().length === 0}
          >
            {m.button_validate_url()}
          </Button>
        </Space.Compact>
        <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
          {m.url_cors_note()}
        </Text>
      </div>

      <AdvancedOptions
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
        validating={validating}
      />
    </Card>
  );
}
